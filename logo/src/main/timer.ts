import type { AppState, SessionMode } from '../shared/focuslock';

export interface TimerEngineEvents {
  onStateChanged(state: AppState): void;
  onExpired(finished: AppState): void;
}

/**
 * Authoritative countdown state machine. Lives in the main process so
 * renderers can never influence the remaining time.
 */
export class TimerEngine {
  private state: AppState = {
    phase: 'idle',
    endAt: null,
    startedAt: null,
    strictMode: false,
    mode: 'lockdown',
    pinHwnd: null,
  };
  private tickInterval: NodeJS.Timeout | null = null;

  constructor(private readonly events: TimerEngineEvents) {}

  getState(): AppState {
    return { ...this.state };
  }

  isLocked(): boolean {
    return this.state.phase === 'locked';
  }

  start(
    durationMs: number,
    strictMode: boolean,
    mode: SessionMode,
    pinHwnd: string | null
  ): AppState {
    const startedAt = Date.now();
    const endAt = startedAt + durationMs;
    this.state = { phase: 'locked', endAt, startedAt, strictMode, mode, pinHwnd };
    this.ensureTick();
    this.emit();
    return this.getState();
  }

  /** Re-adopt a persisted session that is still in the future (re-lock on restart). */
  restore(
    endAt: number,
    startedAt: number,
    strictMode: boolean,
    mode: SessionMode,
    pinHwnd: string | null
  ): boolean {
    const now = Date.now();
    if (endAt <= now || startedAt <= 0 || endAt <= startedAt) return false;
    this.state = { phase: 'locked', endAt, startedAt, strictMode, mode, pinHwnd };
    this.ensureTick();
    this.emit();
    return true;
  }

  clear(): void {
    this.stopTick();
    this.state = {
      phase: 'idle',
      endAt: null,
      startedAt: null,
      strictMode: false,
      mode: 'lockdown',
      pinHwnd: null,
    };
    this.emit();
  }

  private ensureTick(): void {
    if (this.tickInterval !== null) return;
    this.tickInterval = setInterval(() => {
      const { endAt } = this.state;
      if (endAt === null) return;
      if (Date.now() >= endAt) {
        const finished = this.getState();
        this.clear();
        this.events.onExpired(finished);
      }
    }, 250);
    this.tickInterval.unref();
  }

  private stopTick(): void {
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  private emit(): void {
    this.events.onStateChanged(this.getState());
  }
}
