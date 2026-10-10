import { describe, expect, it } from 'vitest';
import { layoutClouds } from '../clouds/layout';
import { getCityIndex } from '../world/city';
import { CITY_PLAN_RADIUS, CLOUD_MIN, PLANE_MAX, PLANE_MIN, PLATEAU_HEIGHT, R, SEED } from '../world/config';
import { CITY_DIR } from '../world/sun';
import { angleBetween, len3, v3, type Vec3 } from '../world/sphere';
import { BALLOON_RADIUS, BALLOON_TOP, BALLOON_BELLY, BALLOONS, balloonAt, dodge, dodgeAcross, newBalloon, newPose, PLANE_LAP, PLANE_OMEGA, planePose, ROUTES } from './routes';

// Planes share one angular speed and their weave / wobble are whole multiples of θ, so the sky is
// periodic: one lap covers every encounter, forever. Balloons are quasi-periodic: a long run.
const SPAN = 3600;
const STEP = 0.05;

describe('air routes', () => {
  it('keeps every plane inside the plane band', () => {
    const p = newPose();
    for (const r of ROUTES) {
      for (let t = 0; t < 600; t += 0.37) {
        const h = len3(planePose(r, t, p).pos) - R;
        expect(h).toBeGreaterThanOrEqual(PLANE_MIN);
        expect(h).toBeLessThanOrEqual(PLANE_MAX);
      }
    }
  });

  it('is periodic: one lap later every plane is exactly where it was', () => {
    const a = newPose();
    const b = newPose();
    for (const r of ROUTES) {
      expect(r.omega).toBe(PLANE_OMEGA);
      for (let t = 0; t < PLANE_LAP; t += 7.3) {
        planePose(r, t, a);
        planePose(r, t + PLANE_LAP * 13, b);
        expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z)).toBeLessThan(1e-6 * 13 * PLANE_LAP);
      }
    }
  });

  it('never lets two planes overlap on screen: ≥ 18 m apart horizontally at every moment (no stacking)', () => {
    const poses = ROUTES.map(newPose);
    let min = Infinity;
    for (let t = 0; t < PLANE_LAP; t += STEP) {
      ROUTES.forEach((r, i) => planePose(r, t, poses[i]));
      for (let i = 0; i < poses.length; i++)
        for (let j = i + 1; j < poses.length; j++) min = Math.min(min, angleBetween(poses[i].pos, poses[j].pos) * (R + 70));
    }
    expect(min).toBeGreaterThan(18);
  });

  it('spreads overhead passes: a plane crosses the town every 15-50 s, never two together', () => {
    // Times of closest approach to the city centre (within 70 m of arc: over the town) over one lap.
    const p = newPose();
    const passes: number[] = [];
    for (const r of ROUTES) {
      let best = Infinity;
      let bestT = 0;
      for (let t = 0; t < PLANE_LAP; t += 0.25) {
        const d = angleBetween(planePose(r, t, p).pos, CITY_DIR) * R;
        if (d < best) [best, bestT] = [d, t];
      }
      if (best < 70) passes.push(bestT);
    }
    expect(passes.length).toBeGreaterThanOrEqual(3);
    passes.sort((x, y) => x - y);
    const gaps = passes.map((t, i) => (i + 1 < passes.length ? passes[i + 1] : passes[0] + PLANE_LAP) - t);
    expect(Math.min(...gaps)).toBeGreaterThan(15);
    expect(Math.max(...gaps)).toBeLessThan(50);
  });

  it('flies over every cloud: the lowest belly clears the tallest crown (bulges included)', () => {
    const l = layoutClouds({ seed: SEED, clusters: 30 });
    let crown = 0;
    for (let i = 0; i < l.count; i++) {
      const o = i * 4;
      crown = Math.max(crown, Math.hypot(l.puffs[o], l.puffs[o + 1], l.puffs[o + 2]) - R + 1.3 * l.puffs[o + 3]);
    }
    const p = newPose();
    let low = Infinity;
    for (const r of ROUTES) for (let t = 0; t < 600; t += 0.37) low = Math.min(low, len3(planePose(r, t, p).pos) - R - 2 * r.scale);
    expect(low).toBeGreaterThan(crown);
  });

  it('moves smoothly: no jumps, no flips, banks within the cap', () => {
    const a = newPose();
    const b = newPose();
    for (const r of ROUTES) {
      let maxBank = 0;
      for (let t = 0; t < 400; t += 0.5) {
        planePose(r, t, a);
        planePose(r, t + 1 / 60, b);
        const step = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
        expect(step).toBeLessThan(0.5); // ≤ 30 m/s
        expect(a.fwd.x * b.fwd.x + a.fwd.y * b.fwd.y + a.fwd.z * b.fwd.z).toBeGreaterThan(0.999);
        expect(a.up.x * b.up.x + a.up.y * b.up.y + a.up.z * b.up.z).toBeGreaterThan(0.999);
        maxBank = Math.max(maxBank, Math.abs(a.bank));
      }
      expect(maxBank).toBeGreaterThan(0.12); // it visibly banks (> 7°)
      expect(maxBank).toBeLessThanOrEqual(0.55);
    }
  });

});

