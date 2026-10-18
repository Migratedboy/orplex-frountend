/**
 * path-jail.test.ts — the shared realpath containment + write denylist.
 *
 * Containment is the same lstat+realpath logic extractZip used for archives
 * only; these tests pin it for NORMAL writes (symlink escapes, ../ traversal,
 * absolute paths outside the root) and the denylist the audit found missing
 * (.git hooks, .env, keys) for the write_file lane.
 */
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WRITE_DENY_PATTERNS,
  assertSafeWrite,
  containPath,
  isWriteDenied,
} from "../reliability/path-jail";
import {
  reliabilityGatesEnabled,
  reliabilityPathJailEnabled,
} from "../reliability/flags";

describe("WRITE_DENY_PATTERNS", () => {
  it("covers every control directory and secret shape the plan names", () => {
    expect(WRITE_DENY_PATTERNS).toEqual(
      expect.arrayContaining([
        ".git/",
        ".hg/",
        ".svn/",
        ".orplex/",
        ".env",
        ".env.*",
        "id_rsa",
        "id_ed25519",
        "*.pem",
        "credentials.json",
        ".aws/",
        ".ssh/",
      ]),
    );
  });
});

describe("isWriteDenied", () => {
  const deniedCases: Array<[string, string]> = [
    [".git/hooks/post-checkout", ".git/"],
    [".hg/store/data", ".hg/"],
    [".svn/wc.db", ".svn/"],
    [".orplex/attachments/x.zip", ".orplex/"],
    [".env", ".env"],
    ["backend/.env", ".env"],
    [".env.local", ".env.*"],
    [".ssh/id_rsa", ".ssh/"],
    ["keys/id_ed25519", "id_ed25519"],
    ["certs/server.pem", "*.pem"],
    ["credentials.json", "credentials.json"],
    [".aws/credentials", ".aws/"],
    [".ssh/authorized_keys", ".ssh/"],
  ];

  it.each(deniedCases)("denies %s", (path, fragment) => {
    const r = isWriteDenied(path);
    expect(r.denied).toBe(true);
    expect(r.reason).toContain(fragment);
  });

  it("is case- and separator-insensitive", () => {
    expect(isWriteDenied(".GIT\\config").denied).toBe(true);
    expect(isWriteDenied("src\\.env").denied).toBe(true);
    expect(isWriteDenied("C:/proj/.SSH/authorized_keys").denied).toBe(true);
  });

  it("allows ordinary source files", () => {
    for (const p of ["src/app.ts", "README.md", "package.json", ".environment", "environment.ts", "src/id_rsa.md"]) {
      expect(isWriteDenied(p).denied).toBe(false);
    }
  });
});

describe("containPath + assertSafeWrite (against a real temp workspace)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "orplex-jail-"));
    await mkdir(join(root, "src"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a relative path inside the root", async () => {
    const r = await containPath(root, "src/app.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe(join(root, "src", "app.ts"));
  });

  it("accepts a not-yet-existing nested path (writes create their dirs)", async () => {
    const r = await containPath(root, "src/deeply/nested/new.ts");
    expect(r.ok).toBe(true);
  });

  it("rejects ../ traversal", async () => {
    const r = await containPath(root, "../escaped.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("escapes");
  });

  it("rejects an absolute path outside the root", async () => {
    const r = await containPath(root, join(tmpdir(), "orplex-outside.txt"));
    expect(r.ok).toBe(false);
  });

  it("containPath ALONE allows .git (it IS inside the root) — the denylist is separate", async () => {
    const r = await containPath(root, ".git/hooks/post-checkout");
    expect(r.ok).toBe(true);
  });

  it("assertSafeWrite refuses the same .git path, and names why", async () => {
    const r = await assertSafeWrite(root, ".git/hooks/post-checkout");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(".git/");
  });

  it("assertSafeWrite refuses secrets and allows normal writes", async () => {
    expect((await assertSafeWrite(root, ".env")).ok).toBe(false);
    expect((await assertSafeWrite(root, ".env.local")).ok).toBe(false);
    expect((await assertSafeWrite(root, ".ssh/id_rsa")).ok).toBe(false);
    expect((await assertSafeWrite(root, "certs/server.pem")).ok).toBe(false);

    const ok = await assertSafeWrite(root, "src/new-file.ts");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.abs).toContain("new-file.ts");
  });

  it("containment failure wins over denylist (no reason leak for escaping paths)", async () => {
    const r = await assertSafeWrite(root, "../../.ssh/id_rsa");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("escapes");
  });

  it("rejects a target reached through a symlink/junction pointing outside the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "orplex-jail-out-"));
    const link = join(root, "escape-link");
    try {
      await symlink(outside, link, "junction");
    } catch {
      // This OS/user cannot create links (Windows without Developer Mode).
      // The lexical escapes above still pin the text-level jail; clean up and
      // report nothing — nothing was weakened, the capability is absent.
      await rm(outside, { recursive: true, force: true });
      return;
    }

    const escaped = await containPath(root, "escape-link/evil.txt");
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.reason).toContain("symlink");

    const viaAssert = await assertSafeWrite(root, "escape-link/evil.txt");
    expect(viaAssert.ok).toBe(false);

    await rm(outside, { recursive: true, force: true });
    await rm(link, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Flag — default OFF, master switch required (flags.ts pattern)
// ---------------------------------------------------------------------------

describe("RELIABILITY_PATH_JAIL flag", () => {
  const ENV = process.env;
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ENV };
    delete process.env.RELIABILITY_GATES;
    delete process.env.RELIABILITY_PATH_JAIL;
  });
  afterAll(() => {
    process.env = ENV;
  });

  it("is OFF when nothing is set", () => {
    expect(reliabilityPathJailEnabled()).toBe(false);
  });

  it("stays OFF when only RELIABILITY_PATH_JAIL is set — the master switch arms everything", () => {
    process.env.RELIABILITY_PATH_JAIL = "1";
    expect(reliabilityGatesEnabled()).toBe(false);
    expect(reliabilityPathJailEnabled()).toBe(false);
  });

  it("turns ON only when both switches are on", () => {
    process.env.RELIABILITY_GATES = "1";
    expect(reliabilityPathJailEnabled()).toBe(false);
    process.env.RELIABILITY_PATH_JAIL = "1";
    expect(reliabilityPathJailEnabled()).toBe(true);
  });
});
