// @vitest-environment node
// T2 townsfolk: a long run in every town (transit's crossings, a fake traffic that blocks them at
// random), checking what the townsfolk promise: nobody in a carriageway off a crossing, inside a
// building or a prop, or in the water; no two bodies overlapping; finite poses; the crossing handshake
// (on the carriageway only while committed, never stepping off the kerb while blocked); determinism.

import { describe, expect, it } from 'vitest';
import { armsOf, groundOf, outlineOf } from '../roads/ground';
import { planTowns, T, type Site } from '../towns/plan';
import { townCrossings } from '../transit/crossings';
import { R } from '../world/config';
import { getPlanet, Biome } from '../world/planet';
import { getRegion } from '../world/region';
import { chartAt } from '../world/region/network';
import { hash3 } from '../world/rng';
import { chartToDir, dirToChart, v3 } from '../world/sphere';
import { folkFor, townsfolk, walkers } from './folk';
import { BODY, buildNet, E, itemShape, type Net } from './net';
import { S, TownSim } from './sim';

const region = getRegion();
const planet = getPlanet();
const sites = planTowns(region, (d) => planet.heightAt(d), (d) => planet.biomeAt(d) === Biome.Beach);
const ground = groundOf(region, { at: (d) => planet.heightAt(d), face: () => 0 });
const crossings = townCrossings(region);
const towns = region.settlements.filter((s) => s.style !== 'capital');

function town(id: string) {
  const s = towns.find((x) => x.id === id)!;
  const site = sites.find((x) => x.id === id) as Site;
  const net = buildNet(region, s, site, ground, crossings, []);
  const tf = townsfolk(s, walkers(s, site), region.seed);
  return { s, site, net, sim: new TownSim(net, folkFor(net, tf, region.seed), region.seed ^ s.index) };
}

/** Plan tests for town s: on a carriageway (a street within half its width, or inside a junction's outline), in a footprint, in the water. */
function probes(net: Net, site: Site) {
  const s = net.s, c = s.chart;
  const streets = region.edges
    .filter((e) => {
      for (let i = 0; i < e.centre.h.length; i += 3) {
        const d = v3(e.centre.dir[i * 3], e.centre.dir[i * 3 + 1], e.centre.dir[i * 3 + 2]);
        if (Math.acos(Math.min(1, d.x * s.dir.x + d.y * s.dir.y + d.z * s.dir.z)) * R < s.padR + 40) return true;
      }
      return false;
    })
    .map((e) => {
      const pts: number[] = [];
      for (let i = 0; i < e.centre.h.length; i++) {
        const p = dirToChart(c, v3(e.centre.dir[i * 3], e.centre.dir[i * 3 + 1], e.centre.dir[i * 3 + 2]));
        pts.push(p.x, p.z);
      }
      return { pts, half: e.width / 2 };
    });
  const outlines = region.nodes
    .filter((n) => Math.acos(Math.min(1, n.dir.x * s.dir.x + n.dir.y * s.dir.y + n.dir.z * s.dir.z)) * R < s.padR + 40)
    .map((n) => {
      const nc = chartAt(n.dir, R + n.h), o = outlineOf(n, armsOf(region, nc, n));
      for (let i = 0; i < o.length; i += 2) {
        const p = dirToChart(c, chartToDir(nc, o[i], o[i + 1]));
        [o[i], o[i + 1]] = [p.x, p.z];
      }
      return o;
    });
  const shapes = site.items.map((it, i) => (it.t < T.tree || it.t === T.bench || it.t === T.stall || it.t === T.crates || it.t === T.centre ? itemShape(it, i) : null)).filter((o) => o);
  const inPoly = (x: number, z: number, o: number[]) => {
    let inside = false;
    for (let i = 0, j = o.length - 2; i < o.length; j = i, i += 2) if (o[i + 1] > z !== o[j + 1] > z && x < ((o[j] - o[i]) * (z - o[i + 1])) / (o[j + 1] - o[i + 1]) + o[i]) inside = !inside;
    return inside;
  };
  return {
    road(x: number, z: number): boolean {
      for (const st of streets)
        for (let i = 2; i < st.pts.length; i += 2) {
          const ax = st.pts[i - 2], az = st.pts[i - 1], dx = st.pts[i] - ax, dz = st.pts[i + 1] - az;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
          if (Math.hypot(ax + dx * t - x, az + dz * t - z) < st.half) return true;
        }
      return outlines.some((o) => inPoly(x, z, o));
    },
    /** How deep (m) a body at (x, z) is inside a footprint or prop (≤ 0: clear). */
    inside(x: number, z: number): number {
      let worst = -Infinity;
      for (const o of shapes) {
        const dx = x - o!.x, dz = z - o!.z;
        const d = o!.r > 0 ? Math.hypot(dx, dz) - o!.r : (() => {
          const qx = Math.abs(dx * o!.c + dz * o!.s) - o!.u, qz = Math.abs(dz * o!.c - dx * o!.s) - o!.v;
          return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
        })();
        worst = Math.max(worst, BODY - 0.1 - d);
      }
      return worst;
    },
    wet: (x: number, z: number) => ground(chartToDir(c, x, z)) < 0.05,
  };
}

