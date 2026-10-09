// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { KINDS } from '../traffic/sim';
import { R } from '../world/config';
import { v3 } from '../world/sphere';
import { getRegion } from '../world/region';
import { CROSS_W, townCrossings } from './crossings';
import { FERRY_DWELL, FERRY_LEN, ferryFleet, ferryTrack, type FerryState } from './ferry';
import { BODY_HW, buildNet, KERB_TOL, kerbGauge, type Net } from './net';
import { buildRoutes, LINES } from './routes';
import { createTransitSim, type TransitSim } from './sim';
import { busSub, fleetCards, fleetDetail, ID_BASE } from './track';

const DT = 1 / 60;
const region = getRegion();
const net: Net = buildNet(region);
const SEED = 7;
const fresh = () => createTransitSim(net, buildRoutes(net, SEED), SEED);
/** Longest any vehicle may stand still (s): this seed's hour peaks at 85 s (the city bus at a junction in the core). */
const MAX_STALL = 100;
/** Seconds a vehicle committed to a crossing before people stepped on has to clear it. */
const GRACE = 12;

/** First pair of bodies (boxes on the tangent plane between them, `pad` m in on every side) that overlap, or ''. */
function overlaps(sim: TransitSim, pad: number): string {
  const { C, F, Rr } = sim;
  for (let i = 0; i < sim.n; i++)
    for (let j = i + 1; j < sim.n; j++) {
      const dx = C[j * 3] - C[i * 3], dy = C[j * 3 + 1] - C[i * 3 + 1], dz = C[j * 3 + 2] - C[i * 3 + 2];
      if (dx * dx + dy * dy + dz * dz > 100) continue;
      const l = Math.hypot(C[i * 3], C[i * 3 + 1], C[i * 3 + 2]);
      const ux = C[i * 3] / l, uy = C[i * 3 + 1] / l, uz = C[i * 3 + 2] / l;
      const axis = (k: number) => {
        let x = F[k * 3] - Rr[k * 3], y = F[k * 3 + 1] - Rr[k * 3 + 1], z = F[k * 3 + 2] - Rr[k * 3 + 2];
        const d = x * ux + y * uy + z * uz;
        x -= ux * d;
        y -= uy * d;
        z -= uz * d;
        const m = Math.hypot(x, y, z) || 1;
        return [x / m, y / m, z / m];
      };
      const side = (a: number[]) => [uy * a[2] - uz * a[1], uz * a[0] - ux * a[2], ux * a[1] - uy * a[0]];
      const A = axis(i), B = axis(j), As = side(A), Bs = side(B);
      const ahl = KINDS[sim.kind[i]].len / 2 - pad, ahw = BODY_HW[sim.kind[i]] - pad;
      const bhl = KINDS[sim.kind[j]].len / 2 - pad, bhw = BODY_HW[sim.kind[j]] - pad;
      const dot = (p: number[], q: number[]) => Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2]);
      let sep = false;
      for (const ax of [A, As, B, Bs]) {
        const d = Math.abs(dx * ax[0] + dy * ax[1] + dz * ax[2]);
        if (d > ahl * dot(A, ax) + ahw * dot(As, ax) + bhl * dot(B, ax) + bhw * dot(Bs, ax)) {
          sep = true;
          break;
        }
      }
      if (!sep) return `${i} (${KINDS[sim.kind[i]].name}, seg ${sim.seg[i]}) × ${j} (${KINDS[sim.kind[j]].name}, seg ${sim.seg[j]})`;
    }
  return '';
}

