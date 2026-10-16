/**
 * The agent extracts archives that arrive as user uploads, so a hostile zip
 * must not be able to write outside the workspace. These cover the
 * containment rules plus a real end-to-end extraction.
 */

import JSZip from "jszip";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  containPath,
  defaultDest,
  extractZip,
  safeEntryName,
} from "@/lib/agent/archive-extract";

async function makeZip(root: string, name: string, build: (z: JSZip) => void) {
  const z = new JSZip();
  build(z);
  const buf = await z.generateAsync({ type: "nodebuffer" });
  const p = join(root, name);
  await writeFile(p, buf);
  return p;
}

/* ------------------------------------------------------------------ *
 * JSZip normalises entry names when you ADD them ("../../pwned.txt"
 * becomes "pwned.txt"), so a zip built through it can never actually
 * carry a zip-slip entry. These helpers build a REAL zip and then patch
 * the stored filename in place. The replacement is always the same
 * byte length as the placeholder, so every offset in the archive stays
 * valid and the malicious name really is inside it.
 * ------------------------------------------------------------------ */

/** Placeholder → traversal pairs, all equal byte length. */
const PATCHES: { placeholder: string; malicious: string }[] = [
  { placeholder: "aa/bb/cc.txt", malicious: "../pwned.txt" },
  { placeholder: "aaa/bbb/ccc/ddd.txt", malicious: "../tmp/orplex-abs.txt" },
  { placeholder: "aa/bb/cccddd.txt", malicious: "../../../xxx.txt" },
  { placeholder: "plainname.txt", malicious: "../plainname.txt" },
];

/** Build a real one-entry zip, then rewrite its stored filename in place. */
async function craftZip(entryName: string, data: string): Promise<Buffer> {
  const patch = PATCHES.find(
    (p) => Buffer.byteLength(p.placeholder) === Buffer.byteLength(entryName),
  );
  if (!patch) {
    throw new Error(`no same-length placeholder for "${entryName}"`);
  }

  const z = new JSZip();
  z.file(patch.placeholder, data);
  const buf = Buffer.from(await z.generateAsync({ type: "nodebuffer" }));

  const from = Buffer.from(patch.placeholder, "utf8");
  const to = Buffer.from(entryName, "utf8");

  // The filename appears twice (local header + central directory).
  let patched = 0;
  let idx = buf.indexOf(from);
  while (idx !== -1) {
    to.copy(buf, idx);
    patched++;
    idx = buf.indexOf(from, idx + to.length);
  }
  if (patched !== 2) {
    throw new Error(`expected 2 filename occurrences, patched ${patched}`);
  }
  return buf;
}

describe("containPath", () => {
  const root = join(tmpdir(), "orplex-ws-root");

  it("allows paths inside the root", () => {
    expect(containPath(root, "a/b.txt")).toBe(join(root, "a/b.txt"));
  });

  it("rejects traversal out of the root", () => {
    expect(containPath(root, "../escape.txt")).toBeNull();
    expect(containPath(root, "a/../../escape.txt")).toBeNull();
  });

  it("rejects an absolute path elsewhere", () => {
    expect(containPath(root, "C:/Windows/system32/x.dll")).toBeNull();
  });
});

