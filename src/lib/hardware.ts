// hardware.ts — RAM watchdog + pressure ladder for low-spec hosts.
//
// The 8GB target machine (i5-8350U, 7.88GB usable) has no useful OOM signal:
// Windows swaps, then kills whichever process it likes. This module watches
// system-wide memory (os.freemem/totalmem — other apps count, they compete
// for the same RAM) and walks a response ladder BEFORE the OS acts:
//
//   ≥70% used ("elevated") — visible on the System page, no action
//   ≥85% ("high")          — no new browser-verify lanes; executor pauses
//                            claiming new runs (queued runs stay queued)
//   ≥92% ("critical")      — sustained ≥3 checks (~30s): fire critical
//                            actions (kill Chromium, run the janitor,
//                            checkpoint executor state). Latching per
//                            episode: fires once, resets below high.
//
// The watchdog interval is unref'd so it never keeps the process alive.
// State lives on globalThis (dev bundles would otherwise each see their own
// watchdog — same rationale as runtime-state).

import os from "os";
import { runtimeState } from "./runtime-state";

export type MemoryPressure = "ok" | "elevated" | "high" | "critical";

export const RAM_THRESHOLDS = {
  elevated: 0.7,
  high: 0.85,
  critical: 0.92,
} as const;

/** Critical must persist this many consecutive checks before actions fire. */
export const CRITICAL_STREAK = 3;

interface HardwareState {
  pressure: MemoryPressure;
  lastCheckAt: string | null;
  usedRatio: number;
  rssBytes: number;
  freememBytes: number;
  totalBytes: number;
  criticalStreak: number;
  criticalFired: boolean;
  paused: boolean;
  lastAction: string | null;
}

const GLOBAL_KEY = "__orplexHardwareState";

function state(): HardwareState {
  const g = globalThis as unknown as { [GLOBAL_KEY]?: HardwareState };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      pressure: "ok",
      lastCheckAt: null,
      usedRatio: 0,
      rssBytes: 0,
      freememBytes: 0,
      totalBytes: 0,
      criticalStreak: 0,
      criticalFired: false,
      paused: false,
      lastAction: null,
    };
  }
  return g[GLOBAL_KEY];
}

/** Test hook: reset all hardware state. */
export function resetHardwareState(): void {
  const g = globalThis as unknown as { [GLOBAL_KEY]?: HardwareState };
  delete g[GLOBAL_KEY];
}

export interface PressureAction {
  (pressure: MemoryPressure, usedRatio: number): void | Promise<void>;
}

const highActions: PressureAction[] = [];
const criticalActions: PressureAction[] = [];

/** Register a callback fired once when pressure crosses into "high". */
export function onHighPressure(fn: PressureAction): void {
  highActions.push(fn);
}

/** Register a callback fired once per critical episode (after the streak). */
export function onCriticalPressure(fn: PressureAction): void {
  criticalActions.push(fn);
}

export interface PressureReading {
  pressure: MemoryPressure;
  usedRatio: number;
  rssBytes: number;
  freememBytes: number;
  totalBytes: number;
  /** True when the executor should stop claiming new runs. */
  paused: boolean;
  lastAction: string | null;
  criticalStreak: number;
}

function classify(usedRatio: number): MemoryPressure {
  if (usedRatio >= RAM_THRESHOLDS.critical) return "critical";
  if (usedRatio >= RAM_THRESHOLDS.high) return "high";
  if (usedRatio >= RAM_THRESHOLDS.elevated) return "elevated";
  return "ok";
}

/**
 * One watchdog tick. Pure with respect to the injected readings — the
 * watchdog passes real os values; tests inject whatever they need.
 * Fire-and-forget safety: action callbacks are awaited so a slow janitor
 * can't stack ticks behind itself.
 */
