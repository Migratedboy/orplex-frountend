import { classifyRisk, riskRank } from "../risk-classifier";

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

describe("riskRank", () => {
  it("orders high > medium > low", () => {
    expect(riskRank("high")).toBeGreaterThan(riskRank("medium"));
    expect(riskRank("medium")).toBeGreaterThan(riskRank("low"));
  });
});
