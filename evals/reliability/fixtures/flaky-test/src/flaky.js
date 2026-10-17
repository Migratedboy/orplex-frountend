let n = 0;
export function flakyAdd(a, b) {
  // Deterministic pseudo-flake: fails on every 3rd call => ~33% failure rate.
  n += 1;
  const shouldFail = n % 3 === 0;
  return shouldFail ? a + b + 1 : a + b;
}
export function callCount() { return n; }
