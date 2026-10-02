// tool-hooks.test.ts — Declarative tool gating: deny blocks with a readable
// reason, notify matches, malformed configs degrade to "no hooks".
import {
  parseToolHookConfig,
  evaluateDenyRules,
  matchesNotifyRules,
  clearToolHookCache,
} from "../tool-hooks";

describe("parseToolHookConfig", () => {
  it("returns empty hooks for null/garbage config", () => {
    expect(parseToolHookConfig(null).deny).toHaveLength(0);
    expect(parseToolHookConfig("nope").deny).toHaveLength(0);
    expect(parseToolHookConfig({}).notify).toHaveLength(0);
    expect(parseToolHookConfig({ toolHooks: "x" }).deny).toHaveLength(0);
  });

  it("compiles valid rules and skips invalid ones", () => {
    const hooks = parseToolHookConfig({
      toolHooks: { deny: ["rm\\s+-rf", 42, "("], notify: ["run_command"] },
    });
    expect(hooks.deny).toHaveLength(1); // the valid regex
    expect(hooks.notify).toHaveLength(1);
    expect(hooks.errors.length).toBeGreaterThanOrEqual(2); // non-string + bad regex
  });
});

describe("evaluateDenyRules", () => {
  const hooks = parseToolHookConfig({
    toolHooks: { deny: ["rm\\s+-rf", "drop\\s+table"] },
  });

  it("blocks a matching call with the rule as reason", () => {
    const decision = evaluateDenyRules(hooks, "run_command", { command: "rm -rf /" });
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain("rm\\s+-rf");
  });

  it("blocks case-insensitively and across args", () => {
    expect(evaluateDenyRules(hooks, "run_command", { command: "RM  -RF ~" }).blocked).toBe(true);
    expect(
      evaluateDenyRules(hooks, "run_command", { command: "echo x; DROP TABLE users;" }).blocked
    ).toBe(true);
  });

  it("passes non-matching calls", () => {
    expect(evaluateDenyRules(hooks, "run_command", { command: "npm test" }).blocked).toBe(false);
    expect(evaluateDenyRules(hooks, "write_file", { path: "a.ts", content: "rm -rf in a string is still suspicious" }).blocked).toBe(true);
  });

  it("no rules → never blocks (zero overhead shape)", () => {
    const empty = parseToolHookConfig(null);
    expect(evaluateDenyRules(empty, "run_command", { command: "rm -rf /" }).blocked).toBe(false);
  });
});

describe("matchesNotifyRules", () => {
  it("matches by tool name or arg content", () => {
    const hooks = parseToolHookConfig({
      toolHooks: { deny: [], notify: ["^run_command$", "secrets"] },
    });
    expect(matchesNotifyRules(hooks, "run_command", { command: "ls" })).toBe(true);
    expect(matchesNotifyRules(hooks, "write_file", { path: ".env.secrets" })).toBe(true);
    expect(matchesNotifyRules(hooks, "read_file", { path: "README.md" })).toBe(false);
  });
});
