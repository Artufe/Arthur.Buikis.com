import { describe, expect, it } from 'vitest';
import { coverageAt, createCrossing, CROSS_TIMING, CROSS_TIMING_RM, type CrossTiming, frontRange, resetCrossing, Stage, stepCrossing } from './crossing';

const ASPECT = 1.6;

/** Fraction of the frame the overlay covers (a grid of samples), for a focus of expansion at uv. */
function area(s: ReturnType<typeof createCrossing>, fx: number, fy: number): number {
  const rg = frontRange(fx, fy, ASPECT, { x: 0, y: 0 });
  let sum = 0;
  let n = 0;
  for (let j = 0; j < 20; j++) {
    for (let i = 0; i < 32; i++) {
      const r = Math.hypot(((i + 0.5) / 32 - fx) * ASPECT, (j + 0.5) / 20 - fy);
      sum += coverageAt(s, (r - rg.x) / (rg.y - rg.x));
      n++;
    }
  }
  return sum / n;
}

/** Frame-by-frame state after one trigger at t = 0 (or at each of `triggerAt`). */
function run(fps: number, seconds: number, opts: { triggerAt?: number[]; contact?: (t: number) => number; clear?: (t: number) => boolean; timing?: CrossTiming; foe?: [number, number]; sign?: number } = {}) {
  const { triggerAt = [0], contact = () => 0, clear = () => false, timing = CROSS_TIMING, foe = [0.5, 0.5], sign = 1 } = opts;
  const s = createCrossing();
  const dt = 1 / fps;
  const out: Array<{ t: number; centre: number; corner: number; area: number; cover: number; stage: number }> = [];
  for (let i = 0; i * dt < seconds; i++) {
    const t = i * dt;
    stepCrossing(s, dt, triggerAt.some((x) => Math.abs(x - t) < dt / 2), contact(t), timing, clear(t), sign);
    out.push({ t, centre: coverageAt(s, 0.02), corner: coverageAt(s, 1), area: area(s, foe[0], foe[1]), cover: s.cover, stage: s.stage });
  }
  return out;
}