export async function checkMemoryPressure(
  reading: { freememBytes: number; totalBytes: number; rssBytes?: number } = {
    freememBytes: os.freemem(),
    totalBytes: os.totalmem(),
    rssBytes: process.memoryUsage().rss,
  },
): Promise<PressureReading> {
  const s = state();
  const total = reading.totalBytes > 0 ? reading.totalBytes : 1;
  const usedRatio = Math.min(1, Math.max(0, 1 - reading.freememBytes / total));
  const next = classify(usedRatio);

  // Critical streak: consecutive checks at/above critical. The critical
  // episode latches — actions fire once, and only reset once we drop below
  // "high" again (hysteresis, so 92.0%↔91.9% flapping can't refire).
  if (next === "critical") {
    s.criticalStreak += 1;
  } else {
    s.criticalStreak = 0;
  }
  if (next !== "critical" && next !== "high") {
    s.criticalFired = false;
  }

  s.pressure = next;
  s.usedRatio = usedRatio;
  s.rssBytes = reading.rssBytes ?? 0;
  s.freememBytes = reading.freememBytes;
  s.totalBytes = reading.totalBytes;
  s.lastCheckAt = new Date().toISOString();

  // Mirror into the shared runtime state for the System page.
  const hw = runtimeState.hardware;
  hw.pressure = next;
  hw.lastCheckAt = s.lastCheckAt;
  hw.usedRatio = usedRatio;
  hw.rssBytes = s.rssBytes;
  hw.freememBytes = s.freememBytes;
  hw.totalBytes = s.totalBytes;

  if (next === "high" || next === "critical") {
    if (!s.paused) {
      s.paused = true;
      s.lastAction = "paused executor claims + browser lanes";
      const { recordRuntimeLog } = await import("./runtime-log");
      recordRuntimeLog("server", "warn", `memory pressure ${next} (${Math.round(usedRatio * 100)}%) — run claiming paused, browser verify suspended`);
      console.warn(`[hardware] memory pressure ${next} (${Math.round(usedRatio * 100)}%) — pausing new run claims and browser lanes`);
      for (const fn of highActions) await Promise.resolve(fn(next, usedRatio)).catch(() => {});
    }
  } else if (s.paused) {
    s.paused = false;
    const { recordRuntimeLog } = await import("./runtime-log");
    recordRuntimeLog("server", "info", `memory recovered (${Math.round(usedRatio * 100)}%) — run claiming resumed`);
    console.log(`[hardware] memory recovered (${Math.round(usedRatio * 100)}%) — resuming`);
  }

  if (next === "critical" && s.criticalStreak >= CRITICAL_STREAK && !s.criticalFired) {
    s.criticalFired = true;
    s.lastAction = "critical actions fired";
    const { recordRuntimeLog } = await import("./runtime-log");
    recordRuntimeLog("server", "error", `critical memory ${Math.round(usedRatio * 100)}% sustained ${s.criticalStreak} checks — firing critical actions (janitor, lane kill)`);
    console.error(`[hardware] CRITICAL memory ${Math.round(usedRatio * 100)}% sustained — firing critical actions`);
    for (const fn of criticalActions) await Promise.resolve(fn(next, usedRatio)).catch(() => {});
  }

  return {
    pressure: s.pressure,
    usedRatio: s.usedRatio,
    rssBytes: s.rssBytes,
    freememBytes: s.freememBytes,
    totalBytes: s.totalBytes,
    paused: s.paused,
    lastAction: s.lastAction,
    criticalStreak: s.criticalStreak,
  };
}

/** Cheap synchronous check for admission decisions (no tick side effects). */
export function currentMemoryPressure(): MemoryPressure {
  return state().pressure;
}

/** Executor loop asks this before claiming. */
export function isClaimsPaused(): boolean {
  return state().paused;
}

/** Verify-lane admission: suspend the (heaviest) browser lane under pressure. */
export function isMemoryPressureHigh(): boolean {
  const p = state().pressure;
  return p === "high" || p === "critical";
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** Start the RAM watchdog. Idempotent; interval is unref'd. */
export function startMemoryWatchdog(intervalMs = 10_000): void {
  if (watchdogTimer) return;
  if (typeof process === "undefined" || process.env.NODE_ENV === "test") return;
  watchdogTimer = setInterval(() => {
    void checkMemoryPressure().catch(() => {});
  }, intervalMs);
  if (watchdogTimer.unref) watchdogTimer.unref();
  console.log(`[hardware] memory watchdog started (${Math.round(intervalMs / 1000)}s interval, thresholds ${RAM_THRESHOLDS.elevated * 100}/${RAM_THRESHOLDS.high * 100}/${RAM_THRESHOLDS.critical * 100}%)`);
}

export function stopMemoryWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/** Snapshot for the admin System page / API. */
export function getHardwareStatus(): PressureReading & { thresholds: typeof RAM_THRESHOLDS } {
  const s = state();
  return {
    pressure: s.pressure,
    usedRatio: s.usedRatio,
    rssBytes: s.rssBytes,
    freememBytes: s.freememBytes,
    totalBytes: s.totalBytes,
    paused: s.paused,
    lastAction: s.lastAction,
    criticalStreak: s.criticalStreak,
    thresholds: RAM_THRESHOLDS,
  };
}
