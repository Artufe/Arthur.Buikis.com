// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { LBContext } from '../core/contracts';
import { getPlanet } from '../world/planet';
import { R } from '../world/config';
import { BALLOONS, newPose, planePose, ROUTES } from './routes';
import { BALLOON_CARDS, balloonDetail, overPlace, PLANE_CARDS, planeDetail } from './track';

// The few context fields the live lines read.
const ctx = {
  time: { render: 0 },
  world: { planet: getPlanet() },
  services: { labels: { list: () => [{ id: 'capital', text: 'bigtown', kind: 'capital', dir: getPlanet().cityDir, h: 2, minAlt: 0, maxAlt: 1e3 }] } },
} as unknown as LBContext;

describe('planes and balloons as trackables', () => {
  it('has a distinct card for every plane and balloon', () => {
    expect(PLANE_CARDS.length).toBeGreaterThanOrEqual(ROUTES.length);
    expect(BALLOON_CARDS.length).toBeGreaterThanOrEqual(BALLOONS.length);
    const labels = [...PLANE_CARDS, ...BALLOON_CARDS].map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const c of [...PLANE_CARDS, ...BALLOON_CARDS]) expect(c.label + c.sub).toBe((c.label + c.sub).toLowerCase());
  });

  it('reads a sensible live line round a whole lap, and names the capital when over it', { timeout: 30000 }, () => {
    const seen = new Set<string>();
    for (let t = 0; t < 90; t += 0.5) {
      (ctx.time as { render: number }).render = t;
      for (let i = 0; i < ROUTES.length; i++) {
        const d = planeDetail(ctx, i);
        expect(d).toMatch(/^alt \d+ m · \d+ km\/h · over [a-z ]+$/);
        seen.add(d.replace(/.* over /, ''));
      }
      for (let i = 0; i < BALLOONS.length; i++) expect(balloonDetail(ctx, i)).toMatch(/^alt \d+ m · \d+ km\/h · drifting [a-z-]+$/);
    }
    expect(seen.has('the open sea')).toBe(true);
    expect(overPlace(ctx, getPlanet().cityDir)).toBe('bigtown');
  });

  it('flies the ridden (undodged) pose continuously: no teleport, unit frame, over hours', { timeout: 30000 }, () => {
    const p = newPose();
    const q = newPose();
    for (let i = 0; i < ROUTES.length; i++) {
      const v = ROUTES[i].omega * (R + ROUTES[i].alt);
      for (let t = 0; t < 4 * 3600; t += 37.3) {
        planePose(ROUTES[i], t, p);
        planePose(ROUTES[i], t + 1 / 60, q);
        const step = Math.hypot(q.pos.x - p.pos.x, q.pos.y - p.pos.y, q.pos.z - p.pos.z);
        expect(step).toBeGreaterThan((v / 60) * 0.8);
        expect(step).toBeLessThan((v / 60) * 1.25);
        expect(Math.hypot(p.fwd.x, p.fwd.y, p.fwd.z)).toBeCloseTo(1, 6);
        expect(Math.abs(p.fwd.x * p.up.x + p.fwd.y * p.up.y + p.fwd.z * p.up.z)).toBeLessThan(1e-6);
      }
    }
  });
});