describe('transit sim (V1)', () => {
  it('the fleet: far haven busiest, every kind, buses on their lines', () => {
    const sim = fresh();
    const S = region.settlements;
    const home = (id: string) => Array.from(sim.routes.home).filter((h, i) => S[h].id === id && sim.kind[i] < 3).length;
    expect(home('far-haven')).toBeGreaterThan(home('port-pebble'));
    expect(home('port-pebble')).toBeGreaterThan(home('clover'));
    for (let k = 0; k < 4; k++) expect(Array.from(sim.kind).filter((x) => x === k).length).toBeGreaterThan(0);
    expect(sim.routes.lines.length).toBe(LINES.length);
    // (the city loop: one stop, round its block)
    for (const ln of sim.routes.lines) expect(ln.stops.length).toBeGreaterThanOrEqual(1);
  });

  it('an hour: no two bodies overlap, nobody stands still for long, poses finite, every stop served', { timeout: 300_000 }, () => {
    const sim = fresh();
    const lastMove = new Float64Array(sim.n);
    const lastOdo = Float64Array.from(sim.odo);
    const door = new Uint8Array(sim.n);
    const served = sim.routes.lines.map((ln) => new Uint8Array(ln.stops.length));
    let worst = 0;
    let who = -1;
    let overlap = '';
    const T = 3600;
    for (let k = 1; k <= T * 60; k++) {
      sim.step(DT, null, null);
      const t = k * DT;
      for (let i = 0; i < sim.n; i++) {
        if (sim.odo[i] - lastOdo[i] > 0.05) {
          lastOdo[i] = sim.odo[i];
          lastMove[i] = t;
        } else if (t - lastMove[i] > worst) {
          worst = t - lastMove[i];
          who = i;
        }
        if (sim.door[i] && !door[i]) served[sim.routes.line[i]][sim.stop[i]] = 1;
        door[i] = sim.door[i];
      }
      if (!overlap && k % 6 === 0) {
        const o = overlaps(sim, 0.05);
        if (o) overlap = `t=${t.toFixed(1)} ${o}`;
      }
    }
    expect(overlap).toBe('');
    expect(worst, who >= 0 ? sim.dump(who) : '').toBeLessThan(MAX_STALL);
    for (const x of sim.C) expect(Number.isFinite(x)).toBe(true);
    served.forEach((st, l) => expect(Array.from(st), `line ${sim.routes.lines[l].no}`).toEqual(Array.from(st, () => 1)));
    // every vehicle on the road surface: the body centre within a few cm of its path's height
    for (let i = 0; i < sim.n; i++) {
      const r = Math.hypot(sim.C[i * 3], sim.C[i * 3 + 1], sim.C[i * 3 + 2]);
      expect(r - R).toBeGreaterThan(-0.5);
    }
  });

  it('is deterministic: two runs from the same seed drive the same', () => {
    const a = fresh();
    const b = fresh();
    for (let k = 0; k < 90 * 60; k++) {
      a.step(DT, null, null);
      b.step(DT, null, null);
    }
    expect(Array.from(b.seg)).toEqual(Array.from(a.seg));
    expect(Array.from(b.s)).toEqual(Array.from(a.s));
    // and reset() starts the same fleet over
    a.reset();
    const c = fresh();
    for (let k = 0; k < 30 * 60; k++) {
      a.step(DT, null, null);
      c.step(DT, null, null);
    }
    expect(Array.from(a.s)).toEqual(Array.from(c.s));
  });

  it('honours a busy crossing: nobody drives onto one while someone is on it', { timeout: 120_000 }, () => {
    const sim = fresh();
    const X = townCrossings(region);
    const busy = new Uint8Array(X.length);
    const blocked = new Uint8Array(X.length);
    for (let k = 0; k < 60 * 60; k++) sim.step(DT, busy, blocked);
    // people step onto every crossing no vehicle has claimed, and stay there
    for (let x = 0; x < X.length; x++) busy[x] = blocked[x] ? 0 : 1;
    // where each busy crossing's strip starts on each of its lanes
    const strip = new Map<number, number[]>();
    X.forEach((c, x) => {
      if (!busy[x]) return;
      c.lanes.forEach((l, j) => strip.set(l, [...(strip.get(l) ?? []), c.laneS[j] - CROSS_W / 2]));
    });
    let crossed = '';
    const prevS = Float64Array.from(sim.s);
    const prevSeg = Int32Array.from(sim.seg);
    for (let k = 0; k < 90 * 60; k++) {
      sim.step(DT, busy, blocked);
      // (those already committed to a crossing when the people stepped on finish crossing: GRACE s)
      for (let i = 0; i < sim.n && !crossed; i++) {
        if (k * DT > GRACE && sim.seg[i] === prevSeg[i] && sim.seg[i] < net.nL)
          for (const a of strip.get(sim.seg[i]) ?? []) if (prevS[i] < a && sim.s[i] >= a) crossed = `t=${(k * DT).toFixed(1)} ${sim.dump(i)}`;
        prevS[i] = sim.s[i];
        prevSeg[i] = sim.seg[i];
      }
    }
    expect(crossed).toBe('');
    expect(blocked.length).toBe(X.length);
  });

  it('people step on whenever no vehicle holds a crossing: no body ever reaches one they are on (turns too)', { timeout: 120_000 }, () => {
    const sim = fresh();
    const X = townCrossings(region);
    const busy = new Uint8Array(X.length);
    const blocked = new Uint8Array(X.length);
    // each crossing's strip on the tangent plane at its centre: centre, axis across the street, its half-length
    const strips = X.map((c) => {
      const m = v3(c.a.x + c.b.x, c.a.y + c.b.y, c.a.z + c.b.z);
      const l = Math.hypot(m.x, m.y, m.z);
      return { m: v3(m.x / l, m.y / l, m.z / l), half: (Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y, c.b.z - c.a.z) * R) / 2 };
    });
    const on = (u: { x: number; y: number; z: number }, m: { x: number; y: number; z: number }) => {
      const l = Math.hypot(u.x, u.y, u.z);
      const d = (u.x * m.x + u.y * m.y + u.z * m.z) / l;
      return [((u.x / l - m.x * d) * R), ((u.y / l - m.y * d) * R), ((u.z / l - m.z * d) * R)];
    };
    const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    /** How deep (m) vehicle i's body reaches into crossing x's strip (≤ 0: clear of it). */
    const depth = (i: number, x: number) => {
      const st = strips[x];
      const c = X[x];
      const cx = sim.C[i * 3], cy = sim.C[i * 3 + 1], cz = sim.C[i * 3 + 2];
      if ((cx * st.m.x + cy * st.m.y + cz * st.m.z) / Math.hypot(cx, cy, cz) < Math.cos(15 / R)) return -1;
      const C = on({ x: cx, y: cy, z: cz }, st.m);
      const f = on({ x: sim.F[i * 3], y: sim.F[i * 3 + 1], z: sim.F[i * 3 + 2] }, st.m);
      const r = on({ x: sim.Rr[i * 3], y: sim.Rr[i * 3 + 1], z: sim.Rr[i * 3 + 2] }, st.m);
      const A = [f[0] - r[0], f[1] - r[1], f[2] - r[2]];
      const al = Math.hypot(A[0], A[1], A[2]);
      A[0] /= al; A[1] /= al; A[2] /= al;
      const ab = on(c.b, st.m), aa = on(c.a, st.m);
      const S = [ab[0] - aa[0], ab[1] - aa[1], ab[2] - aa[2]];
      const sl = Math.hypot(S[0], S[1], S[2]);
      S[0] /= sl; S[1] /= sl; S[2] /= sl;
      const n = [st.m.y * A[2] - st.m.z * A[1], st.m.z * A[0] - st.m.x * A[2], st.m.x * A[1] - st.m.y * A[0]];
      const sn = [st.m.y * S[2] - st.m.z * S[1], st.m.z * S[0] - st.m.x * S[2], st.m.x * S[1] - st.m.y * S[0]];
      const hl = KINDS[sim.kind[i]].len / 2, hw = BODY_HW[sim.kind[i]];
      let d = Infinity;
      for (const ax of [A, n, S, sn]) {
        const ra = hl * Math.abs(dot(A, ax)) + hw * Math.abs(dot(n, ax));
        const rb = st.half * Math.abs(dot(S, ax)) + (CROSS_W / 2) * Math.abs(dot(sn, ax));
        d = Math.min(d, ra + rb - Math.abs(dot(C, ax)));
      }
      return d;
    };
    const left = new Float32Array(X.length);
    const rest = new Float32Array(X.length);
    let steps = 0;
    let walked = 0;
    let hit = '';
    for (let k = 0; k < 240 * 60 && !hit; k++) {
      // (a walker steps on where nothing is held and nobody has just crossed; on it 4 s)
      for (let x = 0; x < X.length; x++) {
        if (busy[x] && (left[x] -= DT) <= 0) {
          busy[x] = 0;
          rest[x] = 3;
        } else if (!busy[x] && (rest[x] -= DT) <= 0 && !blocked[x] && k > 30 * 60) {
          busy[x] = 1;
          left[x] = 4;
          steps++;
        }
      }
      sim.step(DT, busy, blocked);
      if (k % 3) continue;
      for (let x = 0; x < X.length && !hit; x++)
        if (busy[x] && left[x] < 3.9) {
          walked++;
          for (let i = 0; i < sim.n; i++) if (depth(i, x) > 0.05) hit = `t=${(k * DT).toFixed(1)} crossing ${x} (${region.settlements[X[x].settlement].id}) depth ${depth(i, x).toFixed(2)} ${sim.dump(i)}`;
        }
    }
    expect(hit).toBe('');
    expect(steps).toBeGreaterThan(200);
    expect(walked).toBeGreaterThan(0);
  });

  it('bodies keep off the walks: no car past a kerb, no truck or bus past it by KERB_TOL (townsfolk stand 0.38 m back)', { timeout: 120_000 }, () => {
    const sim = fresh();
    const past = kerbGauge(region);
    const town = (g: number) => {
      if (g < net.nL) {
        const e = region.edges[region.lanes[g].edge];
        return e.settlement >= 1 && e.sidewalk > 0;
      }
      const n = region.nodes[region.connectors[g - net.nL].node];
      return n.settlement >= 1 && n.kind !== 'end';
    };
    const worst = [0, 0, 0, 0];
    const at = ['', '', '', ''];
    for (let k = 0; k < 300 * 60; k++) {
      sim.step(DT, null, null);
      if (k % 10) continue;
      for (let i = 0; i < sim.n; i++) {
        const g = sim.seg[i];
        if (!town(g)) continue;
        // (the junctions either end of its street, or the streets either side of its turn: whichever it is over)
        const near = g < net.nL ? [g, ...region.lanes[g].prev.slice(0, 1).map((c) => net.nL + c), ...region.lanes[g].next.slice(0, 1).map((c) => net.nL + c)] : [g, net.from[g - net.nL], net.to[g - net.nL]];
        const o = i * 3;
        const cx = sim.C[o], cy = sim.C[o + 1], cz = sim.C[o + 2];
        const cl = Math.hypot(cx, cy, cz);
        let ax = sim.F[o] - sim.Rr[o], ay = sim.F[o + 1] - sim.Rr[o + 1], az = sim.F[o + 2] - sim.Rr[o + 2];
        const al = Math.hypot(ax, ay, az);
        ax /= al;
        ay /= al;
        az /= al;
        const nx = (cy * az - cz * ay) / cl, ny = (cz * ax - cx * az) / cl, nz = (cx * ay - cy * ax) / cl;
        const kd = sim.kind[i], hl = KINDS[kd].len / 2, hw = BODY_HW[kd];
        for (let a = -1; a <= 1; a += 0.5)
          for (let sd = -1; sd <= 1; sd += 2) {
            // (on whichever it is over: its street (−1 past the street's ends), or the junction nearest it)
            const px = cx + ax * hl * a + nx * hw * sd, py = cy + ay * hl * a + ny * hw * sd, pz = cz + az * hl * a + nz * hw * sd;
            let m = Infinity;
            let jn = -1;
            let jd = Infinity;
            for (const q of near) {
              if (q < net.nL) {
                const v = town(q) ? past(q, px, py, pz) : -1;
                if (v >= 0) m = Math.min(m, v);
                continue;
              }
              const nd = region.nodes[region.connectors[q - net.nL].node].dir;
              const dd = -(px * nd.x + py * nd.y + pz * nd.z) / Math.hypot(px, py, pz);
              if (dd < jd) {
                jd = dd;
                jn = q;
              }
            }
            if (jn >= 0 && town(jn)) m = Math.min(m, past(jn, px, py, pz));
            if (m < Infinity && m > worst[kd]) {
              worst[kd] = m;
              at[kd] = sim.dump(i);
            }
          }
      }
    }
    expect(worst[0], at[0]).toBeLessThan(0.1);
    expect(worst[1], at[1]).toBeLessThan(0.1);
    expect(worst[2], at[2]).toBeLessThanOrEqual(KERB_TOL);
    expect(worst[3], at[3]).toBeLessThanOrEqual(KERB_TOL);
  });

  it('cards: ids from 200 per kind, unique, lowercase; live lines', () => {
    const sim = fresh();
    const cards = fleetCards(sim, new Float32Array(sim.n), SEED);
    const ids = cards.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(`car:${ID_BASE}`);
    expect(ids).toContain(`truck:${ID_BASE}`);
    expect(ids).toContain(`bus:${ID_BASE}`);
    for (const c of cards) {
      expect(c.label).toBe(c.label.toLowerCase());
      expect(Number(c.id.split(':')[1])).toBeGreaterThanOrEqual(ID_BASE);
    }
    for (let k = 0; k < 600; k++) sim.step(DT, null, null);
    for (let i = 0; i < sim.n; i++) expect(fleetDetail(sim, i)).toMatch(/^(stopped|\d+ km\/h) · on .+ · heading /);
    const bus = Array.from(sim.kind).indexOf(3);
    expect(busSub(sim, bus)).toMatch(/ → |^round .+ · /);
  });
});