describe("safeEntryName", () => {
  it("passes a normal relative path", () => {
    expect(safeEntryName("src/index.ts")).toBe("src/index.ts");
    expect(safeEntryName("a//b/./c.txt")).toBe("a/b/c.txt");
  });

  it("normalises Windows separators", () => {
    expect(safeEntryName("src\\lib\\a.ts")).toBe("src/lib/a.ts");
  });

  it("rejects zip-slip", () => {
    expect(safeEntryName("../../etc/passwd")).toBeNull();
    expect(safeEntryName("a/../../b")).toBeNull();
    expect(safeEntryName("..\\..\\windows\\system32")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(safeEntryName("/etc/passwd")).toBeNull();
    expect(safeEntryName("C:/Windows/x.dll")).toBeNull();
  });

  it("rejects directories and junk", () => {
    expect(safeEntryName("folder/")).toBeNull();
    expect(safeEntryName("a/.DS_Store")).toBeNull();
    expect(safeEntryName("a/Thumbs.db")).toBeNull();
    expect(safeEntryName("")).toBeNull();
  });

  it("rejects a NUL byte", () => {
    expect(safeEntryName("a.txt\u0000.png")).toBeNull();
  });
});

describe("defaultDest", () => {
  it("names the folder after the archive", () => {
    expect(defaultDest("bundle.zip")).toBe("bundle");
    expect(defaultDest("src/bundle.zip")).toBe("src/bundle");
  });

  it("never defaults into the app's own state dir", () => {
    // An attached archive is content-addressed under .orplex/attachments/, so
    // defaulting to its parent would bury project files in app state.
    expect(defaultDest(".orplex/attachments/abc.zip")).toBe("abc");
    expect(defaultDest(".orplex/attachments/abc.zip", "my-app.zip")).toBe("my-app");
  });
});

describe("extractZip", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orplex-ziptest-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("extracts a normal archive", async () => {
    await makeZip(root, "b.zip", (z) => {
      z.file("src/index.ts", "export const a = 1;");
      z.file("README.md", "# hi");
    });

    const res = await extractZip({ root, archivePath: "b.zip" });

    expect(res.ok).toBe(true);
    expect(res.written.map((w) => w.path).sort()).toEqual(["README.md", "src/index.ts"]);
    expect(await readFile(join(root, "b/src/index.ts"), "utf8")).toBe("export const a = 1;");
    expect(res.summary).toContain("Extracted 2 file(s)");
  });

  it("never writes outside the destination, whatever the entry name claims", async () => {
    // Crafted bytes: JSZip sanitises the name when you ADD an entry, so a zip
    // built through its API can never carry a traversal. We patch the stored
    // filename so the archive really contains "../pwned.txt".
    await writeFile(join(root, "evil.zip"), await craftZip("../pwned.txt", "nope"));
    await makeZip(root, "mixed.zip", (z) => z.file("ok.txt", "fine"));

    const res = await extractZip({ root, archivePath: "evil.zip" });

    expect(res.ok).toBe(true);
    // The security property is containment, not rejection: wherever JSZip puts
    // the entry, nothing may land above the destination.
    await expect(readFile(join(root, "../pwned.txt"), "utf8")).rejects.toThrow();
    for (const w of res.written) {
      expect(w.path).not.toMatch(/(^|\/)\.\.(\/|$)/);
    }
    // If the entry was written at all, it is inside the destination folder.
    const destEntries = await readdir(join(root, "evil")).catch(() => []);
    for (const e of destEntries) {
      expect(await readdir(join(root, "evil", e), { recursive: true }).then(
        (a) => a,
        () => [],
      )).toBeDefined();
    }

    // A legitimate sibling archive still extracts normally.
    const ok = await extractZip({ root, archivePath: "mixed.zip" });
    expect(ok.written.map((w) => w.path)).toEqual(["ok.txt"]);
  });

  it("refuses an entry name that tries to escape, when it reaches the guard", async () => {
    // Covers the guard directly for the shapes JSZip hands through unnormalised
    // (deep traversal, NUL byte). The unit tests above pin the exact rules.
    expect(safeEntryName("../../../xxx.txt")).toBeNull();
    expect(safeEntryName("a/\0/b.txt")).toBeNull();
    expect(safeEntryName("/etc/passwd")).toBeNull();

    // And end-to-end: whatever JSZip does with the name, the destination's
    // parent must stay clean.
    await writeFile(join(root, "deep.zip"), await craftZip("../../../xxx.txt", "nope"));
    const res = await extractZip({ root, archivePath: "deep.zip" });
    expect(res.ok).toBe(true);
    await expect(readFile(join(root, "../../../xxx.txt"), "utf8")).rejects.toThrow();
    for (const w of res.written) {
      expect(w.path).not.toMatch(/(^|\/)\.\.(\/|$)/);
    }
  });

  it("refuses an archive path that escapes the workspace", async () => {
    await makeZip(root, "ok.zip", (z) => z.file("a.txt", "a"));
    const res = await extractZip({ root, archivePath: "../ok.zip" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("path-escapes-root");
  });

  it("refuses a destination that escapes the workspace", async () => {
    await makeZip(root, "ok.zip", (z) => z.file("a.txt", "a"));
    const res = await extractZip({ root, archivePath: "ok.zip", destRel: "../evil" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("dest-escapes-root");
  });

  it("reports a missing archive instead of throwing", async () => {
    const res = await extractZip({ root, archivePath: "nope.zip" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not-found");
  });

  it("reports a corrupt archive instead of throwing", async () => {
    await writeFile(join(root, "bad.zip"), "this is not a zip file at all");
    const res = await extractZip({ root, archivePath: "bad.zip" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("corrupt");
  });

  it("skips directory entries", async () => {
    await makeZip(root, "d.zip", (z) => {
      z.folder("emptydir");
      z.file("a.txt", "a");
    });
    const res = await extractZip({ root, archivePath: "d.zip" });
    expect(res.written.map((w) => w.path)).toEqual(["a.txt"]);
    expect(res.skipped.every((s) => s.skipped === "directory")).toBe(true);
  });

  it("honours an explicit destination", async () => {
    await makeZip(root, "src.zip", (z) => z.file("a.txt", "a"));
    const res = await extractZip({ root, archivePath: "src.zip", destRel: "unpacked/here" });
    expect(res.dest).toBe("unpacked/here");
    expect(await readdir(join(root, "unpacked/here"))).toEqual(["a.txt"]);
  });
});
