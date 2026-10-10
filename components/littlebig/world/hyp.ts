// Math.hypot without the allocation. V8's builtin collects its arguments into a fresh array on every
// call (~40 B), and per-frame code calls it thousands of times. These are V8's own algorithm (the
// max-scaled, Kahan-compensated sum of squares) for two and three finite values, so every result
// is bit-identical to Math.hypot's and the seeded sims replay exactly (hyp.spec.ts checks it).

/** Math.hypot(a, b), bit for bit, for finite a and b. */
export function hyp(a: number, b: number): number {
  const m = Math.max(Math.abs(a), Math.abs(b));
  if (m === 0) return 0;
  const na = a / m;
  const nb = b / m;
  return Math.sqrt(na * na + nb * nb) * m;
}

/** Math.hypot(a, b, c), bit for bit, for finite a, b and c. */
export function hyp3(a: number, b: number, c: number): number {
  const m = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (m === 0) return 0;
  const n0 = a / m;
  const n1 = b / m;
  const n2 = c / m;
  const s0 = n0 * n0;
  const t1 = n1 * n1;
  const s1 = s0 + t1;
  const comp = s1 - s0 - t1;
  return Math.sqrt(s1 + (n2 * n2 - comp)) * m;
}
