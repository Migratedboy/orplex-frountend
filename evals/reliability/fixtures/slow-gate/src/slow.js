// Deliberately slow: ~250ms per call. Used to measure gate latency, not correctness.
export function slowSquare(n) {
  const end = Date.now() + 250;
  while (Date.now() < end) { /* burn */ }
  return n * n;
}
