export function bytesToMB(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) return 0;
  return bytes / (1024 * 1024);
}

export function formatMB(bytes: number, decimals = 1): string {
  const mb = bytesToMB(bytes);
  if (mb >= 10) return Math.round(mb).toString();
  return mb.toFixed(decimals);
}

export function formatSpeed(bps: number): string {
  const mb = bytesToMB(bps);
  if (!Number.isFinite(mb) || mb <= 0) return "0.0";
  return mb.toFixed(1);
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

export function smoothSpeed(prev: number, next: number, alpha = 0.3): number {
  if (prev <= 0) return next;
  if (!Number.isFinite(next) || next <= 0) return prev;
  return prev * (1 - alpha) + next * alpha;
}