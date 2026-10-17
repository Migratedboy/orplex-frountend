export function taxExclusive(amount, rate) {
  // Bug: adds tax instead of subtracting it. NO existing test covers this.
  return amount + amount * rate;
}
export function round2(n) {
  return Math.round(n * 100) / 100;
}