describe('falling through the clouds', () => {
  for (const fps of [30, 60, 144]) {
    it(`a one-frame crossing covers the frame for ~0.25 s, eased (${fps} fps)`, () => {
      const f = run(fps, 2);
      const covered = f.filter((x) => x.area >= 0.5).length / fps;
      // "Like 0.25 s": at least that, and not the long white wall it once was.
      expect(covered).toBeGreaterThanOrEqual(0.25);
      expect(covered).toBeLessThanOrEqual(0.4);
      // Eased: no frame-to-frame step steeper than the smoothstep ramps allow (peak slope 1.5).
      const maxStep = 1.55 / fps / Math.min(CROSS_TIMING.tIn, CROSS_TIMING.tOut);
      for (let i = 1; i < f.length; i++) expect(Math.abs(f[i].cover - f[i - 1].cover)).toBeLessThanOrEqual(maxStep);
      // Back to clear: within the three stages, plus a frame.
      const end = CROSS_TIMING.tIn + CROSS_TIMING.hold + CROSS_TIMING.tOut + 2 / fps;
      expect(f.filter((x) => x.t > end).every((x) => x.stage === Stage.Idle && x.cover === 0)).toBe(true);
    });
  }

  // Wherever the eye flies (the focus of expansion in frame, at a corner, off any side), the reveal
  // plays out on screen: from covered to clear over at least 8 frames at 30 fps, never a cut.
  for (const [foe, sign] of [[[0.5, 0.5], 1], [[0, 0], 1], [[0.5, -0.3], 1], [[-0.3, 0.6], 1], [[1.3, 1.3], 1], [[0.5, 0.5], -1], [[0.5, 0.1], -1]] as Array<[[number, number], number]>) {
    it(`the reveal is never a cut (focus at ${foe.join(', ')}${sign < 0 ? ', backward' : ''})`, () => {
      const f = run(30, 2, { foe, sign });
      const lastFull = f.findLastIndex((x) => x.area >= 0.9);
      const firstClear = f.findIndex((x, i) => i > lastFull && x.area <= 0.02);
      expect(lastFull).toBeGreaterThan(0);
      expect(firstClear - lastFull).toBeGreaterThanOrEqual(8);
      // And no single frame removes more than a fifth of the frame's cloud.
      for (let i = lastFull + 1; i <= firstClear; i++) expect(f[i - 1].area - f[i].area).toBeLessThanOrEqual(0.2);
    });
  }

  // The fill is seen too: the puffs bloom out of the point the eye flies into over several frames
  // (at tIn = 0.08 s a 30 fps clip went from clear to covered in one frame).
  for (const foe of [[0.5, 0.5], [0.8, 0.3], [-0.3, 0.6]] as Array<[number, number]>) {
    for (const sign of [1, -1]) {
      it(`the fill is never a cut (focus at ${foe.join(', ')}, ${sign > 0 ? 'forward' : 'backward'})`, () => {
        const f = run(30, 2, { foe, sign });
        const first = f.findIndex((x) => x.area > 0.01);
        const full = f.findIndex((x) => x.area >= 0.9);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(full - first).toBeGreaterThanOrEqual(4);
        for (let i = first + 1; i <= full; i++) expect(f[i].area - f[i - 1].area).toBeLessThanOrEqual(0.4);
      });
    }
  }

  it('flying backward, the cloud closes in from the corners and shrinks away into the focus', () => {
    const f = run(60, 2, { sign: -1 });
    const firstCorner = f.findIndex((x) => x.corner > 0.5);
    const firstCentre = f.findIndex((x) => x.centre > 0.5);
    expect(firstCorner).toBeGreaterThanOrEqual(0);
    expect(firstCentre).toBeGreaterThan(firstCorner);
    const k = f.findIndex((x) => x.stage === Stage.Out);
    const cornerClear = f.findIndex((x, i) => i > k && x.corner < 0.05);
    const centreClear = f.findIndex((x, i) => i > k && x.centre < 0.05);
    expect(cornerClear).toBeGreaterThan(0);
    expect(centreClear).toBeGreaterThan(cornerClear);
  });

  it('opens from the focus of expansion outward (the centre clears before the corners)', () => {
    const f = run(60, 2);
    const firstCentreClear = f.findIndex((x, i) => i > 10 && x.centre < 0.05);
    const firstCornerClear = f.findIndex((x, i) => i > 10 && x.corner < 0.05);
    expect(firstCentreClear).toBeGreaterThan(0);
    expect(firstCornerClear).toBeGreaterThan(firstCentreClear);
  });

  it('a second crossing while it opens closes it again without a dip (never a double white-out)', () => {
    const t2 = CROSS_TIMING.tIn + CROSS_TIMING.hold + CROSS_TIMING.tOut * 0.4;
    const f = run(60, 3, { triggerAt: [0, t2] });
    const i2 = f.findIndex((x) => x.t >= t2 - 1e-9);
    // From the re-trigger until covered again, coverage at the corner never drops.
    for (let i = i2 + 1; i < f.length && f[i].stage !== 2; i++) expect(f[i].corner).toBeGreaterThanOrEqual(f[i - 1].corner - 1e-9);
    // One episode: no idle frame between the two triggers.
    expect(f.slice(0, i2).some((x) => x.stage === Stage.Idle)).toBe(false);
  });

  it('holds while the eye stays inside a puff, then eases out', () => {
    const f = run(60, 4, { contact: (t) => (t < 2 ? 1 : 0) });
    expect(f.filter((x) => x.t > 0.2 && x.t < 2).every((x) => x.centre > 0.9)).toBe(true);
    expect(f[f.length - 1].stage).toBe(Stage.Idle);
  });

  it('well clear of the layer, the hold ends as soon as the frame is covered', () => {
    const f = run(60, 2, { clear: () => true });
    const full = f.findIndex((x) => x.cover >= 0.98);
    const opening = f.findIndex((x) => x.stage === Stage.Out);
    expect(full).toBeGreaterThanOrEqual(0);
    // (Within two 60 fps frames: the fill's last 2 % and one frame to turn round.)
    expect(opening - full).toBeLessThanOrEqual(2);
  });

  it('reduced motion: a slow fade in (no brightness flash)', () => {
    const f = run(60, 2, { timing: CROSS_TIMING_RM });
    const half = f.findIndex((x) => x.cover >= 0.5);
    expect(half / 60).toBeGreaterThanOrEqual(0.08);
    for (let i = 1; i < f.length; i++) expect(f[i].cover - f[i - 1].cover).toBeLessThanOrEqual(0.15);
  });

  it('a teleport ends it at once', () => {
    const s = createCrossing();
    stepCrossing(s, 0.1, true, 0);
    resetCrossing(s);
    expect(s.cover).toBe(0);
    expect(coverageAt(s, 0.5)).toBe(0);
  });
});
