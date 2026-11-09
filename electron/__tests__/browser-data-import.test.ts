// browser-data-import.test.ts — cookie parsers, decrypt rounds, profile sanitizing.
import { createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseNetscapeCookies,
  parseCookieEditorJson,
  decryptChromiumValue,
  enumerateExtensions,
  sqliteAvailable,
} from "../browser-data-import";
import { sanitizeProfileId, partitionForProfile } from "../preview-extras";

describe("parseNetscapeCookies", () => {
  it("parses rows incl. #HttpOnly_ prefix + expiry", () => {
    const text = [
      "# Netscape HTTP Cookie File",
      "#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1893456000\tsession\tabc123",
      "example.org\tFALSE\t/\tFALSE\t0\tprefs\tdark",
      "",
    ].join("\n");
    const rows = parseNetscapeCookies(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "session", value: "abc123", domain: ".example.com", httpOnly: true, secure: true });
    expect(rows[0].expires?.getTime()).toBe(1893456000 * 1000);
    expect(rows[1].expires).toBeUndefined();
  });

  it("skips junk lines and short lines", () => {
    expect(parseNetscapeCookies("#comment\nfoo\tbar\n")).toEqual([]);
  });
});

describe("parseCookieEditorJson", () => {
  it("parses editor exports with host/dates/sameSite guards", () => {
    const text = JSON.stringify([
      { name: "a", value: "1", domain: "example.com", path: "/", secure: true, httpOnly: false, expirationDate: 1893456000 },
      { name: "b", value: "2", domain: "example.org" },
      { name: "bad" },
    ]);
    const rows = parseCookieEditorJson(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "a", domain: "example.com", secure: true });
    expect(rows[0].expires?.getTime()).toBe(1893456000 * 1000);
  });

  it("returns [] on invalid JSON", () => {
    expect(parseCookieEditorJson("{nope")).toEqual([]);
  });
});

describe("decryptChromiumValue", () => {
  it("round-trips AES-256-GCM v10 values", () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const enc = Buffer.concat([cipher.update("s3cret-token", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([nonce, enc, tag]);
    expect(decryptChromiumValue("v10", blob, key)).toBe("s3cret-token");
  });

  it("never attempts v20 (App-Bound Encryption) and fails closed on junk", () => {
    const key = randomBytes(32);
    expect(decryptChromiumValue("v20", randomBytes(40), key)).toBeNull();
    expect(decryptChromiumValue("v10", randomBytes(40), key)).toBeNull(); // bad tag → null, no throw
    expect(decryptChromiumValue("v99", randomBytes(40), key)).toBeNull();
  });
});

describe("sqliteAvailable + enumerateExtensions (env-dependent, honest)", () => {
  it("reports the engine honestly; extension enumeration tolerates missing dirs", () => {
    expect(typeof sqliteAvailable()).toBe("boolean");
    expect(enumerateExtensions("/definitely/not/here")).toEqual([]);
    // A fixture extension with __MSG__ resolution.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-"));
    try {
      const dir = path.join(tmp, "Extensions", "abc", "1.0.0");
      fs.mkdirSync(path.join(dir, "_locales", "en"), { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "__MSG_extName__", version: "1.0.0" }));
      fs.writeFileSync(path.join(dir, "_locales", "en", "messages.json"), JSON.stringify({ extName: { message: "Ad Block <beta>" } }));
      const out = enumerateExtensions(tmp);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ id: "abc", name: "Ad Block", version: "1.0.0" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("sanitizeProfileId + partitionForProfile", () => {
  it("sanitizes + constrains ids", () => {
    expect(sanitizeProfileId("My Work!")).toBe("my-work");
    expect(sanitizeProfileId("default")).toBe("default");
    expect(sanitizeProfileId("")).toBeNull();
    expect(sanitizeProfileId("x".repeat(50))).toBeNull();
  });

  it("maps partitions (default reuses the legacy partition)", () => {
    expect(partitionForProfile("default")).toBe("persist:orplex-preview");
    expect(partitionForProfile("work")).toBe("persist:orplex-preview-work");
  });
});
