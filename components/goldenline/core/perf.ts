// Frame-time statistics with no per-frame allocation. The overlay reads summaries on a
// throttled interval; per-system CPU cost comes from begin()/end() around each update.

const RING = 600; // 10 s at 60 FPS

export interface PerfSummary {
  median: number;
  p99: number; // the "1% low" as a frame time (ms)
  fps: number;
  low1: number; // 1% low as FPS
  max: number;
  hitches: number; // frames over median + 4 ms in the window
}

export class Perf {
  readonly frames = new Float32Array(RING);
  head = 0;
  count = 0;
  /** Per-system CPU ms, smoothed. Keys are fixed at registration, so no allocation later. */
  readonly systemMs: Record<string, number> = {};
  /** Per-pass GPU ms when timestamp queries are available (filled by the post owner). */
  readonly gpuMs: Record<string, number> = {};
  private readonly sorted = new Float32Array(RING);
  private t0 = 0;
  readonly summary: PerfSummary = { median: 0, p99: 0, fps: 0, low1: 0, max: 0, hitches: 0 };

  register(name: string) {
    this.systemMs[name] = 0;
  }

  pushFrame(ms: number) {
    this.frames[this.head] = ms;
    this.head = (this.head + 1) % RING;
    if (this.count < RING) this.count++;
  }

  begin() {
    this.t0 = performance.now();
  }

  end(name: string) {
    const ms = performance.now() - this.t0;
    this.systemMs[name] = this.systemMs[name] * 0.9 + ms * 0.1;
  }

  reset() {
    this.head = 0;
    this.count = 0;
  }

  /** Recompute the summary. Call at a throttled rate (e.g. 4 Hz), not every frame. */
  summarize(): PerfSummary {
    const n = this.count;
    const s = this.summary;
    if (n === 0) return s;
    for (let i = 0; i < n; i++) this.sorted[i] = this.frames[i];
    const view = this.sorted.subarray(0, n);
    view.sort();
    s.median = view[n >> 1];
    s.p99 = view[Math.min(n - 1, Math.floor(n * 0.99))];
    s.max = view[n - 1];
    s.fps = s.median > 0 ? 1000 / s.median : 0;
    s.low1 = s.p99 > 0 ? 1000 / s.p99 : 0;
    let h = 0;
    const limit = s.median + 4;
    for (let i = 0; i < n; i++) if (this.frames[i] > limit) h++;
    s.hitches = h;
    return s;
  }
}
