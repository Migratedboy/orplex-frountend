import type { EvalTask } from "../types";

/**
 * Refactor tasks — code that works but needs structural improvement.
 * The agent must restructure code without changing behavior.
 */
export const refactorTasks: EvalTask[] = [
  // ── REFAC-001 ───────────────────────────────────────────────────
  {
    id: "REFAC-001",
    name: "Extract magic numbers into constants",
    description:
      "A function uses hardcoded magic numbers that should be named constants " +
      "for readability and maintainability.",
    category: "refactor",
    difficulty: "easy",
    fixInstruction:
      "Refactor src/utils/rate-limiter.ts — extract all magic numbers into " +
      "named constants at the top of the file.",
    initialFiles: [
      {
        path: "src/utils/rate-limiter.ts",
        content: `export class RateLimiter {
  private counts = new Map<string, number[]>();

  isAllowed(key: string): boolean {
    const now = Date.now();
    const timestamps = this.counts.get(key) || [];
    const recent = timestamps.filter((t) => now - t < 60000);
    this.counts.set(key, recent);
    return recent.length < 100;
  }

  increment(key: string): void {
    const timestamps = this.counts.get(key) || [];
    timestamps.push(Date.now());
    this.counts.set(key, timestamps);
  }
}
`,
      },
    ],
    expectedFiles: {
      "src/utils/rate-limiter.ts": `const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 100;

export class RateLimiter {
  private counts = new Map<string, number[]>();

  isAllowed(key: string): boolean {
    const now = Date.now();
    const timestamps = this.counts.get(key) || [];
    const recent = timestamps.filter((t) => now - t < WINDOW_MS);
    this.counts.set(key, recent);
    return recent.length < MAX_REQUESTS;
  }

  increment(key: string): void {
    const timestamps = this.counts.get(key) || [];
    timestamps.push(Date.now());
    this.counts.set(key, timestamps);
  }
}
`,
    },
    assertions: [
      {
        label: "Constants defined at top of file",
        check: (files) => {
          const src = files["src/utils/rate-limiter.ts"] || "";
          return src.includes("const WINDOW_MS") && src.includes("const MAX_REQUESTS");
        },
      },
    ],
    timeout: 120,
  },

  // ── REFAC-002 ───────────────────────────────────────────────────
  {
    id: "REFAC-002",
    name: "Replace nested callbacks with async/await",
    description:
      "A function uses nested .then() callbacks that are hard to read. " +
      "Convert to async/await for clarity.",
    category: "refactor",
    difficulty: "medium",
    fixInstruction:
      "Refactor src/services/pipeline.ts — convert the nested .then() chain " +
      "to async/await for better readability.",
    initialFiles: [
      {
        path: "src/services/pipeline.ts",
        content: `export function processData(input: string) {
  return validate(input)
    .then((validated) => transform(validated))
    .then((transformed) => enrich(transformed))
    .then((enriched) => save(enriched))
    .then((saved) => ({ success: true, id: saved.id }))
    .catch((error) => ({ success: false, error: error.message }));
}

async function validate(input: string): Promise<string> {
  if (!input) throw new Error("Empty input");
  return input.trim();
}

async function transform(input: string): Promise<string> {
  return input.toLowerCase();
}

async function enrich(input: string): Promise<{ value: string; metadata: Record<string, unknown> }> {
  return { value: input, metadata: { processed: true } };
}

async function save(data: { value: string; metadata: Record<string, unknown> }): Promise<{ id: string }> {
  return { id: "saved-123" };
}
`,
      },
    ],
    expectedFiles: {
      "src/services/pipeline.ts": `export async function processData(input: string) {
  try {
    const validated = await validate(input);
    const transformed = await transform(validated);
    const enriched = await enrich(transformed);
    const saved = await save(enriched);
    return { success: true, id: saved.id };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function validate(input: string): Promise<string> {
  if (!input) throw new Error("Empty input");
  return input.trim();
}

async function transform(input: string): Promise<string> {
  return input.toLowerCase();
}

async function enrich(input: string): Promise<{ value: string; metadata: Record<string, unknown> }> {
  return { value: input, metadata: { processed: true } };
}

async function save(data: { value: string; metadata: Record<string, unknown> }): Promise<{ id: string }> {
  return { id: "saved-123" };
}
`,
    },
    assertions: [
      {
        label: "Uses async/await instead of .then() chains",
        check: (files) => {
          const src = files["src/services/pipeline.ts"] || "";
          return src.includes("async function processData") && src.includes("await validate");
        },
      },
    ],
    timeout: 120,
  },

  // ── REFAC-003 ───────────────────────────────────────────────────
  {
    id: "REFAC-003",
    name: "Extract duplicated validation logic",
    description:
      "Two functions contain nearly identical validation code that should " +
      "be extracted into a shared helper.",
    category: "refactor",
    difficulty: "medium",
    fixInstruction:
      "Refactor src/utils/validate.ts — the two functions have duplicated " +
      "email validation logic. Extract a shared isValidEmail helper.",
    initialFiles: [
      {
        path: "src/utils/validate.ts",
        content: `export function validateSignup(email: string, password: string) {
  const errors: string[] = [];
  if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
    errors.push("Invalid email");
  }
  if (!password || password.length < 8) {
    errors.push("Password too short");
  }
  return errors;
}

export function validateLogin(email: string, password: string) {
  const errors: string[] = [];
  if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
    errors.push("Invalid email");
  }
  if (!password) {
    errors.push("Password required");
  }
  return errors;
}
`,
      },
    ],
    expectedFiles: {
      "src/utils/validate.ts": `const EMAIL_REGEX = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

function isValidEmail(email: string): boolean {
  return !!email && EMAIL_REGEX.test(email);
}

export function validateSignup(email: string, password: string) {
  const errors: string[] = [];
  if (!isValidEmail(email)) {
    errors.push("Invalid email");
  }
  if (!password || password.length < 8) {
    errors.push("Password too short");
  }
  return errors;
}

export function validateLogin(email: string, password: string) {
  const errors: string[] = [];
  if (!isValidEmail(email)) {
    errors.push("Invalid email");
  }
  if (!password) {
    errors.push("Password required");
  }
  return errors;
}
`,
    },
    assertions: [
      {
        label: "Shared isValidEmail helper exists",
        check: (files) => {
          const src = files["src/utils/validate.ts"] || "";
          return src.includes("function isValidEmail") && src.includes("EMAIL_REGEX");
        },
      },
    ],
    timeout: 120,
  },
];
