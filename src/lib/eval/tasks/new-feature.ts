import type { EvalTask } from "../types";

/**
 * New feature tasks — the agent must implement missing functionality
 * that's partially scaffolded or described by interface/type definitions.
 */
export const newFeatureTasks: EvalTask[] = [
  // ── FEAT-001 ────────────────────────────────────────────────────
  {
    id: "FEAT-001",
    name: "Implement debounce utility",
    description:
      "A debounce function signature exists but the body is empty. " +
      "The agent must implement it correctly with timer cleanup.",
    category: "new-feature",
    difficulty: "easy",
    fixInstruction:
      "Implement the debounce function in src/utils/debounce.ts — it should " +
      "delay invoking fn until delayMs after the last call. Include proper " +
      "cleanup via a cancel method.",
    initialFiles: [
      {
        path: "src/utils/debounce.ts",
        content: `export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delayMs: number
): T & { cancel: () => void } {
  // TODO: implement debounce
  throw new Error("Not implemented");
}
`,
      },
    ],
    expectedFiles: {
      "src/utils/debounce.ts": `export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delayMs: number
): T & { cancel: () => void } {
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Parameters<T>) => {
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(() => {
      fn(...args);
      timerId = null;
    }, delayMs);
  };

  debounced.cancel = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  return debounced as T & { cancel: () => void };
}
`,
    },
    assertions: [
      {
        label: "Uses setTimeout/clearTimeout",
        check: (files) => {
          const src = files["src/utils/debounce.ts"] || "";
          return src.includes("setTimeout") && src.includes("clearTimeout");
        },
      },
      {
        label: "Has cancel method",
        check: (files) => {
          const src = files["src/utils/debounce.ts"] || "";
          return src.includes("cancel");
        },
      },
    ],
    timeout: 120,
  },

  // ── FEAT-002 ────────────────────────────────────────────────────
  {
    id: "FEAT-002",
    name: "Implement retry with exponential backoff",
    description:
      "A retry function needs to be implemented with exponential backoff " +
      "and jitter to avoid thundering herd.",
    category: "new-feature",
    difficulty: "medium",
    fixInstruction:
      "Implement the retryWithBackoff function in src/utils/retry.ts — it " +
      "should retry the given async function up to maxRetries times with " +
      "exponential backoff (baseDelay * 2^attempt) plus random jitter.",
    initialFiles: [
      {
        path: "src/utils/retry.ts",
        content: `export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  // TODO: implement with exponential backoff + jitter
  throw new Error("Not implemented");
}
`,
      },
    ],
    expectedFiles: {
      "src/utils/retry.ts": `export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * baseDelay;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
`,
    },
    assertions: [
      {
        label: "Uses exponential backoff (2^attempt)",
        check: (files) => {
          const src = files["src/utils/retry.ts"] || "";
          return src.includes("Math.pow(2") || src.includes("** attempt") || src.includes("2 **");
        },
      },
      {
        label: "Includes jitter (random component)",
        check: (files) => {
          const src = files["src/utils/retry.ts"] || "";
          return src.includes("Math.random");
        },
      },
    ],
    timeout: 120,
  },

  // ── FEAT-003 ────────────────────────────────────────────────────
  {
    id: "FEAT-003",
    name: "Implement a simple LRU cache",
    description:
      "An LRU cache class needs to be implemented with get/set operations " +
      "that maintain access order and evict the least recently used entry " +
      "when capacity is exceeded.",
    category: "new-feature",
    difficulty: "hard",
    fixInstruction:
      "Implement the LruCache class in src/utils/lru-cache.ts — it should " +
      "support get(key), set(key, value), and evict the least recently used " +
      "entry when capacity is exceeded. Use a Map for O(1) access.",
    initialFiles: [
      {
        path: "src/utils/lru-cache.ts",
        content: `export class LruCache<K, V> {
  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    // TODO: implement
    throw new Error("Not implemented");
  }

  set(key: K, value: V): void {
    // TODO: implement
    throw new Error("Not implemented");
  }

  get size(): number {
    return 0;
  }
}
`,
      },
    ],
    expectedFiles: {
      "src/utils/lru-cache.ts": `export class LruCache<K, V> {
  private cache = new Map<K, V>();

  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    // Move to end (most recently used)
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Evict least recently used (first entry)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }
}
`,
    },
    assertions: [
      {
        label: "Uses Map for O(1) operations",
        check: (files) => {
          const src = files["src/utils/lru-cache.ts"] || "";
          return src.includes("new Map");
        },
      },
      {
        label: "Evicts LRU entry when at capacity",
        check: (files) => {
          const src = files["src/utils/lru-cache.ts"] || "";
          return src.includes("capacity") && src.includes("delete");
        },
      },
    ],
    timeout: 120,
  },
];
