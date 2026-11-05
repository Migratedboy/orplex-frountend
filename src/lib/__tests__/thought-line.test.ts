// thought-line.test.ts — the pure transcript → thread mapper.
//
// The transcript is the ONLY channel the chat has for the agent's reasoning:
// the worker appends status lines, result lines, reasoning blocks and gate /
// breaker markers to the same string the UI renders. This suite pins how each
// of those shapes becomes a ThoughtLine row, because a wrong mapping here is
// a lie shown to the user (a red row for a success, a green row for a stop).
//
// The mocked run is the one the brief asks for: one think step, two tool
// steps, a failing gate followed by a repair, a loop-breaker stop, and a
// final result.

import { parseContent } from "@/lib/message-content";
import { KIND_GLYPH } from "@/lib/tool-chain";
import { deriveThoughtSteps, outcomeFromText, truncateDetail } from "@/lib/thought-line";

const TRANSCRIPT = [
  "[THINKING]The retry helper should live in one place, not in the fetch wrapper.[/THINKING]",
  "",
  "running [grep -rn fetchWithRetry src/]",
  "[OK] Command completed: 4 call sites",
  "",
  "running [npm test]",
  "[FAIL] Command failed: 1 suite failed",
  "",
  "**Verifying changes.** typecheck round 1/2",
  "**Verification failed** - 3 error(s), repairing.",
  "",
  "**Swarm found issues - repairing.**",
  "",
  "*[Loop detected - the same test command ran twice. Forcing a strategy change.]*",
  "",
  "All retry logic now lives in src/net/retry.js and every suite passes.",
].join("\n");

const stepsOf = (content: string, live = false) =>
  deriveThoughtSteps(parseContent(content), { live });

describe("thought-line — mocked run", () => {
  const steps = stepsOf(TRANSCRIPT);

  it("maps the whole run onto the seven expected rows", () => {
    expect(steps.map((s) => s.kind)).toEqual([
      "think",
      "tool",
      "tool",
      "tool",
      "tool",
      "think",
      "result",
    ]);
    expect(steps.map((s) => s.text)).toEqual([
      "The retry helper should live in one place, not in the fetch wrapper.",
      "Run grep -rn fetchWithRetry src/",
      "Run npm test",
      "Gate: typecheck",
      "Repair: review findings",
      "Loop breaker: the same test command ran twice. Forcing a strategy change.",
      "All retry logic now lives in src/net/retry.js and every suite passes.",
    ]);
  });

  it("gives every tool row the SAME glyph the tool-call row shows", () => {
    // The thread and the inline chain must not disagree about a tool's icon.
    expect(steps[1].glyph).toBe(KIND_GLYPH.run);
    expect(steps[2].glyph).toBe(KIND_GLYPH.run);
    expect(steps[3].glyph).toBe(KIND_GLYPH.run);
    expect(steps[4].glyph).toBe("build");
    expect(steps[5].glyph).toBe("loop");
  });

  it("keeps the reasoning block as a think row with its full detail", () => {
    expect(steps[0].kind).toBe("think");
    expect(steps[0].detail).toContain("not in the fetch wrapper");
  });

  it("streams the tool output into the tool row that was running", () => {
    expect(steps[1].detail).toContain("grep -rn fetchWithRetry src/");
    expect(steps[1].detail).toContain("Command completed: 4 call sites");
    expect(steps[1].status).toBe("done");
  });

  it("marks a failed tool as an error row", () => {
    expect(steps[2].detail).toContain("npm test");
    expect(steps[2].detail).toContain("Command failed: 1 suite failed");
    expect(steps[2].status).toBe("error");
  });

  it("closes a failing gate with an error and opens the repair as a NEW row", () => {
    expect(steps[3].text).toBe("Gate: typecheck");
    expect(steps[3].status).toBe("error");
    expect(steps[4].text).toBe("Repair: review findings");
    expect(steps[4].id).not.toBe(steps[3].id);
  });

  it("fails the loop-breaker stop", () => {
    expect(steps[5].status).toBe("error");
    expect(steps[5].text).toContain("Loop breaker:");
  });

  it("ends with the one-line outcome as a result row", () => {
    expect(steps[6].kind).toBe("result");
    expect(steps[6].status).toBe("done");
    expect(steps[6].text).toBe("All retry logic now lives in src/net/retry.js and every suite passes.");
  });

  it("gives every row a stable id", () => {
    const again = stepsOf(TRANSCRIPT);
    expect(again.map((s) => s.id)).toEqual(steps.map((s) => s.id));
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
  });
});

describe("thought-line — live vs reloaded", () => {
  it("leaves the running tool active while the turn is live", () => {
    const live = stepsOf("running [npm test]", true);
    expect(live).toHaveLength(1);
    expect(live[0].status).toBe("active");
  });

  it("never leaves a stale active row after a reload", () => {
    const reloaded = stepsOf("running [npm test]", false);
    expect(reloaded[0].status).not.toBe("active");
    expect(reloaded.every((s) => s.status !== "active")).toBe(true);
  });

  it("does not add a result row while the turn is still running", () => {
    const live = stepsOf("running [npm test]\n\nWorking on it.", true);
    expect(live.some((s) => s.kind === "result")).toBe(false);
  });

  it("adds the result row once the turn is over", () => {
    const done = stepsOf("running [npm test]\n\nWorking on it.", false);
    expect(done.some((s) => s.kind === "result")).toBe(true);
  });

  it("shows no thread at all for a prose-only message", () => {
    // A user turn (or a one-line answer) must not grow a result row that
    // repeats the sentence right below it.
    expect(stepsOf("What does the retry helper do?")).toHaveLength(0);
  });
});

