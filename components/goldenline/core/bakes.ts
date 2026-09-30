// [polish] Boot bakes off the main thread. The engine calls prefetchBakes() before it asks for
// the GPU device, so the heavy CPU bakes (limb meshing, sand tiles, foam texture, swell field)
// run in parallel on a small worker pool while the main thread initialises everything else,
// and the loading screen keeps painting. Results are cached (packed) for the page's lifetime,
// so reopening the window skips them. If workers are unavailable, jobs run inline.

import { JOBS, PREFETCH, type JobName, type JobResult } from './bake-jobs';
import { pack, unpack } from './bake-pack';

/** A macrotask boundary: lets the browser paint (the loading screen) between chunks of boot work. */
export const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));

type Pending = { resolve(v: unknown): void; reject(e: unknown): void };
const WATCHDOG_MS = 12000;
const cache = new Map<string, Promise<unknown>>();
const pending = new Map<number, Pending>();
let pool: Worker[] | null = null;
const queue: number[] = [];
const busy = new Map<Worker, number>();
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let inlineOnly = false;

function ensurePool(): Worker[] | null {
  if (pool || inlineOnly) return pool;
  if (typeof Worker === 'undefined') {
    inlineOnly = true;
    return null;
  }
  const n = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
  try {
    pool = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module', name: 'goldenline-bake' });
      w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; r?: unknown; err?: string; ms?: number }>) => {
        busy.delete(w);
        const job = jobsById.get(e.data.id);
        timeline.push({ job: job ? job[0] : '?', ms: Math.round(e.data.ms ?? 0), at: Math.round(performance.now()) });
        pump();
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.r);
        else p.reject(new Error(e.data.err));
        scheduleIdle();
      };
      w.onerror = (e) => {
        e.preventDefault();
        // A worker that fails to load: fall back to inline for everything still waiting on it.
        console.warn('[goldenline] bake worker failed; running bakes inline', e.message);
        failPool();
      };
      pool.push(w);
    }
  } catch (e) {
    console.warn('[goldenline] bake workers unavailable; running bakes inline', e);
    failPool();
  }
  return pool;
}

const jobsById = new Map<number, [JobName, number[]]>();
/** Worker timings (job, worker ms, main-thread arrival time), for the boot report. */
export const timeline: Array<{ job: string; ms: number; at: number }> = [];
if (typeof window !== 'undefined') (window as unknown as { __bakes?: unknown }).__bakes = timeline;
function failPool() {
  inlineOnly = true;
  if (pool) for (const w of pool) w.terminate();
  pool = null;
  queue.length = 0;
  busy.clear();
  for (const [id, p] of pending) {
    const job = jobsById.get(id);
    pending.delete(id);
    if (!job) continue;
    try {
      p.resolve(runInline(job[0], job[1]));
    } catch (e) {
      p.reject(e);
    }
  }
}

/** Hand queued jobs to idle workers, in prefetch order (longest first). */
function pump() {
  if (!pool) return;
  for (const w of pool) {
    if (!queue.length) return;
    if (busy.has(w)) continue;
    const id = queue.shift()!;
    const job = jobsById.get(id)!;
    busy.set(w, id);
    w.postMessage({ id, name: job[0], args: job[1] });
  }
}

function runInline(name: JobName, args: number[]) {
  const r = (JOBS[name] as (...a: number[]) => unknown)(...args);
  return pack(r, []);
}

/** Terminate the pool once it has been idle for a while (the window may reopen later). */
function scheduleIdle() {
  if (pending.size > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size > 0 || !pool) return;
    for (const w of pool) w.terminate();
    pool = null;
    busy.clear();
  }, 5000);
}

function start(name: JobName, args: number[]): Promise<unknown> {
  const key = `${name}(${args.join(',')})`;
  let p = cache.get(key);
  if (p) return p;
  const workers = ensurePool();
  if (!workers) {
    p = new Promise((resolve) => setTimeout(resolve, 0)).then(() => runInline(name, args));
  } else {
    const id = nextId++;
    jobsById.set(id, [name, args]);
    p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    queue.push(id);
    pump();
    // Watchdog: a worker that never answers (failed chunk load without an error event, a hung
    // thread) must not leave the loading screen spinning forever. Run the job inline instead.
    setTimeout(() => {
      const w = pending.get(id);
      if (!w) return;
      pending.delete(id);
      const qi = queue.indexOf(id);
      if (qi >= 0) queue.splice(qi, 1);
      console.warn(`[goldenline] bake "${name}" timed out in its worker; running it inline`);
      try {
        w.resolve(runInline(name, args));
      } catch (e) {
        w.reject(e);
      }
    }, WATCHDOG_MS);
  }
  // A failed bake must not stay cached.
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  return p;
}

/** Start every boot bake now (idempotent). */
export function prefetchBakes() {
  timeline.push({ job: 'prefetch', ms: 0, at: Math.round(performance.now()) });
  for (const [name, args] of PREFETCH) start(name, args);
}

/** A bake's result, as fresh three objects (textures and geometries are the caller's to dispose). */
export async function bake<N extends JobName>(name: N, ...args: number[]): Promise<JobResult<N>> {
  const packed = await start(name, args);
  return unpack<JobResult<N>>(packed);
}
