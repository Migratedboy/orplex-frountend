// rate-limit-store.ts — Injectable store for rate limiting
// Swap adapters by environment: InMemory (dev), Redis (prod), NoOp (tests)

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  get(key: string): RateLimitEntry | null;
  set(key: string, entry: RateLimitEntry): void;
  delete(key: string): void;
  cleanup(): void;
}

// === In-Memory Store (dev, default) ===

export class InMemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, RateLimitEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(autoCleanup = true) {
    if (autoCleanup) {
      this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    }
  }

  get(key: string): RateLimitEntry | null {
    return this.store.get(key) || null;
  }

  set(key: string, entry: RateLimitEntry): void {
    this.store.set(key, entry);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  cleanup(): void {
    const now = Date.now();
    Array.from(this.store.entries()).forEach(([key, value]) => {
      if (now > value.resetAt) this.store.delete(key);
    });
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// === No-Op Store (tests — allows everything) ===

export class NoOpRateLimitStore implements RateLimitStore {
  get(_key: string): RateLimitEntry | null {
    return null;
  }
  set(_key: string, _entry: RateLimitEntry): void {}
  delete(_key: string): void {}
  cleanup(): void {}
}

// === Factory ===

let sharedStore: RateLimitStore | null = null;

export function getRateLimitStore(): RateLimitStore {
  if (sharedStore) return sharedStore;

  const env = process.env.NODE_ENV;
  if (env === "test") {
    sharedStore = new NoOpRateLimitStore();
  } else {
    sharedStore = new InMemoryRateLimitStore();
  }
  return sharedStore;
}

// For testing: reset the shared store
export function resetRateLimitStore(): void {
  if (sharedStore && "destroy" in sharedStore) {
    (sharedStore as InMemoryRateLimitStore).destroy();
  }
  sharedStore = null;
}