describe('balloons', () => {
  const idx = getCityIndex();
  const s = BALLOONS.map(newBalloon);

  it('stay on the plateau, under the cloud base and clear of every roof and mast', () => {
    for (let t = 0; t < 2400; t += 0.5) {
      BALLOONS.forEach((b, i) => {
        const st = balloonAt(b, t, s[i]);
        expect(Math.hypot(st.x, st.z)).toBeLessThan(CITY_PLAN_RADIUS - 2);
        expect(PLATEAU_HEIGHT + st.h + BALLOON_TOP * b.scale).toBeLessThanOrEqual(CLOUD_MIN - 2);
        // Roofs (props ≤ 3 m) under the basket and under the whole envelope.
        const basket = idx.maxRoofNear(st.x, st.z, 1.5);
        const env = idx.maxRoofNear(st.x, st.z, BALLOON_RADIUS * b.scale + 1);
        expect(st.h).toBeGreaterThan(basket + 4);
        expect(st.h + 1.9 * b.scale).toBeGreaterThan(env + 4);
      });
    }
  });

  it('never touch each other', () => {
    let min = Infinity;
    for (let t = 0; t < SPAN; t += 0.5) {
      BALLOONS.forEach((b, i) => balloonAt(b, t, s[i]));
      for (let i = 0; i < s.length; i++)
        for (let j = i + 1; j < s.length; j++) {
          const d = Math.hypot(s[i].x - s[j].x, s[i].z - s[j].z, s[i].h + BALLOON_BELLY * BALLOONS[i].scale - s[j].h - BALLOON_BELLY * BALLOONS[j].scale);
          min = Math.min(min, d - BALLOON_RADIUS * (BALLOONS[i].scale + BALLOONS[j].scale));
        }
    }
    expect(min).toBeGreaterThan(1.5);
  });
});

describe('dodge', () => {
  it('keeps the eye at least dmin away and is continuous', () => {
    const p = v3(0, 0, 0);
    const out = v3();
    let prev = -1;
    for (let x = -30; x <= 30; x += 0.05) {
      const eye = v3(x, 0.3, 0);
      dodge(p, eye, 8, 24, out);
      const d = Math.hypot(p.x + out.x - eye.x, p.y + out.y - eye.y, p.z + out.z - eye.z);
      expect(d).toBeGreaterThanOrEqual(7.99);
      if (prev >= 0 && Math.abs(x) > 1) expect(Math.abs(d - prev)).toBeLessThan(0.1);
      prev = d;
    }
  });
});

describe('dodgeAcross', () => {
  it('lets a plane on a collision course slide past the eye: clear, continuous, no whip', () => {
    // A plane at 16 m/s flying straight at (or just beside) an eye hovering 64 m up.
    const fwd = v3(1, 0, 0);
    const out = v3();
    const dt = 1 / 60;
    for (const miss of [0, 0.1, 0.6, 2, 5]) {
      const eye = v3(0, 224, miss);
      let minD = Infinity;
      let maxAcc = 0;
      const P: Vec3[] = [];
      for (let t = -3; t <= 3; t += dt) {
        const p = v3(16 * t, 224, 0);
        dodgeAcross(p, fwd, eye, 9, 27, out);
        const q = v3(p.x + out.x, p.y + out.y, p.z + out.z);
        minD = Math.min(minD, Math.hypot(q.x - eye.x, q.y - eye.y, q.z - eye.z));
        P.push(q);
      }
      for (let i = 1; i < P.length - 1; i++) {
        const a = P[i - 1], b = P[i], c = P[i + 1];
        maxAcc = Math.max(maxAcc, Math.hypot(c.x - 2 * b.x + a.x, c.y - 2 * b.y + a.y, c.z - 2 * b.z + a.z) / (dt * dt));
      }
      expect(minD).toBeGreaterThan(8.6);
      expect(maxAcc).toBeLessThan(40); // ≈ 24 m/s²; the straight-away push whipped at ~3.5 km/s²
    }
  });
});