describe('town crossings (V1)', () => {
  const X = townCrossings(region);
  it('one at each town street end by a junction, kerb to kerb across its lanes', () => {
    expect(X.length).toBeGreaterThan(20);
    X.forEach((c, i) => {
      expect(c.id).toBe(i);
      expect(c.settlement).toBeGreaterThanOrEqual(0);
      const e = region.edges[c.edge];
      const w = Math.acos(Math.min(1, c.a.x * c.b.x + c.a.y * c.b.y + c.a.z * c.b.z)) * (R + e.centre.h[0]);
      expect(Math.abs(w - e.width)).toBeLessThan(0.15);
      expect(c.lanes.length).toBe(e.lanesAB.length + e.lanesBA.length);
      c.lanes.forEach((l, j) => {
        expect(c.laneS[j]).toBeGreaterThan(0);
        expect(c.laneS[j]).toBeLessThan(region.lanes[l].path.length);
      });
    });
    expect(townCrossings(region)).toBe(X);
  });
  it('a vehicle waits short of every one: the lane stops before its strip', () => {
    X.forEach((c) => c.lanes.forEach((l, j) => {
      if (net.xEnd[l] === c.id) expect(net.stopS[l]).toBeLessThanOrEqual(c.laneS[j] - CROSS_W / 2 + 1e-6);
    }));
  });
});

