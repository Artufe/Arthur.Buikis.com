// Frame timing: a ring buffer of frame intervals and CPU costs, plus per-system update costs.
// Zero allocation per frame.

const N = 600;

export interface PerfSummary {
  frames: number;
  /** rAF interval statistics (ms). Quantised by vsync; use the debug hook's perf() for real cost. */
  median: number;
  p95: number;
  max: number;
  /** CPU time of update + render submission (ms). */
  cpuMedian: number;
  cpuMax: number;
}

export class Perf {
  private readonly intervals = new Float32Array(N);
  private readonly cpu = new Float32Array(N);
  private count = 0;
  private head = 0;
  /** Smoothed per-system update cost (ms), keyed by system name. */
  readonly systemMs: Record<string, number> = {};

  push(intervalMs: number, cpuMs: number) {
    this.intervals[this.head] = intervalMs;
    this.cpu[this.head] = cpuMs;
    this.head = (this.head + 1) % N;
    if (this.count < N) this.count++;
  }

  system(name: string, ms: number) {
    const prev = this.systemMs[name] ?? ms;
    this.systemMs[name] = prev + (ms - prev) * 0.05;
  }

  reset() {
    this.count = 0;
    this.head = 0;
  }

  summarize(): PerfSummary {
    const n = this.count;
    const a = Array.from(this.intervals.subarray(0, n)).sort((x, y) => x - y);
    const c = Array.from(this.cpu.subarray(0, n)).sort((x, y) => x - y);
    const q = (arr: number[], f: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * f))] : 0);
    return { frames: n, median: q(a, 0.5), p95: q(a, 0.95), max: q(a, 1), cpuMedian: q(c, 0.5), cpuMax: q(c, 1) };
  }
}
