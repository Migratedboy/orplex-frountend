// Sync transport tests — wire format, auth, cursor, merge semantics.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  encodeEnvelope,
  decodeEnvelope,
  signPayload,
  verifySignature,
  readSyncCursor,
  writeSyncCursor,
  pushToHub,
  pullFromHub,
  syncPullAndMerge,
  type SyncEnvelope,
} from "../sync-transport";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orplex-sync-"));
}

const ENV: SyncEnvelope = {
  version: 1,
  machineId: "peer-a",
  cursor: "entry-10",
  entries: [
    { id: "entry-9", at: "2026-09-26T10:00:00Z", file: "src/a.ts" },
    { id: "entry-10", at: "2026-09-26T10:05:00Z", file: "src/b.ts" },
  ],
};

describe("sync transport", () => {
  test("envelope survives gzip roundtrip byte-for-byte", () => {
    const decoded = decodeEnvelope(encodeEnvelope(ENV));
    expect(decoded).toEqual(ENV);
  });

  test("decodeEnvelope rejects wrong wire version", () => {
    const raw = encodeEnvelope({ ...ENV, version: 99 as unknown as 1 });
    expect(() => decodeEnvelope(raw)).toThrow(/wire version/);
  });

  test("signatures verify and detect tampering", () => {
    const sig = signPayload("payload", "secret");
    expect(verifySignature("payload", sig, "secret")).toBe(true);
    expect(verifySignature("tampered", sig, "secret")).toBe(false);
    expect(verifySignature("payload", sig, "wrong-secret")).toBe(false);
    expect(verifySignature("payload", "", "secret")).toBe(false);
  });

  test("cursor persists and clears", async () => {
    const dir = tmpDir();
    expect(await readSyncCursor(dir)).toBe("");
    await writeSyncCursor(dir, "entry-42");
    expect(await readSyncCursor(dir)).toBe("entry-42");
  });

  test("pushToHub signs the body and reports acceptance", async () => {
    const dir = tmpDir();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ accepted: 2 }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await pushToHub(
      { hubUrl: "http://hub.test", secret: "s3cret", machineId: "peer-a", fetchImpl },
      dir,
      ENV.entries
    );
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(2);
    expect(calls[0].url).toBe("http://hub.test/api/sync/push");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["X-Orplex-Sync-Signature"]).toBeTruthy();
  });

  test("pushToHub reports hub rejection honestly", async () => {
    const dir = tmpDir();
    const fetchImpl = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    const r = await pushToHub(
      { hubUrl: "http://hub.test", secret: "s3cret", machineId: "peer-a", fetchImpl },
      dir,
      ENV.entries
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/403/);
  });

  test("pullFromHub decodes the envelope and syncPullAndMerge dedupes by id", async () => {
    const dir = tmpDir();
    const local = [{ id: "entry-9", at: "2026-09-26T10:00:00Z", file: "src/a.ts" }];
    fs.writeFileSync(path.join(dir, "history.jsonl"), local.map((e) => JSON.stringify(e)).join("\n") + "\n");

    // Hub has entry-9 (already local) and entry-11 (fresh)
    const hubEnv: SyncEnvelope = {
      version: 1,
      machineId: "peer-b",
      cursor: "entry-11",
      entries: [...local, { id: "entry-11", at: "2026-09-26T11:00:00Z", file: "src/c.ts" }],
    };
    const fetchImpl = (async () => new Response(new Uint8Array(encodeEnvelope(hubEnv)), { status: 200 })) as unknown as typeof fetch;

    const r = await syncPullAndMerge(
      { hubUrl: "http://hub.test", secret: "s3cret", machineId: "peer-a", fetchImpl },
      dir,
      local
    );
    expect(r.ok).toBe(true);
    expect(r.merged).toBe(1);

    const merged = fs.readFileSync(path.join(dir, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(merged).toHaveLength(2);
    expect(merged.map((e: { id: string }) => e.id)).toEqual(["entry-9", "entry-11"]);
    expect(await readSyncCursor(dir)).toBe("entry-11");
  });

  test("pullFromHub surfaces hub errors without corrupting local state", async () => {
    const dir = tmpDir();
    await writeSyncCursor(dir, "entry-5");
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await pullFromHub(
      { hubUrl: "http://hub.test", secret: "s3cret", machineId: "peer-a", fetchImpl },
      dir
    );
    expect(r.ok).toBe(false);
    expect(await readSyncCursor(dir)).toBe("entry-5"); // untouched
  });
});
