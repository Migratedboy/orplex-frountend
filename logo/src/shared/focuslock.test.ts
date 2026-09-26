import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampDuration,
  crossedSecondBoundary,
  formatRemaining,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  parseAppState,
  parseStartTimerRequest,
  widgetGeometry,
  widgetWindowGeometry,
} from './focuslock';

test('clampDuration keeps in-range values and clamps the rest', () => {
  assert.equal(clampDuration(5_000), 5_000);
  assert.equal(clampDuration(3_600_000), 3_600_000);
  assert.equal(clampDuration(MIN_DURATION_MS), MIN_DURATION_MS);
  assert.equal(clampDuration(MAX_DURATION_MS), MAX_DURATION_MS);
});

test('clampDuration handles out-of-range and junk inputs', () => {
  assert.equal(clampDuration(1), MIN_DURATION_MS);
  assert.equal(clampDuration(0), MIN_DURATION_MS);
  assert.equal(clampDuration(-100), MIN_DURATION_MS);
  assert.equal(clampDuration(Number.MAX_SAFE_INTEGER), MAX_DURATION_MS);
  assert.equal(clampDuration(Number.NaN), MIN_DURATION_MS);
  assert.equal(clampDuration(Number.POSITIVE_INFINITY), MIN_DURATION_MS);
  assert.equal(clampDuration(1500.7), 5000);
});

test('formatRemaining renders zero-padded HH:MM:SS', () => {
  assert.equal(formatRemaining(0), '00:00:00');
  assert.equal(formatRemaining(999), '00:00:01');
  assert.equal(formatRemaining(59_000), '00:00:59');
  assert.equal(formatRemaining(60_000), '00:01:00');
  assert.equal(formatRemaining(3_600_000), '01:00:00');
  assert.equal(formatRemaining(3_600_000 + 61_000), '01:01:01');
  assert.equal(formatRemaining(-5_000), '00:00:00');
});

test('crossedSecondBoundary fires once per second step', () => {
  const endAt = 100_000;
  assert.equal(crossedSecondBoundary(endAt, 90_000, 90_400), false);
  assert.equal(crossedSecondBoundary(endAt, 90_400, 90_800), false);
  assert.equal(crossedSecondBoundary(endAt, 90_800, 91_200), true);
  assert.equal(crossedSecondBoundary(endAt, 91_200, 91_600), false);
  assert.equal(crossedSecondBoundary(endAt, 99_900, 100_500), true);
  assert.equal(crossedSecondBoundary(endAt, 100_500, 100_900), false);
});

test('widgetGeometry is a circle when idle and a capsule when locked', () => {
  const idle = widgetGeometry('idle');
  assert.deepEqual(idle, { width: 64, height: 64, borderRadius: 32 });
  const locked = widgetGeometry('locked');
  assert.deepEqual(locked, { width: 172, height: 64, borderRadius: 32 });
});

test('widgetWindowGeometry pads the shape for the glow bleed', () => {
  assert.deepEqual(widgetWindowGeometry('idle'), { width: 104, height: 104 });
  assert.deepEqual(widgetWindowGeometry('locked'), { width: 212, height: 104 });
});

test('parseStartTimerRequest accepts valid payloads and rejects junk', () => {
  assert.deepEqual(
    parseStartTimerRequest({ durationMs: 60_000, strictMode: false, mode: 'lockdown', pinHwnd: null }),
    { durationMs: 60_000, strictMode: false, mode: 'lockdown', pinHwnd: null }
  );
  assert.deepEqual(
    parseStartTimerRequest({ durationMs: 60_000, strictMode: true, mode: 'class', pinHwnd: '123456' }),
    { durationMs: 60_000, strictMode: true, mode: 'class', pinHwnd: '123456' }
  );
  assert.equal(parseStartTimerRequest(null), null);
  assert.equal(parseStartTimerRequest('nope'), null);
  assert.equal(
    parseStartTimerRequest({ durationMs: 'x', strictMode: true, mode: 'class', pinHwnd: null }),
    null
  );
  assert.equal(
    parseStartTimerRequest({ durationMs: 1000, strictMode: false, pinHwnd: null }),
    null
  );
  assert.equal(
    parseStartTimerRequest({ durationMs: 1000, strictMode: false, mode: 'party', pinHwnd: null }),
    null
  );
  assert.equal(
    parseStartTimerRequest({ durationMs: 1000, strictMode: false, mode: 'class', pinHwnd: 7 }),
    null
  );
});

test('parseAppState validates phase and numeric fields', () => {
  assert.deepEqual(
    parseAppState({
      phase: 'idle',
      endAt: null,
      startedAt: null,
      strictMode: false,
      mode: 'class',
      pinHwnd: null,
    }),
    { phase: 'idle', endAt: null, startedAt: null, strictMode: false, mode: 'class', pinHwnd: null }
  );
  assert.deepEqual(
    parseAppState({
      phase: 'locked',
      endAt: 123,
      startedAt: 0,
      strictMode: true,
      mode: 'lockdown',
      pinHwnd: null,
    }),
    {
      phase: 'locked',
      endAt: 123,
      startedAt: 0,
      strictMode: true,
      mode: 'lockdown',
      pinHwnd: null,
    }
  );
  assert.equal(
    parseAppState({ phase: 'bogus', endAt: null, startedAt: null, strictMode: false, mode: 'class', pinHwnd: null }),
    null
  );
  assert.equal(
    parseAppState({ phase: 'locked', endAt: 'x', startedAt: null, strictMode: false, mode: 'class', pinHwnd: null }),
    null
  );
  assert.equal(
    parseAppState({ phase: 'locked', endAt: 123, startedAt: 0, strictMode: true, mode: 'lockdown', pinHwnd: 5 }),
    null
  );
});
