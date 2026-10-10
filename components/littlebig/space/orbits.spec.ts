import { describe, expect, it } from 'vitest';
import { R } from '../world/config';
import { dodge, LAYER, ORBITS, orbitSpeed, orbitState, sunlit } from './orbits';

const v = () => ({ x: 0, y: 0, z: 0 });

describe('space layer orbits', () => {
  it('has a station and 8–12 satellites with stable, unique ids', () => {
    expect(ORBITS.filter((o) => o.kind === 'station').map((o) => o.id)).toEqual(['station:0']);
    const sats = ORBITS.filter((o) => o.kind === 'satellite');
    expect(sats.length).toBeGreaterThanOrEqual(8);
    expect(sats.length).toBeLessThanOrEqual(12);
    sats.forEach((o, i) => expect(o.id).toBe(`satellite:${i}`));
    expect(new Set(ORBITS.map((o) => o.model)).size).toBe(ORBITS.length);
  });

  it('every body stays inside the space layer, whole', () => {
    for (const o of ORBITS) {
      expect(o.alt - o.radius).toBeGreaterThanOrEqual(LAYER.min);
      expect(o.alt + o.radius).toBeLessThanOrEqual(LAYER.max);
    }
  });

  it('no two bodies can ever meet (their shells are apart)', () => {
    const s = ORBITS.slice().sort((a, b) => a.alt - b.alt);
    for (let i = 1; i < s.length; i++) expect(s[i].alt - s[i - 1].alt).toBeGreaterThanOrEqual(s[i].radius + s[i - 1].radius + 4);
  });

  it('positions are on the orbit sphere, smooth and match the velocity', () => {
    const p = v();
    const q = v();
    const vel = v();
    for (const o of ORBITS) {
      for (let t = 0; t < 600; t += 37) {
        orbitState(o, t, p, vel);
        expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(R + o.alt, 6);
        expect(Math.hypot(vel.x, vel.y, vel.z)).toBeCloseTo(orbitSpeed(o), 6);
        orbitState(o, t + 1e-3, q);
        expect((q.x - p.x) / 1e-3).toBeCloseTo(vel.x, 1);
      }
    }
  });

  it('inclined, varied orbits', () => {
    const incl = new Set(ORBITS.map((o) => Math.round(o.incl / 10)));
    expect(incl.size).toBeGreaterThanOrEqual(7);
    expect(ORBITS.some((o) => o.incl > 90)).toBe(true);
  });

  it('dodge keeps every body clear of an eye sitting on its path', () => {
    const p = v();
    const vel = v();
    const off = v();
    for (const o of ORBITS) {
      // Eye placed on the orbit, 3 s ahead of the body; walk the body past it.
      const eye = v();
      orbitState(o, 3, eye);
      // Slightly off the exact path, both ways, plus exactly on it.
      for (const lift of [0, 0.4, -0.4]) {
        const e = { x: eye.x * (1 + lift / (R + o.alt)), y: eye.y * (1 + lift / (R + o.alt)), z: eye.z * (1 + lift / (R + o.alt)) };
        let prev: { x: number; y: number; z: number } | null = null;
        for (let t = 0; t < 6; t += 1 / 60) {
          orbitState(o, t, p, vel);
          const s = Math.hypot(vel.x, vel.y, vel.z);
          const f = { x: vel.x / s, y: vel.y / s, z: vel.z / s };
          dodge(p, f, e, o.radius, 3, off);
          const q = { x: p.x + off.x, y: p.y + off.y, z: p.z + off.z };
          expect(Math.hypot(q.x - e.x, q.y - e.y, q.z - e.z)).toBeGreaterThan(o.radius + 1.5);
          if (prev) expect(Math.hypot(q.x - prev.x, q.y - prev.y, q.z - prev.z)).toBeLessThan(orbitSpeed(o) / 60 + 1.2);
          prev = q;
        }
      }
    }
  });

  it('the planet shadows the night side', () => {
    const sun = { x: 1, y: 0, z: 0 };
    expect(sunlit({ x: 200, y: 0, z: 0 }, sun)).toBe(1);
    expect(sunlit({ x: -200, y: 0, z: 0 }, sun)).toBe(0);
    expect(sunlit({ x: -100, y: R + 40, z: 0 }, sun)).toBe(1);
  });
});
