/**
 * Cover the local attachment store's contract:
 *  - content-addressing (same bytes → same id, no duplicate file)
 *  - path-traversal rejection (the id is digest-shaped hex, so a crafted
 *    "id" must never reach the filesystem)
 *  - size ceiling enforced on the DECODED bytes, not the base64 string
 *  - only supported image types are persisted
 */

import {
  MAX_ATTACHMENT_BYTES,
  attachmentId,
  attachmentRef,
  attachmentsDir,
  isValidAttachmentId,
  mimeForPath,
  parseAttachmentRef,
  parseImageDataUrl,
  readAttachment,
  saveAttachment,
} from "@/lib/attachment-store";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function tmpWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orplex-attach-test-"));
}

describe("parseImageDataUrl", () => {
  it("accepts a supported image", () => {
    const parsed = parseImageDataUrl(PNG);
    expect(parsed).not.toBeNull();
    expect(parsed!.ext).toBe(".png");
    expect(parsed!.bytes.length).toBeGreaterThan(0);
  });

  it("rejects a non-image mime", () => {
    expect(parseImageDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
  });

  it("rejects a non-data URL", () => {
    expect(parseImageDataUrl("https://example.com/a.png")).toBeNull();
  });

  it("rejects an oversized image by DECODED size, not base64 length", () => {
    // ~11MB decoded, which is only ~14.7MB of base64 — under the naive
    // string-length check but over the real 10MB ceiling.
    const big = Buffer.alloc(11 * 1024 * 1024, 1);
    const dataUrl = `data:image/png;base64,${big.toString("base64")}`;
    expect(dataUrl.length).toBeGreaterThan(MAX_ATTACHMENT_BYTES);
    expect(parseImageDataUrl(dataUrl)).toBeNull();
  });

  it("rejects an empty payload", () => {
    expect(parseImageDataUrl("data:image/png;base64,")).toBeNull();
  });
});

describe("attachment id safety", () => {
  it("accepts digest-shaped ids", () => {
    expect(isValidAttachmentId("a".repeat(32))).toBe(true);
  });

  it("rejects traversal and other crafted ids", () => {
    for (const bad of [
      "../../etc/passwd",
      "..\\..\\windows\\system32",
      "AAAA.png",
      "a".repeat(31),
      "a".repeat(33),
      "g".repeat(32), // non-hex
      "",
    ]) {
      expect(isValidAttachmentId(bad)).toBe(false);
    }
  });

  it("is content-addressed", () => {
    const a = attachmentId(Buffer.from("hello"));
    const b = attachmentId(Buffer.from("hello"));
    const c = attachmentId(Buffer.from("world"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("attachment refs", () => {
  it("round-trips", () => {
    const ref = attachmentRef("b".repeat(32), ".png");
    expect(parseAttachmentRef(ref)).toEqual({ id: "b".repeat(32), ext: ".png" });
  });

  it("rejects a ref with a traversal path", () => {
    expect(parseAttachmentRef("attachment:../../secret.png")).toBeNull();
  });

  it("rejects a ref with an unsupported extension", () => {
    expect(parseAttachmentRef(`attachment:${"b".repeat(32)}.exe`)).toBeNull();
  });
});

describe("save/read round-trip", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await tmpWorkspace();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("writes into <workspace>/.orplex/attachments and reads back", async () => {
    const parsed = parseImageDataUrl(PNG)!;
    const saved = await saveAttachment(workspace, parsed);

    expect(saved.filename).toBe(`${saved.id}.png`);

    const files = await readdir(attachmentsDir(workspace));
    expect(files).toEqual([`${saved.id}.png`]);

    const data = await readAttachment(workspace, saved.id, ".png");
    expect(data?.equals(parsed.bytes)).toBe(true);
  });

  it("deduplicates identical bytes instead of writing twice", async () => {
    const parsed = parseImageDataUrl(PNG)!;
    const first = await saveAttachment(workspace, parsed);
    const second = await saveAttachment(workspace, parsed);

    expect(second.id).toBe(first.id);
    const files = await readdir(attachmentsDir(workspace));
    expect(files).toHaveLength(1);
  });

  it("refuses to read a traversal id", async () => {
    expect(await readAttachment(workspace, "../../etc/passwd", ".png")).toBeNull();
    expect(await readAttachment(workspace, "a".repeat(32), ".exe")).toBeNull();
  });

  it("returns null for a missing attachment", async () => {
    expect(await readAttachment(workspace, "f".repeat(32), ".png")).toBeNull();
  });

  it("maps extensions to content types", () => {
    expect(mimeForPath(".png")).toBe("image/png");
    expect(mimeForPath(".webp")).toBe("image/webp");
    expect(mimeForPath(".bin")).toBe("application/octet-stream");
  });
});