describe("thought-line — marker vocabulary", () => {
  const one = (content: string) => stepsOf(content)[0];

  it("maps a passing gate to a done row", () => {
    const step = one("**Verifying changes.** typecheck round 1/1\n**Verification passed** - typecheck clean");
    expect(step.text).toBe("Gate: typecheck");
    expect(step.status).toBe("done");
  });

  it("maps an unverifiable lane to a failure — skipped is not a pass", () => {
    const step = one("**Verifying changes.** typecheck round 1/1\n**Typecheck not verified** - the lane could not run");
    expect(step.status).toBe("error");
  });

  it("maps the gate pipeline verdict to the row status", () => {
    const pass = one("**Gate pipeline** - verdict PASS\n  typecheck  pass in 3.2s");
    expect(pass.text).toBe("Gate pipeline");
    expect(pass.status).toBe("done");
    expect(pass.detail).toContain("typecheck");

    const fail = one("**Gate pipeline** - verdict FAIL\n  typecheck  fail in 3.2s");
    expect(fail.status).toBe("error");
  });

  it("maps the reviewer roles to think rows with the role in the text", () => {
    const self = one("**Self-review:** 2 critical issue(s), applying fixes.");
    expect(self.kind).toBe("think");
    expect(self.text).toBe("Reviewer: self-review");

    const code = one("**Code review:** one structured reviewer pass over the changes.");
    expect(code.kind).toBe("think");
    expect(code.text).toBe("Reviewer: code review");

    const closed = one("**Code review:** one structured reviewer pass.\n**Code review passed** - no blocking findings");
    expect(closed.status).toBe("done");
  });

  it("maps the hard stops to error rows with their reason", () => {
    expect(one("*[Stopped - the agent hit a stop condition before completing the task.]*").status).toBe("error");
    expect(one("*[Safety limit - too many tool calls]*").text).toContain("Safety limit:");
    expect(one("*[Turn limit (12) reached - stopped honestly without finishing.]*").text).toContain("Turn limit (12)");
    expect(one("**Task halted** - the workspace is gone.").text).toContain("Task halted:");
  });

  it("does not paint a successful approval red", () => {
    const approved = one("[CAPABILITY] write_file - user approved");
    expect(approved.status).toBe("done");
    expect(approved.text).toContain("approved");
  });

  it("does not paint a queued loop intervention red", () => {
    const rung = one("[LOOP] intervention rung 2 - directive queued for the next turn");
    expect(rung.status).toBe("done");
  });

  it("paints a refused loop call red", () => {
    expect(one("[LOOP] run_command refused - hard denylist").status).toBe("error");
  });

  it("paints a policy block red", () => {
    expect(one("[GATE] write_file blocked - plan first").status).toBe("error");
    expect(one("[PATH-JAIL] read_file blocked").status).toBe("error");
  });

  it("swallows the notices that would only be noise", () => {
    expect(stepsOf("*[Workspace learnings applied]*")).toHaveLength(0);
    expect(stepsOf("*[Playbook learnings applied]*")).toHaveLength(0);
    expect(stepsOf("*Browser verification unavailable - skipped.*")).toHaveLength(0);
  });

  it("reads the verification report as one row, red when the verdict is FAIL", () => {
    const pass = one("VERIFICATION REPORT - task 7 (now)\nResult: PASS - every check that ran came back clean");
    expect(pass.text).toBe("Verification report");
    expect(pass.status).toBe("done");

    const fail = one("VERIFICATION REPORT - task 7 (now)\nResult: FAIL - at least one check failed");
    expect(fail.status).toBe("error");
  });
});

describe("thought-line — output caps", () => {
  it("truncates long tool output with an explicit marker", () => {
    const long = "x".repeat(5000);
    const capped = truncateDetail(long, 100);
    expect(capped.length).toBeLessThan(200);
    expect(capped).toContain("truncated");
  });

  it("truncates the tool output that lands in the thread", () => {
    const step = stepsOf(`running [npm test]\n[OK] ${"y".repeat(9000)}`)[0];
    expect(step.detail).toContain("truncated");
    expect(step.detail!.length).toBeLessThan(9000);
  });
});

describe("thought-line — the one-line outcome", () => {
  it("drops the trailing rule and the token-meter line", () => {
    const outcome = outcomeFromText(
      "All tests pass and the helper is in place.\n\n---\n\n*Saved 12.3k tokens (31%) - 3 calls*"
    );
    expect(outcome).toBe("All tests pass and the helper is in place.");
  });

  it("strips the markdown chrome of a heading", () => {
    expect(outcomeFromText("## Done\nThe rest is below.")).toBe("Done");
  });

  it("caps a long first line", () => {
    const outcome = outcomeFromText("z".repeat(400));
    expect(outcome.length).toBeLessThanOrEqual(141);
    expect(outcome.endsWith("…")).toBe(true);
  });
});