describe('ferries (V1)', () => {
  it('every ferry docks at both berths for its dwell, moves smoothly between, and loops', () => {
    expect(region.ferries.length).toBeGreaterThan(0);
    for (const f of region.ferries) {
      const tr = ferryTrack(f);
      const st: FerryState = { s: 0, v: 0, docked: -1, toward: 0, left: 0 };
      const dock = [0, 0];
      const pos = { x: 0, y: 0, z: 0 };
      const fwd = { x: 0, y: 0, z: 0 };
      const prev = { x: NaN, y: 0, z: 0 };
      let jump = 0;
      for (let t = 0; t < tr.period; t += 0.1) {
        tr.at(t, 0, st);
        if (st.docked >= 0) dock[st.docked] += 0.1;
        tr.pose(st, pos, fwd);
        if (!Number.isNaN(prev.x)) jump = Math.max(jump, Math.hypot(pos.x - prev.x, pos.y - prev.y, pos.z - prev.z));
        prev.x = pos.x;
        prev.y = pos.y;
        prev.z = pos.z;
        expect(st.v).toBeLessThan(6);
        expect(Math.abs(Math.hypot(fwd.x, fwd.y, fwd.z) - 1)).toBeLessThan(1e-6);
      }
      expect(dock[0]).toBeCloseTo(FERRY_DWELL, 0);
      expect(dock[1]).toBeCloseTo(FERRY_DWELL, 0);
      // (0.1 s at cruise is 0.52 m: no step teleports it)
      expect(jump).toBeLessThan(0.7);
      // a whole round later it is where it was
      tr.at(5, 0, st);
      const s0 = st.s;
      tr.at(5 + tr.period, 0, st);
      expect(st.s).toBeCloseTo(s0, 6);
    }
  });
  it('boats sharing a pier take turns: never two within a hull length of each other', () => {
    const { tracks, phase } = ferryFleet(region.ferries, SEED);
    const st = tracks.map(() => ({ s: 0, v: 0, docked: -1, toward: 0, left: 0 }) as FerryState);
    const P = tracks.map(() => ({ x: 0, y: 0, z: 0 }));
    const fw = { x: 0, y: 0, z: 0 };
    let closest = Infinity;
    for (let t = 0; t < 3600; t += 0.5) {
      tracks.forEach((tr, k) => tr.pose(tr.at(t, phase[k], st[k]), P[k], fw));
      for (let a = 0; a < P.length; a++)
        for (let b = a + 1; b < P.length; b++) closest = Math.min(closest, Math.hypot(P[a].x - P[b].x, P[a].y - P[b].y, P[a].z - P[b].z));
    }
    expect(closest).toBeGreaterThan(FERRY_LEN + 2);
  });
});
