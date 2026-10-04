// Seeded, deterministic random numbers. Pure. Never use Math.random() for anything the user can
// see persist (roads, buildings, trees, entity routes): use an Rng from a derived seed instead.

/** mulberry32: tiny, fast, good enough for procedural content. Returns a float in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a seed with a string label, so systems get independent streams: rngFor(SEED, 'trees'). */
export function hashSeed(seed: number, label: string): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** Integer hash of a few ints, for stateless per-item variety (e.g. building i's colour). */
export function hash3(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** Derived generator: `new Rng(seed).fork('label')` style, without consuming this stream. */
  static for(seed: number, label: string): Rng {
    return new Rng(hashSeed(seed, label));
  }
  /** [0, 1) */
  float(): number {
    return this.next();
  }
  /** [lo, hi) */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Approximately normal (sum of 3 uniforms), mean 0, sd ≈ 1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }
}
