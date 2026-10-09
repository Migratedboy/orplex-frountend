/**
 * master-prompt.test.ts — Invariants that keep the Master Prompt honest.
 * A system prompt rots silently: tool counts drift, sections contradict,
 * profiles diverge. These tests pin the properties that must never break.
 */
import { buildSystemPrompt, buildToolRoster, SPARC_PLAN_DIRECTIVE, FORCE_TOOLS_DIRECTIVE, FORCE_BROWSER_TOOLS_DIRECTIVE, truncationContinue, qualityReviewDirective, verificationRepairDirective, browserRepairDirective } from "../master-prompt";
import { M3_TOOL_DEFINITIONS } from "../tool-definitions";

describe("buildToolRoster", () => {
  it("names every tool in the real schema — counts can never drift again", () => {
    const roster = buildToolRoster();
    for (const def of M3_TOOL_DEFINITIONS) {
      expect(roster).toContain(def.function.name);
    }
  });

  it("contains no hardcoded count other than the live array length", () => {
    expect(buildToolRoster()).toContain(`${M3_TOOL_DEFINITIONS.length} tools`);
  });
});

describe("buildSystemPrompt — code mode (full)", () => {
  it("contains all ten sections in priority order", async () => {
    const prompt = await buildSystemPrompt({ mode: "code" });
    const sections = [
      "You are Orplex Code",
      "## PRIME DIRECTIVES",
      "## OUTPUT CONTRACT",
      "## TOOL DOCTRINE",
      "## WORKFLOW",
      "## QUALITY BARS",
      "## ENVIRONMENT",
      "## FAILURE DOCTRINE",
      "## SAFETY",
      "## FORMATTING",
    ];
    let last = -1;
    for (const s of sections) {
      const idx = prompt.indexOf(s);
      expect(idx).toBeGreaterThan(last); // present AND ordered
      last = idx;
    }
  });

  it("teaches the verify-until-PASS loop and the own-browser suite", async () => {
    const prompt = await buildSystemPrompt({ mode: "code" });
    expect(prompt).toContain("verify_app");
    expect(prompt).toContain("browser_read");
    expect(prompt).toContain("browser_console");
  });

  it("has NO contradiction: formatting section never instructs code fences for building", async () => {
    const prompt = await buildSystemPrompt({ mode: "code" });
    const formatting = prompt.slice(prompt.indexOf("## FORMATTING"));
    // The only fence mention must carry the restriction, not an instruction to use them.
    expect(formatting).toMatch(/ONLY when the user explicitly asked/);
  });

  it("does not claim a stale tool count anywhere", async () => {
    const prompt = await buildSystemPrompt({ mode: "code" });
    // The old prompt said "14 tools" — any number that isn't the live length is a bug.
    expect(prompt).not.toMatch(/\b(13|14|15) tools\b/);
    expect(prompt).toContain(`${M3_TOOL_DEFINITIONS.length} tools`);
  });

  it("does not contradict autonomy with approval demands", async () => {
    const prompt = await buildSystemPrompt({ mode: "code" });
    // The old SAFETY block demanded approval before every write — fighting the product.
    expect(prompt).not.toContain("ALWAYS ask for approval before running commands or writing files");
  });
});

describe("buildSystemPrompt — plan mode overlay", () => {
  it("produces a planning prompt, not an implementation prompt", async () => {
    const prompt = await buildSystemPrompt({ mode: "plan" });
    expect(prompt).toContain("## PLAN MODE");
    expect(prompt).toContain("Do not write implementation files");
  });
});

describe("buildSystemPrompt — ask mode", () => {
  it("is lean, toolless, and forbids file creation", async () => {
    const prompt = await buildSystemPrompt({ mode: "ask" });
    expect(prompt).toContain("no tools, no file writes");
    expect(prompt).toContain("CODE mode");
    expect(prompt).not.toContain("## TOOL DOCTRINE");
  });
});

describe("buildSystemPrompt — compact profile", () => {
  it("is meaningfully smaller (< 40% of full)", async () => {
    const full = await buildSystemPrompt({ mode: "code" });
    const compact = await buildSystemPrompt({ mode: "code", profile: "compact" });
    expect(compact.length).toBeLessThan(full.length * 0.4);
  });

  it("preserves the five essentials that keep behavior stable", async () => {
    const compact = await buildSystemPrompt({ mode: "code", profile: "compact" });
    expect(compact).toContain("write_file");
    expect(compact).toContain("todo_list");
    expect(compact).toContain("VERIFY");
    expect(compact).toContain("thinking channel");
    expect(compact).toContain("failing call");
  });

  it("works for every mode and effort without throwing", async () => {
    for (const mode of ["ask", "code", "plan"] as const) {
      for (const effort of ["low", "medium", "high"] as const) {
        for (const profile of ["full", "compact"] as const) {
          await expect(buildSystemPrompt({ mode, effort, profile })).resolves.toBeDefined();
        }
      }
    }
  });

  it("applies the effort style block when effort is low or high", async () => {
    expect(await buildSystemPrompt({ mode: "code", effort: "low" })).toContain("CONCISE");
    expect(await buildSystemPrompt({ mode: "code", effort: "high" })).toContain("THOROUGH");
    expect(await buildSystemPrompt({ mode: "code", effort: "medium" })).not.toContain("CONCISE");
  });
});

describe("runtime directives moved from the worker", () => {
  it("covers the plan-first gate, force-tools, truncation, and repair prompts", async () => {
    expect(SPARC_PLAN_DIRECTIVE).toContain("todo_list");
    expect(SPARC_PLAN_DIRECTIVE).toContain("gate WILL block");
    expect(FORCE_TOOLS_DIRECTIVE).toContain("write_file NOW");
    expect(FORCE_BROWSER_TOOLS_DIRECTIVE).toContain("browser_navigate NOW");
    expect(FORCE_BROWSER_TOOLS_DIRECTIVE).toContain("Do NOT write Selenium");
    expect(await buildSystemPrompt({ mode: "code" })).toContain("auto-attached");
    expect(await buildSystemPrompt({ mode: "code" })).toContain("<tool_call>");
    expect(await buildSystemPrompt({ mode: "code" })).toContain("## SCRATCHPAD");
    expect(await buildSystemPrompt({ mode: "plan" })).toContain("## SCRATCHPAD");
    expect(await buildSystemPrompt({ mode: "ask" })).not.toContain("## SCRATCHPAD");
    expect(truncationContinue("src/app.tsx")).toContain("src/app.tsx");
    expect(truncationContinue(undefined)).not.toContain("undefined");
    expect(qualityReviewDirective("- line 3: any")).toContain("- line 3: any");
    expect(verificationRepairDirective("TS2322", ["a.ts"])).toContain("TS2322");
    expect(verificationRepairDirective("TS2322", [])).toContain("(workspace files)");
    expect(browserRepairDirective("console error: boom")).toContain("boom");
  });
});
