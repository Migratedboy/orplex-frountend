// secret-scanner.test.ts — the secret gate both lanes share (browser plugin
// hook + server executor direct path). Pins detection per family, clean-code
// passthrough, shared-regex state safety, and the hook contract the executor
// relies on (blocked flag on hits, pass-through otherwise).

import { scanContentForSecrets } from "../plugins/builtin/secret-scanner-plugin";
import { activateSecretScanner } from "../plugins/builtin/secret-scanner-plugin";
import { beforeToolCall, pluginRegistry } from "../plugins/registry";

describe("scanContentForSecrets", () => {
  it("detects each secret family", () => {
    expect(scanContentForSecrets(`api_key = "abcdefghij1234567890"`)).toEqual(["API Key"]);
    expect(scanContentForSecrets(`password = "hunter2-hunter"`)).toEqual(["Password"]);
    expect(scanContentForSecrets(`const t = "sk_live_abcdefghijklmnopqrstuvwx"`)).toEqual(["Stripe Key"]);
    // A GitHub token in a token assignment trips both the generic Token
    // pattern and the GitHub-specific one — both firing is correct.
    expect(scanContentForSecrets(`token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"`)).toEqual([
      "Token",
      "GitHub Token",
    ]);
  });

  it("passes clean code", () => {
    expect(scanContentForSecrets(`export const x = 1;\n// use env vars\n`)).toEqual([]);
    expect(scanContentForSecrets("")).toEqual([]);
  });

  it("is idempotent across calls (shared /g regexes reset lastIndex)", () => {
    const dirty = `api_key = "abcdefghij1234567890"`;
    expect(scanContentForSecrets(dirty)).toEqual(["API Key"]);
    expect(scanContentForSecrets(dirty)).toEqual(["API Key"]);
    expect(scanContentForSecrets("clean")).toEqual([]);
    expect(scanContentForSecrets(dirty)).toEqual(["API Key"]);
  });
});

describe("secret-scanner hook contract (server executor path)", () => {
  beforeAll(async () => {
    // Registration alone does NOT wire hooks: the activate closure runs
    // only via pluginRegistry.activatePlugin (same two-step as the
    // production initializer performs).
    await activateSecretScanner();
    await pluginRegistry.activatePlugin("secret-scanner");
  });

  it("blocks file writes containing secrets", async () => {
    const out = await beforeToolCall("write_file", {
      path: "config.ts",
      content: `api_key = "abcdefghij1234567890"`,
    });
    expect(out._blocked).toBe(true);
  });

  it("passes clean writes and non-file tools", async () => {
    const clean = await beforeToolCall("write_file", {
      path: "a.ts",
      content: "export const x = 1;",
    });
    expect(clean._blocked).toBe(false);
    const other = await beforeToolCall("run_command", { command: "npm test" });
    expect(other._blocked).toBe(false);
  });
});
