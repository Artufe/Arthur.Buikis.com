import { describe, expect, it } from 'vitest';
import { getCityIndex, getCityPlan } from '../world/city';
import { fromSphere } from '../world/city/frame';
import { obbDistance } from '../world/city/index-grid';
import { CITY_SURFACE_R } from '../world/config';
import { buildBuilding } from './buildings';
import { Geo } from './geo';
import { buildProps } from './props';

describe('city geometry', () => {
  const plan = getCityPlan();

  it('keeps every building inside its plan box (collision and the camera rely on it)', () => {
    const p = { x: 0, y: 0, z: 0 };
    const q = { x: 0, z: 0 };
    for (const b of plan.buildings) {
      const g = new Geo(4096);
      buildBuilding(g, b, 0);
      expect(g.n).toBeGreaterThan(24);
      let worstOut = 0;
      let worstUp = -Infinity;
      for (let i = 0; i < g.n; i++) {
        p.x = g.pos[i * 3];
        p.y = g.pos[i * 3 + 1];
        p.z = g.pos[i * 3 + 2];
        fromSphere(p, q);
        worstOut = Math.max(worstOut, obbDistance(b, q.x, q.z));
        worstUp = Math.max(worstUp, Math.hypot(p.x, p.y, p.z) - CITY_SURFACE_R);
      }
      // planBasis' second-order error (≈ 7 cm at the corners of a 14 × 10 m box) is the only slack.
      expect(worstOut, `building ${b.id} (${b.style}) pokes ${worstOut.toFixed(2)} m out of its box`).toBeLessThan(0.12);
      // Thin props may rise ≤ 3 m above the roof; the local frame is the tangent plane at the
      // footprint centre, which sits up to d²/2R above the sphere at the corners.
      const tangent = (Math.hypot(b.w, b.d) / 2) ** 2 / (2 * CITY_SURFACE_R);
      expect(worstUp, `building ${b.id} (${b.style}) rises ${(worstUp - b.h).toFixed(2)} m above its roof`).toBeLessThan(b.h + 3 + tangent + 0.02);
    }
  });

  it('hangs every awning against its facade: no vertex more than 1.6 m from the wall run', () => {
    let count = 0;
    for (const b of plan.buildings) {
      const g = new Geo(4096);
      g.awnings = [];
      buildBuilding(g, b, 0);
      for (const a of g.awnings) {
        count++;
        const w = a.wall;
        let worst = 0;
        for (let i = a.v0; i < a.v1; i++) {
          const px = g.pos[i * 3], py = g.pos[i * 3 + 1], pz = g.pos[i * 3 + 2];
          let best = Infinity;
          for (let k = 0; k + 5 < w.length; k += 3) {
            const dx = w[k + 3] - w[k], dy = w[k + 4] - w[k + 1], dz = w[k + 5] - w[k + 2];
            const l2 = dx * dx + dy * dy + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((px - w[k]) * dx + (py - w[k + 1]) * dy + (pz - w[k + 2]) * dz) / l2));
            best = Math.min(best, Math.hypot(w[k] + dx * t - px, w[k + 1] + dy * t - py, w[k + 2] + dz * t - pz));
          }
          worst = Math.max(worst, best);
        }
        expect(worst, `building ${b.id} (${b.style}): an awning vertex hangs ${worst.toFixed(2)} m off its facade`).toBeLessThan(1.6);
      }
    }
    expect(count).toBeGreaterThan(10);
  });

  it('builds the street furniture and garden edges with consistent attributes', () => {
    const g = new Geo(4096);
    buildProps(g, plan, getCityIndex(), () => 0.5);
    expect(g.n).toBeGreaterThan(1000);
    expect(g.ni % 3).toBe(0);
    let maxIdx = 0;
    for (let i = 0; i < g.ni; i++) maxIdx = Math.max(maxIdx, g.idx[i]);
    expect(maxIdx).toBeLessThan(g.n);
    let minRev = Infinity;
    for (let i = 0; i < g.n; i++) minRev = Math.min(minRev, g.rev[i]);
    expect(minRev).toBeGreaterThanOrEqual(0.5);
    const geo = g.toGeometry();
    expect(geo.getAttribute('aInfo').count).toBe(g.n);
    expect(geo.getAttribute('aBase').count).toBe(g.n);
    geo.dispose();
  });
});