describe('townsfolk', () => {
  for (const id of towns.map((t) => t.id)) {
    it(`${id}: a long run keeps every walker on the walks, apart and finite`, () => {
      const { net, sim, site } = town(id);
      const P = probes(net, site);
      const nc = crossings.length;
      const busy = new Uint8Array(nc), blocked = new Uint8Array(nc), left = new Float32Array(nc), queued = new Float32Array(nc).fill(-1);
      sim.placeAt(30, 0);
      const bad: string[] = [];
      let crossed = 0, waited = 0, rested = 0, moved = 0, claims = 0;
      const lastX = Float64Array.from(sim.x);
      for (let step = 0; step < 60 * 90; step++) {
        // traffic as transit's: a car reaches each crossing every ~7 s and drives over (blocked for
        // 1.5 s) unless someone is on it or committed (busy); then it waits, and after 5 s it claims it
        // (blocked: nobody new steps on, those on it finish) until it is clear. Never for long.
        for (let c = 0; c < nc; c++) {
          if (left[c] > 0) left[c] -= 1 / 60;
          else if (queued[c] < 0 && step % 420 === Math.floor(hash3(c, 1, 7) * 420)) queued[c] = 0;
          if (queued[c] >= 0) {
            if (!busy[c]) {
              left[c] = 1.5;
              queued[c] = -1;
            } else if ((queued[c] += 1 / 60) > 30) bad.push(`${id} crossing ${c} busy for 30 s against a claim`);
            if (queued[c] > 5 && queued[c] < 5 + 1 / 60) claims++;
          }
          blocked[c] = left[c] > 0 || queued[c] > 5 ? 1 : 0;
        }
        const was = Uint8Array.from(blocked);
        busy.fill(0);
        const onRoad = new Int32Array(sim.n).fill(-1);
        for (let i = 0; i < sim.n; i++) if (sim.st[i] === S.walk && net.kind[sim.e[i]] === E.cross && P.road(sim.x[i], sim.z[i])) onRoad[i] = net.cross[sim.e[i]];
        sim.step(1 / 60, busy, blocked, 0);
        if (step % 6) continue;
        for (let i = 0; i < sim.n; i++) {
          const st = sim.st[i];
          if (![sim.x[i], sim.z[i], sim.h[i], sim.hx[i], sim.hz[i]].every(Number.isFinite)) bad.push(`${id} ${i} not finite`);
          if (st === S.home) continue;
          if (st === S.rest) {
            rested++;
            continue;
          }
          if (st === S.wait) waited++;
          const x = sim.x[i], z = sim.z[i], k = net.kind[sim.e[i]];
          if (k === E.cross) {
            if (P.road(x, z)) {
              crossed++;
              if (sim.cm[i] !== net.cross[sim.e[i]] || !busy[net.cross[sim.e[i]]]) bad.push(`${id} ${i} on a crossing uncommitted`);
              if (onRoad[i] < 0 && was[net.cross[sim.e[i]]]) bad.push(`${id} ${i} stepped off the kerb while blocked`);
            }
          } else if (P.road(x, z)) {
            bad.push(`${id} ${i} in a carriageway (kind ${k}) at ${x.toFixed(2)},${z.toFixed(2)}`);
          }
          const deep = P.inside(x, z);
          if (deep > 0 && k !== E.stub) bad.push(`${id} ${i} ${deep.toFixed(2)} m inside a footprint (kind ${k})`);
          if (k !== E.pier && P.wet(x, z)) bad.push(`${id} ${i} in the water (kind ${k}, st ${st}) at ${x.toFixed(2)},${z.toFixed(2)}`);
          for (let j = i + 1; j < sim.n; j++) {
            if (sim.st[j] === S.home || (sim.st[j] === S.rest && sim.st[i] === S.rest)) continue;
            if (Math.hypot(sim.x[j] - x, sim.z[j] - z) < 2 * BODY - 0.06 && sim.st[j] !== S.rest) bad.push(`${id} ${i}/${j} overlap ${Math.hypot(sim.x[j] - x, sim.z[j] - z).toFixed(2)}`);
          }
          moved += Math.hypot(sim.x[i] - lastX[i]) > 0 ? 1 : 0;
          lastX[i] = sim.x[i];
        }
      }
      expect(bad.slice(0, 12)).toEqual([]);
      expect(moved).toBeGreaterThan(sim.n * 200);
      expect(rested).toBeGreaterThan(0);
      if (net.kind.some((k) => k === E.cross)) expect(crossed).toBeGreaterThan(0);
      // (somebody waited at a kerb for the traffic, somewhere with crossings)
      if (net.kind.some((k) => k === E.cross)) expect(waited).toBeGreaterThan(0);
      void claims;
    }, 120_000);
  }

  it('is deterministic', () => {
    const runs = [0, 1].map(() => {
      const { sim } = town('port-pebble');
      sim.placeAt(120, 0.2);
      const busy = new Uint8Array(crossings.length);
      for (let k = 0; k < 600; k++) sim.step(1 / 60, busy, null, 0.2);
      return [...sim.x, ...sim.z, ...sim.st];
    });
    expect(runs[0]).toEqual(runs[1]);
  });

  it('sends people home at night and out again in the morning', () => {
    const { sim } = town('clover');
    sim.placeAt(0, 1);
    const home = () => Array.from(sim.st).filter((s) => s === S.home).length;
    const night = home();
    for (let k = 0; k < 60 * 60; k++) sim.step(1 / 60, null, null, 0);
    expect(night).toBeGreaterThan(sim.n * 0.4);
    expect(home()).toBeLessThan(night * 0.6);
  }, 60_000);
});
