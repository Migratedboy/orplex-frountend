// loop-guard-extension.test.ts — Phase 5 loop & progress guard signals.
//
// Covers ONLY the additive surface of loop-detect.ts (oscillation R3,
// no-progress R5, budget R6, hard denylist, 5-rung ladder) plus
// reliability/progress-hash.ts. The classic four streak signals are covered
// by loop-detect.test.ts and are not re-tested here.
import {
  createLoopStreaks,
  normalizeCallSignature,
  trackOscillation,
  trackProgress,
  recordBudget,
  checkWallClock,
  recordCallFailure,
  buildHardDenylist,
  buildInterventionDirective,
  buildLoopBreakDirective,
  trackToolTurn,
  OSCILLATION_HISTORY_LIMIT,
  PROGRESS_STALL_STEPS,
  BUDGET_MAX_WALL_MS,
  BUDGET_MAX_TOKENS,
  HARD_DENY_AFTER,
  type LoopStreaks,
} from "../loop-detect";
import { hashWorkspaceState, gateFingerprint, fnv1aHex } from "../reliability/progress-hash";
import { reliabilityLoopGuardExtendedEnabled } from "../reliability/flags";

describe("loop-guard extension", () => {
  describe("normalizeCallSignature", () => {
    it("is stable across object key order", () => {
      expect(normalizeCallSignature("x", { a: 1, b: "z" })).toBe(normalizeCallSignature("x", { b: "z", a: 1 }));
    });

    it("strips volatile parts: line numbers, timestamps, uuids, offsets", () => {
      const a = normalizeCallSignature("read_file", {
        path: "src/app.ts",
        note: "failed at line 42:7 in uuid 550e8400-e29b-41d4-a716-446655440000 at 2026-10-17T12:00:00Z",
        offset: 10,
      });
      const b = normalizeCallSignature("read_file", {
        path: "src/app.ts",
        note: "failed at line 99:1 in uuid 11111111-2222-3333-4444-555555555555 at 2020-01-01T00:00:00Z",
        offset: 5000,
      });
      expect(a).toBe(b);
      expect(a).not.toContain("42");
      expect(a).not.toContain("550e8400");
    });

    it("keeps meaningful argument differences", () => {
      expect(normalizeCallSignature("read_file", { path: "a.ts" })).not.toBe(
        normalizeCallSignature("read_file", { path: "b.ts" })
      );
    });

    it("uses the tool|normalizedArgs shape", () => {
      expect(normalizeCallSignature("run_command", { command: "npm test" })).toMatch(/^run_command\|/);
    });
  });

  describe("trackOscillation (R3)", () => {
    const sig = (name: string, args: Record<string, unknown>) => normalizeCallSignature(name, args);

    it("detects A,B,A,B as oscillating with period 2", () => {
      const s = createLoopStreaks();
      const A = sig("edit_file", { path: "a.ts", old_text: "x", new_text: "y" });
      const B = sig("edit_file", { path: "a.ts", old_text: "y", new_text: "x" });
      const seq = [A, B, A, B];
      const results = seq.map((x) => trackOscillation(s, x));
      expect(results[0].oscillating).toBe(false);
      expect(results[1].oscillating).toBe(false);
      expect(results[2].oscillating).toBe(false);
      expect(results[3].oscillating).toBe(true);
      expect(results[3].period).toBe(2);
    });

    it("detects A,B,C,A,B,C as oscillating with period 3", () => {
      const s = createLoopStreaks();
      const sigs = ["A", "B", "C", "A", "B", "C"].map((x) => sig("run_command", { command: `step ${x}` }));
      const results = sigs.map((x) => trackOscillation(s, x));
      expect(results[5].oscillating).toBe(true);
      expect(results[5].period).toBe(3);
    });

    it("does not trip on a non-repeating sequence", () => {
      const s = createLoopStreaks();
      for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
        expect(trackOscillation(s, sig("read_file", { path: `${name}.ts` })).oscillating).toBe(false);
      }
    });

    it("oscillation is detected even when volatile parts differ (timestamps in args)", () => {
      const s = createLoopStreaks();
      for (let i = 0; i < 4; i++) {
        const call = i % 2 === 0
          ? normalizeCallSignature("run_command", { command: "npm test", ts: Date.now() + i })
          : normalizeCallSignature("run_command", { command: "npm run lint", ts: Date.now() + i });
        const r = trackOscillation(s, call);
        if (i === 3) expect(r.oscillating).toBe(true);
      }
    });

    it("history is bounded", () => {
      const s = createLoopStreaks();
      for (let i = 0; i < OSCILLATION_HISTORY_LIMIT + 10; i++) {
        trackOscillation(s, `sig${i}`);
      }
      expect(s.oscillationHistory.length).toBe(OSCILLATION_HISTORY_LIMIT);
    });
  });

  describe("trackProgress (R5)", () => {
    it("5 identical snapshots → stalled true", () => {
      const s = createLoopStreaks();
      const results = [];
      for (let step = 1; step <= PROGRESS_STALL_STEPS; step++) {
        results.push(trackProgress(s, step, "files-1", "gate-1"));
      }
      expect(results[PROGRESS_STALL_STEPS - 1].stalled).toBe(true);
      expect(results[PROGRESS_STALL_STEPS - 1].stepsWithoutProgress).toBe(PROGRESS_STALL_STEPS);
      expect(results[0].stalled).toBe(false);
    });

    it("a files-hash change resets the counter", () => {
      const s = createLoopStreaks();
      for (let step = 1; step <= 4; step++) trackProgress(s, step, "files-1", "gate-1");
      const afterChange = trackProgress(s, 5, "files-2", "gate-1");
      expect(afterChange.stalled).toBe(false);
      expect(afterChange.stepsWithoutProgress).toBe(1);
    });

    it("a gate-fingerprint change alone also resets the counter", () => {
      const s = createLoopStreaks();
      for (let step = 1; step <= 4; step++) trackProgress(s, step, "files-1", "gate-1");
      const afterChange = trackProgress(s, 5, "files-1", "gate-2");
      expect(afterChange.stalled).toBe(false);
      expect(afterChange.stepsWithoutProgress).toBe(1);
    });

    it("keeps snapshots bounded but the counter keeps incrementing", () => {
      const s = createLoopStreaks();
      for (let step = 1; step <= 40; step++) trackProgress(s, step, "same-files", "same-gate");
      expect(s.stepSnapshots.length).toBeLessThanOrEqual(20);
      // eviction of old snapshots must not reset the O(1) counter
      expect(s.stepsWithoutProgress).toBe(40);
    });
  });

  describe("budget (R6)", () => {
    it("recordBudget trips when tokens exceed the max", () => {
      const s = createLoopStreaks();
      expect(recordBudget(s, BUDGET_MAX_TOKENS - 1).exceeded).toBe(false);
      const r = recordBudget(s, 2);
      expect(r.exceeded).toBe(true);
      expect(r.reason).toContain("Token budget exceeded");
    });

    it("accumulates across turns and ignores negative deltas", () => {
      const s = createLoopStreaks();
      recordBudget(s, 100);
      recordBudget(s, -50);
      expect(s.budget.tokenEstimate).toBe(100);
    });

    it("checkWallClock trips after maxWallMs", () => {
      const s = createLoopStreaks();
      s.budget.startedAt = Date.now() - BUDGET_MAX_WALL_MS - 1;
      expect(checkWallClock(s).exceeded).toBe(true);
      s.budget.startedAt = Date.now();
      expect(checkWallClock(s).exceeded).toBe(false);
    });

    it("defaults come from the exported constants", () => {
      const s: LoopStreaks = createLoopStreaks();
      expect(s.budget.maxWallMs).toBe(BUDGET_MAX_WALL_MS);
      expect(s.budget.maxTokens).toBe(BUDGET_MAX_TOKENS);
    });
  });

  describe("hard denylist", () => {
    it("same failing call 3x → appears in buildHardDenylist, refusal key is tool|args", () => {
      const s = createLoopStreaks();
      const args = { command: "npx tsc --noEmit" };
      for (let i = 0; i < HARD_DENY_AFTER - 1; i++) {
        const r = recordCallFailure(s, "run_command", args, false);
        expect(r.denylisted).toBe(false);
        expect(buildHardDenylist(s).size).toBe(0);
      }
      const last = recordCallFailure(s, "run_command", args, false);
      expect(last.denylisted).toBe(true);
      expect(last.signature).toBe('run_command|{"command":"npx tsc --noEmit"}');
      const denylist = buildHardDenylist(s);
      expect(denylist.has(last.signature)).toBe(true);
    });

    it("a success resets the failure count for that signature", () => {
      const s = createLoopStreaks();
      const args = { command: "npm test" };
      recordCallFailure(s, "run_command", args, false);
      recordCallFailure(s, "run_command", args, false);
      recordCallFailure(s, "run_command", args, true);
      recordCallFailure(s, "run_command", args, false);
      expect(buildHardDenylist(s).size).toBe(0);
      expect(s.callFailureCounts.get(normalizeCallSignature("run_command", args))).toBe(1);
    });

    it("different args are independent signatures", () => {
      const s = createLoopStreaks();
      for (const command of ["cmd-a", "cmd-b", "cmd-c"]) {
        for (let i = 0; i < HARD_DENY_AFTER; i++) {
          recordCallFailure(s, "run_command", { command }, false);
        }
      }
      expect(buildHardDenylist(s).size).toBe(3);
    });

    it("volatile arg noise does not dodge the denylist", () => {
      const s = createLoopStreaks();
      for (let i = 0; i < HARD_DENY_AFTER; i++) {
        recordCallFailure(s, "run_command", { command: "npm test", requestId: `req-${i}`, ts: 1700000000000 + i }, false);
      }
      expect(buildHardDenylist(s).size).toBe(1);
    });
  });

  describe("buildInterventionDirective — the 5-rung ladder", () => {
    const verdict = { loop: true, reason: "Looping on read_file (same target 4x in a row: path \"a.ts\")" };
    const evidence = '<tool_result name="read_file">file contents</tool_result>';

    it("rung 1 text is byte-identical to buildLoopBreakDirective", () => {
      const s = createLoopStreaks();
      expect(buildInterventionDirective(s, 1, { reason: verdict.reason, lastToolResults: evidence })).toBe(
        buildLoopBreakDirective(verdict, evidence)
      );
    });

    it("rung 1 works with defaults (no context)", () => {
      const s = createLoopStreaks();
      const text = buildInterventionDirective(s, 1);
      expect(text).toContain("You are repeating the same action");
      expect(text).toContain("DIFFERENT action");
    });

    it("rung 2 halts explicitly", () => {
      const s = createLoopStreaks();
      const text = buildInterventionDirective(s, 2, { reason: verdict.reason, lastToolResults: evidence });
      expect(text).toContain("[LOOP HALT]");
      expect(text).toContain("STOP emitting tool calls");
      expect(text).toContain("file contents");
    });

    it("rung 3 names the hard-denied (tool,args) signatures", () => {
      const s = createLoopStreaks();
      const args = { command: "npm test" };
      for (let i = 0; i < HARD_DENY_AFTER; i++) recordCallFailure(s, "run_command", args, false);
      const text = buildInterventionDirective(s, 3, { reason: verdict.reason });
      expect(text).toContain("HARD DENYLIST");
      expect(text).toContain('run_command|{"command":"npm test"}');
      expect(text).toContain("REFUSED");
    });

    it("rung 3 uses explicitly provided denied signatures", () => {
      const s = createLoopStreaks();
      const text = buildInterventionDirective(s, 3, { deniedSignatures: ["write_file|{\"path\":\"x\"}"] });
      expect(text).toContain('write_file|{"path":"x"}');
    });

    it("rung 4 names the last-green checkpoint", () => {
      const s = createLoopStreaks();
      const text = buildInterventionDirective(s, 4, { reason: verdict.reason, checkpointRef: "refs/orplex/checkpoints/cp-7" });
      expect(text).toContain("ROLLBACK");
      expect(text).toContain("refs/orplex/checkpoints/cp-7");
      expect(text).toContain("known-good state");
    });

    it("rung 4 falls back to a generic checkpoint phrase", () => {
      const s = createLoopStreaks();
      expect(buildInterventionDirective(s, 4)).toContain("the last green checkpoint");
    });

    it("rung 5 asks the user and forbids further tool calls", () => {
      const s = createLoopStreaks();
      const text = buildInterventionDirective(s, 5, { reason: verdict.reason });
      expect(text).toContain("ASK THE USER");
      expect(text).toContain("ask the user ONE specific question");
      expect(text).toContain("Do not emit further tool calls");
    });
  });

  describe("reliability/progress-hash", () => {
    it("fnv1aHex is deterministic and length-sensitive", () => {
      expect(fnv1aHex("abc")).toBe(fnv1aHex("abc"));
      expect(fnv1aHex("abc")).not.toBe(fnv1aHex("abcd"));
    });

    it("hashWorkspaceState is order-insensitive (Map and record)", () => {
      const a = hashWorkspaceState(new Map([["b.ts", "2"], ["a.ts", "1"]]));
      const b = hashWorkspaceState({ "a.ts": "1", "b.ts": "2" });
      expect(a).toBe(b);
    });

    it("hashWorkspaceState changes when a file's content changes", () => {
      const a = hashWorkspaceState({ "a.ts": "1" });
      const b = hashWorkspaceState({ "a.ts": "1!" });
      expect(a).not.toBe(b);
    });

    it("hashWorkspaceState does not alias concatenated paths", () => {
      expect(hashWorkspaceState({ ab: "c" })).not.toBe(hashWorkspaceState({ a: "bc" }));
    });

    it("gateFingerprint is order-insensitive over lanes and errors", () => {
      const a = gateFingerprint([
        { lane: "typecheck", outcome: "fail", newErrors: ["e2", "e1"] },
        { lane: "swarm", outcome: "pass", newErrors: [] },
      ]);
      const b = gateFingerprint([
        { lane: "swarm", outcome: "pass", newErrors: [] },
        { lane: "typecheck", outcome: "fail", newErrors: ["e1", "e2"] },
      ]);
      expect(a).toBe(b);
    });

    it("same failing gate is detectable across steps; a fix changes the fingerprint", () => {
      const failing = [{ lane: "typecheck", outcome: "fail", newErrors: ["TS2345"] }];
      expect(gateFingerprint(failing)).toBe(gateFingerprint(failing.map((r) => ({ ...r }))));
      expect(gateFingerprint(failing)).not.toBe(gateFingerprint([{ lane: "typecheck", outcome: "pass", newErrors: [] }]));
    });
  });

  describe("flag default", () => {
    it("is OFF unless RELIABILITY_GATES and RELIABILITY_LOOP_GUARD are both 1", () => {
      const prevGates = process.env.RELIABILITY_GATES;
      const prevGuard = process.env.RELIABILITY_LOOP_GUARD;
      try {
        delete process.env.RELIABILITY_GATES;
        delete process.env.RELIABILITY_LOOP_GUARD;
        expect(reliabilityLoopGuardExtendedEnabled()).toBe(false);
        process.env.RELIABILITY_GATES = "1";
        expect(reliabilityLoopGuardExtendedEnabled()).toBe(false);
        process.env.RELIABILITY_LOOP_GUARD = "1";
        expect(reliabilityLoopGuardExtendedEnabled()).toBe(true);
        process.env.RELIABILITY_LOOP_GUARD = "0";
        expect(reliabilityLoopGuardExtendedEnabled()).toBe(false);
      } finally {
        if (prevGates === undefined) delete process.env.RELIABILITY_GATES;
        else process.env.RELIABILITY_GATES = prevGates;
        if (prevGuard === undefined) delete process.env.RELIABILITY_LOOP_GUARD;
        else process.env.RELIABILITY_LOOP_GUARD = prevGuard;
      }
    });
  });

  describe("existing signals untouched by the extension", () => {
    it("trackToolTurn on the extended state behaves identically (R1 still trips at 3)", () => {
      const s = createLoopStreaks();
      // interleave extension calls — they must not perturb the streak signals
      trackOscillation(s, "warmup");
      trackProgress(s, 1, "f", "g");
      recordBudget(s, 10);
      const call = { name: "scratchpad_update", section: "plan" };
      expect(trackToolTurn(s, [call]).loop).toBe(false);
      expect(trackToolTurn(s, [call]).loop).toBe(false);
      const v = trackToolTurn(s, [call]);
      expect(v.loop).toBe(true);
      expect(v.reason).toContain("identical call 3x in a row");
    });
  });
});
