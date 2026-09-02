import type { EvalTask } from "../types";

/**
 * Type error tasks — the agent must fix TypeScript compilation failures.
 * Each task has a broken file that won't compile, and the agent must
 * repair the types to make it compile cleanly.
 */
export const typeErrorTasks: EvalTask[] = [
  // ── TS-001 ──────────────────────────────────────────────────────
  {
    id: "TS-001",
    name: "Nullable map key",
    description:
      "A utility function passes a nullable Map key to .get() and .set(). " +
      "TypeScript rejects this because the key type doesn't include null.",
    category: "type-error",
    difficulty: "easy",
    fixInstruction:
      "Fix the TypeScript error in src/utils/cache.ts — the function passes a " +
      "nullable value to Map.get() and Map.set(), but Map's key type is string. " +
      "Add a null guard before accessing the map.",
    initialFiles: [
      {
        path: "src/utils/cache.ts",
        content: `const cache = new Map<string, string>();

export function getCacheKey(input: string | null): string | undefined {
  const cached = cache.get(input);
  if (cached) return cached;

  const result = computeKey(input);
  cache.set(input, result);
  return result;
}

function computeKey(input: string | null): string {
  return input?.trim().toLowerCase() || "default";
}
`,
      },
    ],
    expectedFiles: {
      "src/utils/cache.ts": `const cache = new Map<string, string>();

export function getCacheKey(input: string | null): string | undefined {
  if (input === null) return undefined;
  const cached = cache.get(input);
  if (cached) return cached;

  const result = computeKey(input);
  cache.set(input, result);
  return result;
}

function computeKey(input: string | null): string {
  return input?.trim().toLowerCase() || "default";
}
`,
    },
    assertions: [
      {
        label: "Null guard present before map access",
        check: (files) => {
          const src = files["src/utils/cache.ts"] || "";
          return src.includes("input === null") || src.includes("input == null") || src.includes("if (!input)");
        },
      },
    ],
    timeout: 120,
  },

  // ── TS-002 ──────────────────────────────────────────────────────
  {
    id: "TS-002",
    name: "Implicit any on reduce callback",
    description:
      "An array reduce call has untyped accumulator and current parameters, " +
      "causing an implicit-any error under strict TypeScript.",
    category: "type-error",
    difficulty: "easy",
    fixInstruction:
      "Fix the TypeScript errors in src/utils/stats.ts — the reduce callback " +
      "parameters have implicit 'any' types. Add explicit type annotations.",
    initialFiles: [
      {
        path: "src/utils/stats.ts",
        content: `interface DataPoint {
  label: string;
  value: number;
}

export function sumValues(data: DataPoint[]): number {
  return data.reduce((acc, item) => acc + item.value, 0);
}

export function groupByLabel(data: DataPoint[]): Record<string, number[]> {
  return data.reduce((acc, item) => {
    if (!acc[item.label]) acc[item.label] = [];
    acc[item.label].push(item.value);
    return acc;
  }, {});
}
`,
      },
    ],
    expectedFiles: {
      "src/utils/stats.ts": `interface DataPoint {
  label: string;
  value: number;
}

export function sumValues(data: DataPoint[]): number {
  return data.reduce((acc: number, item: DataPoint) => acc + item.value, 0);
}

export function groupByLabel(data: DataPoint[]): Record<string, number[]> {
  return data.reduce((acc: Record<string, number[]>, item: DataPoint) => {
    if (!acc[item.label]) acc[item.label] = [];
    acc[item.label].push(item.value);
    return acc;
  }, {});
}
`,
    },
    assertions: [
      {
        label: "reduce callbacks have explicit types",
        check: (files) => {
          const src = files["src/utils/stats.ts"] || "";
          return src.includes("acc: number") && src.includes("acc: Record<string, number[]>");
        },
      },
    ],
    timeout: 120,
  },

  // ── TS-003 ──────────────────────────────────────────────────────
  {
    id: "TS-003",
    name: "Mismatched return type on async function",
    description:
      "An async function claims to return string but actually returns a Promise<string>. " +
      "The caller doesn't await it, leading to a type mismatch downstream.",
    category: "type-error",
    difficulty: "medium",
    fixInstruction:
      "Fix the type error in src/services/fetcher.ts — fetchData is async but its " +
      "return type annotation says string instead of Promise<string>. Also fix the " +
      "caller in src/services/consumer.ts which doesn't await the async call.",
    initialFiles: [
      {
        path: "src/services/fetcher.ts",
        content: `export async function fetchData(url: string): string {
  const res = await fetch(url);
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.text();
}
`,
      },
      {
        path: "src/services/consumer.ts",
        content: `import { fetchData } from "./fetcher";

export function loadConfig(): string {
  const text = fetchData("/api/config");
  return text.toUpperCase();
}
`,
      },
    ],
    expectedFiles: {
      "src/services/fetcher.ts": `export async function fetchData(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.text();
}
`,
      "src/services/consumer.ts": `import { fetchData } from "./fetcher";

export async function loadConfig(): Promise<string> {
  const text = await fetchData("/api/config");
  return text.toUpperCase();
}
`,
    },
    assertions: [
      {
        label: "fetchData returns Promise<string>",
        check: (files) => {
          const src = files["src/services/fetcher.ts"] || "";
          return src.includes("Promise<string>");
        },
      },
      {
        label: "consumer awaits the call",
        check: (files) => {
          const src = files["src/services/consumer.ts"] || "";
          return src.includes("await fetchData");
        },
      },
    ],
    timeout: 120,
  },

  // ── TS-004 ──────────────────────────────────────────────────────
  {
    id: "TS-004",
    name: "Incorrect keyof usage",
    description:
      "A helper function uses keyof on a value instead of a type, causing " +
      "'keyof' to be applied to an expression rather than a type.",
    category: "type-error",
    difficulty: "medium",
    fixInstruction:
      "Fix the type error in src/utils/objects.ts — the pick function uses " +
      "keyof incorrectly. It should accept a generic type parameter and use " +
      "keyof T as the key constraint.",
    initialFiles: [
      {
        path: "src/utils/objects.ts",
        content: `export function pick(obj, keys) {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

// Usage
const user = { name: "Alice", age: 30, email: "a@b.com" };
const picked = pick(user, ["name", "email"]);
`,
      },
    ],
    expectedFiles: {
      "src/utils/objects.ts": `export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

// Usage
const user = { name: "Alice", age: 30, email: "a@b.com" };
const picked = pick(user, ["name", "email"]);
`,
    },
    assertions: [
      {
        label: "pick uses generic type parameter",
        check: (files) => {
          const src = files["src/utils/objects.ts"] || "";
          return src.includes("<T") && src.includes("keyof T");
        },
      },
      {
        label: "Return type is Pick<T, K>",
        check: (files) => {
          const src = files["src/utils/objects.ts"] || "";
          return src.includes("Pick<T, K>");
        },
      },
    ],
    timeout: 120,
  },

  // ── TS-005 ──────────────────────────────────────────────────────
  {
    id: "TS-005",
    name: "Optional chaining on non-optional",
    description:
      "Code uses optional chaining on a value that TypeScript infers as " +
      "never-undefined, combined with a wrong type narrowing.",
    category: "type-error",
    difficulty: "easy",
    fixInstruction:
      "Fix the TypeScript issue in src/models/user.ts — the function narrows " +
      "with typeof but then accesses a property that doesn't exist on the type. " +
      "Fix the type guard and property access.",
    initialFiles: [
      {
        path: "src/models/user.ts",
        content: `interface User {
  id: number;
  name: string;
  profile?: { avatar: string };
}

export function getAvatar(user: User): string {
  if (typeof user === "string") {
    return user.avatar;
  }
  return user.profile?.avatar || "/default.png";
}
`,
      },
    ],
    expectedFiles: {
      "src/models/user.ts": `interface User {
  id: number;
  name: string;
  profile?: { avatar: string };
}

export function getAvatar(user: User): string {
  return user.profile?.avatar || "/default.png";
}
`,
    },
    assertions: [
      {
        label: "No string check on User type",
        check: (files) => {
          const src = files["src/models/user.ts"] || "";
          return !src.includes('typeof user === "string"');
        },
      },
    ],
    timeout: 120,
  },

  // ── TS-006 ──────────────────────────────────────────────────────
  {
    id: "TS-006",
    name: "Strict null checks with union type",
    description:
      "A function accepts string | null but accesses .length without narrowing, " +
      "which fails under strictNullChecks.",
    category: "type-error",
    difficulty: "easy",
    fixInstruction:
      "Fix the TypeScript error in src/utils/format.ts — truncateText accesses " +
      ".length on a string | null parameter without narrowing first.",
    initialFiles: [
      {
        path: "src/utils/format.ts",
        content: `export function truncateText(text: string | null, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
`,
      },
    ],
    expectedFiles: {
      "src/utils/format.ts": `export function truncateText(text: string | null, maxLen: number): string {
  if (text === null) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
`,
    },
    assertions: [
      {
        label: "Null check before .length access",
        check: (files) => {
          const src = files["src/utils/format.ts"] || "";
          return (src.includes("text === null") || src.includes("text == null") || src.includes("!text")) &&
            src.includes("maxLen");
        },
      },
    ],
    timeout: 120,
  },

  // ── TS-007 ──────────────────────────────────────────────────────
  {
    id: "TS-007",
    name: "Excess property check on object literal",
    description:
      "An object literal is passed to a function expecting a narrower type, " +
      "and contains an extra property not in the interface.",
    category: "type-error",
    difficulty: "medium",
    fixInstruction:
      "Fix the TypeScript error in src/config/loader.ts — createAppConfig passes " +
      "an object with 'debug' and 'verbose' properties that aren't in the AppConfig " +
      "interface. Remove the extra properties or extend the interface.",
    initialFiles: [
      {
        path: "src/config/loader.ts",
        content: `interface AppConfig {
  port: number;
  host: string;
  env: "development" | "production";
}

function createAppConfig(overrides: Partial<AppConfig>): AppConfig {
  return {
    port: 3000,
    host: "localhost",
    env: "development",
    ...overrides,
  };
}

export const config = createAppConfig({
  port: 5000,
  debug: true,
  verbose: true,
});
`,
      },
    ],
    expectedFiles: {
      "src/config/loader.ts": `interface AppConfig {
  port: number;
  host: string;
  env: "development" | "production";
  debug?: boolean;
  verbose?: boolean;
}

function createAppConfig(overrides: Partial<AppConfig>): AppConfig {
  return {
    port: 3000,
    host: "localhost",
    env: "development",
    ...overrides,
  };
}

export const config = createAppConfig({
  port: 5000,
  debug: true,
  verbose: true,
});
`,
    },
    assertions: [
      {
        label: "AppConfig includes debug and verbose",
        check: (files) => {
          const src = files["src/config/loader.ts"] || "";
          return src.includes("debug") && src.includes("verbose");
        },
      },
    ],
    timeout: 120,
  },

  // ── TS-008 ──────────────────────────────────────────────────────
  {
    id: "TS-008",
    name: "Enum used as value and type inconsistently",
    description:
      "Code imports an enum value but uses it where a type is expected, " +
      "or vice versa, causing a TS error.",
    category: "type-error",
    difficulty: "medium",
    fixInstruction:
      "Fix the TypeScript errors in src/models/status.ts — the enum is used " +
      "incorrectly in the matchStatus function. The switch cases compare the " +
      "string value against the enum, which works, but the return type annotation " +
      "uses the enum value as a type. Fix the type annotation.",
    initialFiles: [
      {
        path: "src/models/status.ts",
        content: `export enum TaskStatus {
  Pending = "pending",
  Running = "running",
  Done = "done",
  Failed = "failed",
}

export function matchStatus(status: string): TaskStatus {
  switch (status) {
    case "pending": return TaskStatus.Pending;
    case "running": return TaskStatus.Running;
    case "done": return TaskStatus.Done;
    case "failed": return TaskStatus.Failed;
    default: throw new Error(\`Unknown status: \${status}\`);
  }
}

export function isActive(status: TaskStatus): boolean {
  return status === TaskStatus.Running || status === TaskStatus.Pending;
}
`,
      },
    ],
    expectedFiles: {
      "src/models/status.ts": `export enum TaskStatus {
  Pending = "pending",
  Running = "running",
  Done = "done",
  Failed = "failed",
}

export function matchStatus(status: string): TaskStatus {
  switch (status) {
    case "pending": return TaskStatus.Pending;
    case "running": return TaskStatus.Running;
    case "done": return TaskStatus.Done;
    case "failed": return TaskStatus.Failed;
    default: throw new Error(\`Unknown status: \${status}\`);
  }
}

export function isActive(status: TaskStatus): boolean {
  return status === TaskStatus.Running || status === TaskStatus.Pending;
}
`,
    },
    assertions: [
      {
        label: "matchStatus returns TaskStatus type",
        check: (files) => {
          const src = files["src/models/status.ts"] || "";
          return src.includes("TaskStatus") && src.includes("switch");
        },
      },
    ],
    timeout: 120,
  },

  // ── TS-009 ──────────────────────────────────────────────────────
  {
    id: "TS-009",
    name: "Generic constraint violation",
    description:
      "A generic function uses a method that doesn't exist on the constrained type.",
    category: "type-error",
    difficulty: "hard",
    fixInstruction:
      "Fix the TypeScript errors in src/utils/async.ts — the allSettled function " +
      "calls .json() on the result, but the generic T is only constrained to " +
      "Promise<unknown>, which doesn't have .json(). Add a more specific constraint " +
      "or handle the unknown type properly.",
    initialFiles: [
      {
        path: "src/utils/async.ts",
        content: `export async function allSettled<T extends Promise<unknown>>(
  promises: T[]
): Promise<Awaited<T>[]> {
  const results = await Promise.allSettled(promises);
  return results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    throw r.reason;
  });
}

// Usage
const responses = await allSettled([
  fetch("/api/users"),
  fetch("/api/posts"),
]);
const data = responses.map((r) => r.json());
`,
      },
    ],
    expectedFiles: {
      "src/utils/async.ts": `export async function allSettled<T extends Promise<Response>>(
  promises: T[]
): Promise<Awaited<T>[]> {
  const results = await Promise.allSettled(promises);
  return results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    throw r.reason;
  });
}

// Usage
const responses = await allSettled([
  fetch("/api/users"),
  fetch("/api/posts"),
]);
const data = responses.map((r) => r.json());
`,
    },
    assertions: [
      {
        label: "Generic constrained to Response",
        check: (files) => {
          const src = files["src/utils/async.ts"] || "";
          return src.includes("Promise<Response>");
        },
      },
    ],
    timeout: 120,
  },

  // ── TS-010 ──────────────────────────────────────────────────────
  {
    id: "TS-010",
    name: "Type assertion needed for JSON.parse",
    description:
      "JSON.parse returns any, and downstream code accesses a property that " +
      "TypeScript can't verify exists on the inferred type.",
    category: "type-error",
    difficulty: "medium",
    fixInstruction:
      "Fix the TypeScript errors in src/utils/parse.ts — parseConfig uses JSON.parse " +
      "and then accesses .settings without a type assertion. Define an interface for " +
      "the config shape and use a type assertion or validation.",
    initialFiles: [
      {
        path: "src/utils/parse.ts",
        content: `export function parseConfig(raw: string) {
  const parsed = JSON.parse(raw);
  return {
    port: parsed.settings.port,
    host: parsed.settings.host,
  };
}
`,
      },
    ],
    expectedFiles: {
      "src/utils/parse.ts": `interface ConfigSettings {
  port: number;
  host: string;
}

interface ParsedConfig {
  settings: ConfigSettings;
}

export function parseConfig(raw: string): ConfigSettings {
  const parsed: ParsedConfig = JSON.parse(raw);
  return {
    port: parsed.settings.port,
    host: parsed.settings.host,
  };
}
`,
    },
    assertions: [
      {
        label: "Interface defined for config shape",
        check: (files) => {
          const src = files["src/utils/parse.ts"] || "";
          return src.includes("interface") && src.includes("JSON.parse");
        },
      },
    ],
    timeout: 120,
  },
];
