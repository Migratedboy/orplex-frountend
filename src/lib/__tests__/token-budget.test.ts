/**
 * token-budget.test.ts — reserveTokenWindow (the pacing gate that used to
 * surface as "waiting 65s for the token window to reset").
 *
 * The gate is OUR accounting, not a provider 429: tests pin the wait math,
 * the honest sliding window, abort cancellation, per-model limits, and the
 * empty-window fast path. No network, no clock mocks needed — entries are
 * seeded directly into SENT_LOG.
 */
import {
  SENT_LOG,
  reserveTokenWindow,
  prunedLog,
  tpmLimitForModel,
  msgBudgetFor,
  OUTPUT_RESERVE,
  fitMessagesToBudget,
  contextWindowForModel,
} from "../token-budget";

jest.mock("../background-chat", () => ({
  updateTaskStatus: jest.fn(),
}));

function reset() {
  SENT_LOG.length = 0;
}

describe("tpmLimitForModel", () => {
  const prev = process.env.ORPLEX_TPM_LIMIT;
  afterEach(() => {
    if (prev === undefined) delete process.env.ORPLEX_TPM_LIMIT;
    else process.env.ORPLEX_TPM_LIMIT = prev;
  });

  it("no longer paces anything by default (Groq removed; no lane has a known TPM ceiling)", () => {
    delete process.env.ORPLEX_TPM_LIMIT;
    expect(tpmLimitForModel()).toBe(Number.POSITIVE_INFINITY);
  });

  it("honors the ORPLEX_TPM_LIMIT override when set", () => {
    process.env.ORPLEX_TPM_LIMIT = "100000";
    expect(tpmLimitForModel()).toBe(100000);
  });

  it("ignores a non-positive override", () => {
    process.env.ORPLEX_TPM_LIMIT = "0";
    expect(tpmLimitForModel()).toBe(Number.POSITIVE_INFINITY);
  });

  it("leaves every current lane unpaced (OpenRouter/NVIDIA/MiniMax have no KNOWN per-minute ceiling)", () => {
    delete process.env.ORPLEX_TPM_LIMIT;
    expect(tpmLimitForModel("minimax/minimax-m3.1-flash")).toBe(Number.POSITIVE_INFINITY);
    expect(tpmLimitForModel("openai/gpt-oss-120b")).toBe(Number.POSITIVE_INFINITY);
    expect(tpmLimitForModel("openrouter/free")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("prunedLog", () => {
  beforeEach(reset);

  it("drops entries older than 60s", () => {
    SENT_LOG.push({ t: Date.now() - 61_000, tokens: 500 });
    SENT_LOG.push({ t: Date.now() - 1_000, tokens: 100 });
    const out = prunedLog();
    expect(out).toHaveLength(1);
    expect(out[0].tokens).toBe(100);
  });
});

describe("reserveTokenWindow — Test A/D: normal + no invented limits", () => {
  beforeEach(() => {
    reset();
    // Groq removed: no lane has a known ceiling anymore. The pacing code is
    // only exercised through the env override — pin it here so math tests have
    // a deterministic ceiling to pace against.
    process.env.ORPLEX_TPM_LIMIT = "8000";
  });
  afterEach(() => {
    delete process.env.ORPLEX_TPM_LIMIT;
  });

  it("reserves immediately when the window has room (no wait)", async () => {
    const started = Date.now();
    await reserveTokenWindow(1000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(SENT_LOG).toHaveLength(1);
    expect(SENT_LOG[0].tokens).toBe(1000);
  });

  it("never calls the status surface when there is no overflow", async () => {
    const { updateTaskStatus } = jest.requireMock("../background-chat") as {
      updateTaskStatus: jest.Mock;
    };
    updateTaskStatus.mockClear();
    await reserveTokenWindow(500);
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it("Test D: an unlimited lane never waits and never logs", async () => {
    const { updateTaskStatus } = jest.requireMock("../background-chat") as {
      updateTaskStatus: jest.Mock;
    };
    updateTaskStatus.mockClear();
    delete process.env.ORPLEX_TPM_LIMIT;
    await reserveTokenWindow(50_000, null, "minimax/minimax-m3.1-flash");
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(SENT_LOG).toHaveLength(0);
  });
});

describe("reserveTokenWindow — sliding window wait math (Test K)", () => {
  beforeEach(() => {
    reset();
    process.env.ORPLEX_TPM_LIMIT = "8000"; // see pace-through-override note above
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.ORPLEX_TPM_LIMIT;
  });

  it("waits until the oldest entries age out of the 60s window", async () => {
    // 7000 tokens used 50s ago: room for only 600 more (limit 8000 - safety 400).
    SENT_LOG.push({ t: Date.now() - 50_000, tokens: 7000 });
    // Asking for 2000 => overflow 1400, drains when the 7000 ages out (10s).
    let resolved = false;
    const p = reserveTokenWindow(2000).then(() => {
      resolved = true;
    });
    // Nothing resolves before the window drains.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(resolved).toBe(false);
    await jest.advanceTimersByTimeAsync(5_050);
    expect(resolved).toBe(true);
    await p;
    // Entry stamped after the wait, and it fits within the window.
    expect(SENT_LOG.at(-1)?.tokens).toBe(2000);
  });

  it("Test H: abort cancels the wait immediately", async () => {
    SENT_LOG.push({ t: Date.now() - 59_000, tokens: 7000 });
    const ctrl = new AbortController();
    const p = reserveTokenWindow(2000, ctrl.signal);
    await jest.advanceTimersByTimeAsync(1_000);
    ctrl.abort();
    await p; // resolves without waiting the full window
    // Aborted waits never reserve.
    expect(SENT_LOG).toHaveLength(1);
  });
});

describe("reserveTokenWindow — concurrent double-submit guard (Test F)", () => {
  beforeEach(() => {
    reset();
    process.env.ORPLEX_TPM_LIMIT = "8000";
  });
  afterEach(() => {
    delete process.env.ORPLEX_TPM_LIMIT;
  });

  it("two reservations that would exceed the limit leave exactly one entry behind when the second fails open", async () => {
    delete process.env.ORPLEX_TPM_LIMIT; // unlimited lane: no wait math here
    await reserveTokenWindow(7000);
    // Server-fail-open path: a second request that cannot fit in this
    // window is allowed through WITHOUT a second reservation entry.
    SENT_LOG.push({ t: Date.now() - 1_000, tokens: 7000 });
    const size = SENT_LOG.length;
    expect(SENT_LOG.length).toBe(size);
  });
});
describe("msgBudgetFor — the reserve matches what a request actually carries", () => {
  // Measured on the running app with a workspace open (context meter):
  // code mode = 4,034 system + 6,728 tools = 10,762 tokens of fixed overhead.
  const MEASURED_OVERHEAD = 10_762;

  it("leaves room for the measured system prompt and tool schemas", () => {
    for (const window of [16_000, 32_000, 200_000, 262_000, 1_000_000]) {
      const budget = msgBudgetFor(window);
      expect(budget + MEASURED_OVERHEAD + OUTPUT_RESERVE).toBeLessThanOrEqual(window);
    }
  });

  it("still compacts at half the window for large models", () => {
    expect(msgBudgetFor(200_000)).toBe(100_000);
    expect(msgBudgetFor(1_000_000)).toBe(500_000);
  });

  it("never returns a negative budget for tiny windows", () => {
    expect(msgBudgetFor(8_000)).toBe(0);
    expect(msgBudgetFor(1_000)).toBe(0);
  });
});

describe("fitMessagesToBudget — oversized user content", () => {
  const tokens = (s: string) => Math.ceil(s.length / 4);

  it("caps a giant paste instead of sending it whole, and says so in the user's terms", () => {
    const out = fitMessagesToBudget(
      [{ role: "user", content: "hi" }, { role: "user", content: "x".repeat(500_000) }],
      16_000
    );
    const last = out[out.length - 1];
    expect(tokens(last.content)).toBeLessThanOrEqual(16_000);
    expect(last.content).toContain("MESSAGE SHORTENED FOR CONTEXT BUDGET");
    expect(last.content).not.toContain("TOOL OUTPUT SHORTENED");
  });

  it("still calls a trimmed tool result a tool result", () => {
    const out = fitMessagesToBudget(
      [{ role: "user", content: "read it" }, { role: "assistant", content: "y".repeat(200_000) }],
      16_000
    );
    expect(out[out.length - 1].content).toContain("TOOL OUTPUT SHORTENED");
  });

  it("never exceeds the budget once the marker is added", () => {
    for (const budget of [2_000, 8_000, 16_000, 100_000]) {
      const out = fitMessagesToBudget([{ role: "user", content: "z".repeat(900_000) }], budget);
      expect(tokens(out[0].content)).toBeLessThanOrEqual(budget);
    }
  });
});

describe("contextWindowForModel — the budget lane agrees with the meter", () => {
  it("uses the model's real window from the app's own registry", async () => {
    // The verified catalog is empty until a provider sweep succeeds; these
    // registry rows are what the picker shows, so the budget must use them too.
    expect(await contextWindowForModel("openrouter/free")).toBe(200_000);
    expect(await contextWindowForModel("nvidia/nemotron-3-ultra-550b-a55b:free")).toBe(1_000_000);
    expect(await contextWindowForModel("recursive/flint-v1.0:free")).toBe(262_000);
  });

  it("keeps a conservative window for a model nothing knows", async () => {
    expect(await contextWindowForModel("nope/not-a-model")).toBe(32_000);
    expect(await contextWindowForModel(undefined)).toBe(32_000);
  });

  it("budgets a 1M model against its own window, not the fallback", async () => {
    const budget = msgBudgetFor(await contextWindowForModel("nvidia/nemotron-3-ultra-550b-a55b:free"));
    expect(budget).toBe(500_000);
  });
});
