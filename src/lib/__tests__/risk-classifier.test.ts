import { classifyRisk, riskRank, mcpRiskHintFrom } from "../risk-classifier";

describe("classifyRisk — read-only tools", () => {
  it("auto-approves read-only tools", () => {
    for (const tool of ["read_file", "list_files", "search_code", "web_search", "todo_list", "undo_last_change"]) {
      const r = classifyRisk(tool);
      expect(r.level).toBe("low");
      expect(r.autoApprovable).toBe(true);
    }
  });
});

describe("classifyRisk — shell commands", () => {
  it("flags destructive commands as high risk", () => {
    expect(classifyRisk("run_command", { command: "sudo rm -rf /" }).level).toBe("high");
    expect(classifyRisk("run_command", { command: "dd if=/dev/zero of=/dev/sda" }).level).toBe("high");
    expect(classifyRisk("run_command", { command: "git push --force" }).level).toBe("high");
  });

  it("keeps safe dev commands at medium (user still confirms)", () => {
    const r = classifyRisk("run_command", { command: "npm run build" });
    expect(r.level).toBe("medium");
    expect(r.autoApprovable).toBe(false);
  });

  it("treats unknown commands as medium, never auto-approved", () => {
    const r = classifyRisk("run_command", { command: "./deploy.sh --prod" });
    expect(r.level).toBe("medium");
    expect(r.autoApprovable).toBe(false);
  });

  it("never auto-approves shell execution", () => {
    expect(classifyRisk("run_command", { command: "echo hi" }).autoApprovable).toBe(false);
  });
});

describe("classifyRisk — file writes", () => {
  it("auto-approves additive writes in workspace directories", () => {
    const r = classifyRisk("write_file", { path: "src/components/Button.tsx", content: "export const A = 1;" });
    expect(r.level).toBe("low");
    expect(r.autoApprovable).toBe(true);
  });

  it("blocks auto-approval for sensitive files", () => {
    expect(classifyRisk("write_file", { path: ".env.local", content: "X=1" }).level).toBe("high");
    expect(classifyRisk("write_file", { path: ".github/workflows/ci.yml", content: "x" }).level).toBe("high");
    expect(classifyRisk("edit_file", { path: "docker-compose.yml", old_text: "a", new_text: "b" }).level).toBe("high");
  });

  it("treats writes outside safe prefixes as medium", () => {
    const r = classifyRisk("write_file", { path: "root-level.txt", content: "hello" });
    expect(r.level).toBe("medium");
    expect(r.autoApprovable).toBe(false);
  });
});

describe("classifyRisk — edits", () => {
  it("flags large deletions as high risk", () => {
    const oldText = "x".repeat(3000);
    const r = classifyRisk("edit_file", { path: "src/a.ts", old_text: oldText, new_text: "small" });
    expect(r.level).toBe("high");
    expect(r.autoApprovable).toBe(false);
  });

  it("keeps normal edits at medium", () => {
    const r = classifyRisk("edit_file", { path: "src/a.ts", old_text: "old value", new_text: "new value" });
    expect(r.level).toBe("medium");
  });
});

describe("classifyRisk — fail-closed defaults", () => {
  it("routes unknown tools to medium with review required", () => {
    const r = classifyRisk("mystery_tool");
    expect(r.level).toBe("medium");
    expect(r.autoApprovable).toBe(false);
  });
});

describe("classifyRisk — MCP connector tools (C6)", () => {
  it("defaults mcp__ tools to medium — approval required, never auto-approved", () => {
    const r = classifyRisk("mcp__acme-cloud__create_issue", { title: "hi" });
    expect(r.level).toBe("medium");
    expect(r.autoApprovable).toBe(false);
    expect(r.reason).toMatch(/side effects/);
  });

  it("stays medium for read-only tools until the per-server toggle opts in", () => {
    const plain = classifyRisk("mcp__acme-cloud__list", {}, { readOnlyHint: true });
    expect(plain).toMatchObject({ level: "medium", autoApprovable: false });

    const opted = classifyRisk("mcp__acme-cloud__list", {}, { readOnlyHint: true, serverAutoApproveReadOnly: true });
    expect(opted).toMatchObject({ level: "low", autoApprovable: true });
  });

  it("toggle without a read-only annotation does not auto-approve", () => {
    const r = classifyRisk("mcp__acme-cloud__mutate", {}, { serverAutoApproveReadOnly: true });
    expect(r).toMatchObject({ level: "medium", autoApprovable: false });
  });

  it("server-declared destructive tools go elevated, even with the toggle", () => {
    const r = classifyRisk("mcp__acme-cloud__wipe", {}, { destructiveHint: true, readOnlyHint: true, serverAutoApproveReadOnly: true });
    expect(r).toMatchObject({ level: "high", autoApprovable: false });
  });
});

describe("mcpRiskHintFrom (shared C6 hint assembler)", () => {
  it("maps snapshot ToolAnnotations into the hint", () => {
    expect(mcpRiskHintFrom({ readOnlyHint: true })).toEqual({ readOnlyHint: true });
    expect(mcpRiskHintFrom({ destructiveHint: true })).toEqual({ destructiveHint: true });
    expect(mcpRiskHintFrom({ readOnlyHint: true, destructiveHint: false })).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it("adds the per-server auto-approve toggle", () => {
    expect(mcpRiskHintFrom({ readOnlyHint: true }, true)).toEqual({
      readOnlyHint: true,
      serverAutoApproveReadOnly: true,
    });
    expect(mcpRiskHintFrom(undefined, true)).toEqual({ serverAutoApproveReadOnly: true });
  });

  it("returns an empty hint for missing annotations and toggle off", () => {
    expect(mcpRiskHintFrom(undefined)).toEqual({});
    expect(mcpRiskHintFrom(null)).toEqual({});
    expect(mcpRiskHintFrom({ readOnlyHint: true }, false)).toEqual({ readOnlyHint: true });
  });

  it("feeds classifyRisk end-to-end (annotation + toggle auto-approves)", () => {
    const r = classifyRisk("mcp__acme__list", {}, mcpRiskHintFrom({ readOnlyHint: true }, true));
    expect(r).toMatchObject({ level: "low", autoApprovable: true });
  });
});

describe("riskRank", () => {
  it("orders high > medium > low", () => {
    expect(riskRank("high")).toBeGreaterThan(riskRank("medium"));
    expect(riskRank("medium")).toBeGreaterThan(riskRank("low"));
  });
});
