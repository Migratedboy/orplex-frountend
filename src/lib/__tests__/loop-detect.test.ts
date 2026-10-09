import {
  createLoopStreaks,
  stableCallKey,
  trackToolTurn,
  callTarget,
  buildLoopBreakDirective,
  MAX_SAME_CALL,
  MAX_SAME_TOOL,
  MAX_SAME_TARGET,
  MAX_SAME_TURN,
} from "../loop-detect";

const c = (name: string, extra: Record<string, unknown> = {}) => ({ name, ...extra });

describe("loop-detect", () => {
  describe("signal 1: identical call re-sent", () => {
    it("trips at MAX_SAME_CALL identical single-call turns", () => {
      const s = createLoopStreaks();
      expect(trackToolTurn(s, [c("scratchpad_update", { section: "plan" })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("scratchpad_update", { section: "plan" })]).loop).toBe(false);
      const v = trackToolTurn(s, [c("scratchpad_update", { section: "plan" })]);
      expect(v.loop).toBe(true);
      expect(v.reason).toContain("scratchpad_update");
      expect(v.reason).toContain("identical call 3x in a row");
    });

    it("trips on a triple duplicate inside ONE message", () => {
      const s = createLoopStreaks();
      const v = trackToolTurn(s, [
        c("run_command", { command: "npm test" }),
        c("run_command", { command: "npm test" }),
        c("run_command", { command: "npm test" }),
      ]);
      expect(v.loop).toBe(true);
    });

    it("streak resets when a different call appears", () => {
      const s = createLoopStreaks();
      expect(trackToolTurn(s, [c("read_file", { path: "a" })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("read_file", { path: "a" })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("read_file", { path: "b" })]).loop).toBe(false); // resets streak to 1
      expect(trackToolTurn(s, [c("read_file", { path: "a" })]).loop).toBe(false); // still 1
      expect(trackToolTurn(s, [c("read_file", { path: "a" })]).loop).toBe(false); // 2
      expect(trackToolTurn(s, [c("read_file", { path: "a" })]).loop).toBe(true); // 3
    });

    it("arg content matters, not just tool name", () => {
      const s = createLoopStreaks();
      for (const q of ["q1", "q2", "q3", "q4", "q5"]) {
        expect(trackToolTurn(s, [c("code_search", { query: q })]).loop).toBe(false);
      }
    });
  });

  describe("signal 2: same state-changing tool every turn", () => {
    it(`trips at ${MAX_SAME_TOOL} consecutive single-tool turns`, () => {
      const s = createLoopStreaks();
      for (let i = 0; i < MAX_SAME_TOOL - 1; i++) {
        expect(trackToolTurn(s, [c("run_command", { command: `step ${i}` })]).loop).toBe(false);
      }
      const v = trackToolTurn(s, [c("run_command", { command: `step ${MAX_SAME_TOOL - 1}` })]);
      expect(v.loop).toBe(true);
      expect(v.reason).toContain(`(${MAX_SAME_TOOL}x in a row)`);
    });

    it("a different tool between runs resets the streak (old cumulative bug)", () => {
      const s = createLoopStreaks();
      for (let i = 0; i < 4; i++) {
        expect(trackToolTurn(s, [c("run_command", { command: `a${i}` })]).loop).toBe(false);
        expect(trackToolTurn(s, [c("write_file", { path: `f${i}` })]).loop).toBe(false);
      }
      // cumulative counts would have tripped long ago; streaks never reached 5
      expect(trackToolTurn(s, [c("run_command", { command: "a4" })]).loop).toBe(false);
    });

    it("read-only tools never trip the streak — exploring 10 files in a row is fine", () => {
      const s = createLoopStreaks();
      for (let i = 0; i < 10; i++) {
        expect(trackToolTurn(s, [c("read_file", { path: `src/f${i}.ts` })]).loop).toBe(false);
      }
      for (let i = 0; i < 10; i++) {
        expect(trackToolTurn(s, [c("web_search", { query: `topic ${i}` })]).loop).toBe(false);
      }
    });

    it("read turns neither extend nor reset a write streak (write→read ping-pong still trips)", () => {
      const s = createLoopStreaks();
      for (let i = 0; i < MAX_SAME_TOOL - 1; i++) {
        expect(trackToolTurn(s, [c("edit_file", { path: "app.ts", old_text: `v${i}` })]).loop).toBe(false);
        expect(trackToolTurn(s, [c("read_file", { path: "app.ts" })]).loop).toBe(false); // skipped, no reset
      }
      expect(trackToolTurn(s, [c("edit_file", { path: "app.ts", old_text: "last" })]).loop).toBe(true);
    });

    it("a mixed-tool turn resets the streak (variety = progress)", () => {
      const s = createLoopStreaks();
      for (let i = 0; i < 4; i++) {
        expect(trackToolTurn(s, [c("run_command", { command: `s${i}` })]).loop).toBe(false);
      }
      expect(trackToolTurn(s, [c("run_command", { command: "x" }), c("read_file", { path: "a" })]).loop).toBe(false);
      // streak reset — 4 more single run_commands still below the cap
      for (let i = 0; i < 4; i++) {
        expect(trackToolTurn(s, [c("run_command", { command: `t${i}` })]).loop).toBe(false);
      }
    });
  });

  describe("stableCallKey", () => {
    it("ignores object key order", () => {
      expect(stableCallKey({ name: "x", a: 1, b: 2 })).toBe(stableCallKey({ b: 2, a: 1, name: "x" } as { name: string }));
    });

    it("distinguishes different values", () => {
      expect(stableCallKey({ name: "x", a: 1 })).not.toBe(stableCallKey({ name: "x", a: 2 }));
    });

    it("handles missing name", () => {
      expect(stableCallKey({} as { name?: string })).toContain("?|");
    });
  });

  describe("reset", () => {
    it("Object.assign with a fresh state clears both streaks", () => {
      const s = createLoopStreaks();
      for (let i = 0; i < MAX_SAME_CALL; i++) {
        if (i === MAX_SAME_CALL - 1) break; // leave streak at 2
        trackToolTurn(s, [c("run_command", { command: "same" })]);
      }
      Object.assign(s, createLoopStreaks());
      expect(s.callFpStreak).toBe(0);
      expect(s.toolNameStreak).toBe(0);
      expect(trackToolTurn(s, [c("run_command", { command: "same" })]).loop).toBe(false);
    });
  });

  describe("signal 1b: same target, noisy args", () => {
    it(`trips at ${MAX_SAME_TARGET} calls on the same object even when args differ`, () => {
      const s = createLoopStreaks();
      expect(trackToolTurn(s, [c("read_file", { path: "a.ts", offset: 1, limit: 100 })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("read_file", { path: "a.ts", offset: 1, limit: 200 })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("read_file", { path: "a.ts", offset: 1, limit: 300 })]).loop).toBe(false);
      const v = trackToolTurn(s, [c("read_file", { path: "a.ts", offset: 1, limit: 500 })]);
      expect(v.loop).toBe(true);
      expect(v.reason).toContain("same target");
      expect(v.target).toContain("a.ts");
    });

    it("paging a file forward (different offsets) never trips", () => {
      const s = createLoopStreaks();
      for (const offset of [1, 201, 401, 601, 801, 1001]) {
        expect(trackToolTurn(s, [c("read_file", { path: "big.ts", offset, limit: 200 })]).loop).toBe(false);
      }
    });

    it("the same search query with different page sizes trips", () => {
      const s = createLoopStreaks();
      expect(trackToolTurn(s, [c("code_search", { query: "handleAuth", maxResults: 10 })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("code_search", { query: "handleAuth", maxResults: 20 })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("code_search", { query: "handleAuth", maxResults: 50 })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("code_search", { query: "handleAuth", maxResults: 100 })]).loop).toBe(true);
    });

    it("different targets never trip (exploration stays free)", () => {
      const s = createLoopStreaks();
      for (const p of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
        expect(trackToolTurn(s, [c("read_file", { path: p })]).loop).toBe(false);
      }
    });

    it("whitespace-only command variation collides (same target)", () => {
      const s = createLoopStreaks();
      expect(trackToolTurn(s, [c("run_command", { command: "npm  test" })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("run_command", { command: "npm test " })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("run_command", { command: "npm\ttest" })]).loop).toBe(false);
      const v = trackToolTurn(s, [c("run_command", { command: " npm test " })]);
      expect(v.loop).toBe(true);
      expect(v.reason).toContain("same target");
    });
  });

  describe("signal 1c: identical multi-call turn", () => {
    it(`trips at ${MAX_SAME_TURN} identical 2-call turns in a row`, () => {
      const s = createLoopStreaks();
      const pair = () => [c("read_file", { path: "a.ts" }), c("read_file", { path: "b.ts" })];
      expect(trackToolTurn(s, pair()).loop).toBe(false);
      expect(trackToolTurn(s, pair()).loop).toBe(false);
      const v = trackToolTurn(s, pair());
      expect(v.loop).toBe(true);
      expect(v.reason).toContain("same 2-call sequence");
    });

    it("a changed call in the pair resets the sequence", () => {
      const s = createLoopStreaks();
      expect(trackToolTurn(s, [c("read_file", { path: "a.ts" }), c("read_file", { path: "b.ts" })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("read_file", { path: "a.ts" }), c("read_file", { path: "c.ts" })]).loop).toBe(false);
      expect(trackToolTurn(s, [c("read_file", { path: "a.ts" }), c("read_file", { path: "b.ts" })]).loop).toBe(false);
    });
  });

  describe("callTarget", () => {
    it("keys read windows by path + offset", () => {
      expect(callTarget(c("read_file", { path: "a.ts", offset: 10 }))?.key).toBe("read|a.ts|10");
      expect(callTarget(c("read_file", { path: "a.ts" }))?.key).toBe("read|a.ts|0");
    });

    it("returns null for free-form payload tools", () => {
      expect(callTarget(c("scratchpad_update", { section: "plan" }))).toBeNull();
      expect(callTarget(c("todo_list", {}))).toBeNull();
    });

    it("treats direct mcp tools as their own target", () => {
      expect(callTarget(c("mcp__github__create_issue", { title: "x" }))?.key).toBe("mcptool|mcp__github__create_issue");
    });
  });

  describe("buildLoopBreakDirective", () => {
    it("carries the reason, the last result, and the grounding rule", () => {
      const text = buildLoopBreakDirective(
        { loop: true, reason: 'Looping on read_file (same target 4x in a row: path "a.ts")', callName: "read_file" },
        '<tool_result name="read_file">file contents</tool_result>'
      );
      expect(text).toContain("same target 4x in a row");
      expect(text).toContain("file contents");
      expect(text).toContain("DIFFERENT action");
      expect(text).toContain("write/edit call returned success");
    });

    it("works without prior tool results", () => {
      const text = buildLoopBreakDirective({ loop: true, reason: "Looping on x" });
      expect(text).toContain("Looping on x");
      expect(text).toContain("blocker");
    });
  });
});
