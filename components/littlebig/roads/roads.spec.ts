import { describe, expect, it } from 'vitest';
import { Geo } from '../city/geo';
import { terrainData, facePoint } from '../terrain/data';
import { R, ROAD_H } from '../world/config';
import { getPlanet } from '../world/planet';
import { getRegion } from '../world/region';
import { chartAt } from '../world/region/network';
import { chartToDir, dirToChart, v3, type Vec3 } from '../world/sphere';
import { armsOf, buildGround, deadEnd, groundOf, outlineOf } from './ground';
import { lampLayout } from './lamps';
import { meshHeight } from './mesh';
import { buildStructures } from './struct';

const planet = getPlanet();
const region = getRegion();
const terrain = terrainData(planet, 6);
const mesh = meshHeight(terrain);
// (as the system renders it: the facet, or a walled quay's deck)
const ground = groundOf(region, mesh);

/** The topmost surface of a Geo's triangles along the ray from the planet's centre through unit q (m above sea level, or −Infinity). */
function surfaceOf(g: Geo) {
  const cells = new Map<number, number[]>();
  const key = (x: number, y: number, z: number) => ((Math.floor(x) + 512) * 1024 + Math.floor(y) + 512) * 1024 + Math.floor(z) + 512;
  for (let t = 0; t < g.ni; t += 3) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = g.idx[t + k] * 3;
      const l = Math.hypot(g.pos[v], g.pos[v + 1], g.pos[v + 2]) / R;
      const x = g.pos[v] / l, y = g.pos[v + 1] / l, z = g.pos[v + 2] / l;
      x0 = Math.min(x0, x), y0 = Math.min(y0, y), z0 = Math.min(z0, z), x1 = Math.max(x1, x), y1 = Math.max(y1, y), z1 = Math.max(z1, z);
    }
    if (x1 - x0 > 12 || y1 - y0 > 12 || z1 - z0 > 12) continue; // (a vertical band seen edge-on: never a surface)
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) for (let y = Math.floor(y0); y <= Math.floor(y1); y++) for (let z = Math.floor(z0); z <= Math.floor(z1); z++) (cells.get(key(x, y, z)) ?? cells.set(key(x, y, z), []).get(key(x, y, z))!).push(t);
  }
  const P = g.pos, I = g.idx;
  return (q: Vec3) => {
    let top = -Infinity;
    for (const t of cells.get(key(q.x * R, q.y * R, q.z * R)) ?? []) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const px = q.y * e2z - q.z * e2y, py = q.z * e2x - q.x * e2z, pz = q.x * e2y - q.y * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const tx = -P[a], ty = -P[a + 1], tz = -P[a + 2];
      const u = (tx * px + ty * py + tz * pz) / det;
      if (u < -1e-4 || u > 1 + 1e-4) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (q.x * qx + q.y * qy + q.z * qz) / det;
      if (v < -1e-4 || u + v > 1 + 1e-4) continue;
      top = Math.max(top, (e2x * qx + e2y * qy + e2z * qz) / det - R);
    }
    return top;
  };
}

describe('roads: the rendered ground', () => {
  it('finds the terrain facet under a direction and its exact height', () => {
    let worst = 0;
    const p = v3();
    for (let k = 0; k < 4000; k++) {
      const f = (k * 7919) % terrain.ico.triangleCount;
      let u = ((k * 0.618) % 1) * 0.9 + 0.03, w = ((k * 0.382) % 1) * 0.9 + 0.03;
      if (u + w > 0.97) [u, w] = [0.97 - w, 0.97 - u];
      facePoint(terrain, f, u, w, p);
      const l = Math.hypot(p.x, p.y, p.z);
      const d = v3(p.x / l, p.y / l, p.z / l);
      expect(mesh.face(d)).toBe(f);
      worst = Math.max(worst, Math.abs(mesh.at(d) - (l - R)));
    }
    expect(worst).toBeLessThan(1e-3);
  });
});

describe('roads: geometry', async () => {
  const G = new Geo(1 << 16);
  const P = new Geo(1 << 14);
  const S = new Geo(1 << 15);
  await buildGround({ region, ground, G, P, tick: async () => {} });
  await buildStructures({ region, ground, S, lamps: [], tick: async () => {} });
  const top = surfaceOf(G);

  it('paves every edge along its whole centreline, on the carved ground (within a few cm of heightAt + ROAD_H)', () => {
    let worst = 0;
    let samples = 0;
    const q = v3();
    for (const e of region.edges) {
      const p = e.centre;
      const spans = e.bridges.map((b) => region.bridges[b]);
      for (let i = 0; i < p.h.length; i += 2) {
        q.x = p.dir[i * 3];
        q.y = p.dir[i * 3 + 1];
        q.z = p.dir[i * 3 + 2];
        const s = p.s[i];
        const onSpan = spans.some((b) => s > b.s0 - 2 && s < b.s1 + 2);
        // the visible (topmost) paving there is the carriageway: at the deck on a span, else the carved bed
        const h = top(q);
        expect(h, `${e.name} (${e.kind}) at s ${s.toFixed(1)}: unpaved`).toBeGreaterThan(-1e3);
        worst = Math.max(worst, Math.abs(h - (onSpan ? p.h[i] : planet.heightAt(q) + ROAD_H)));
        samples++;
      }
    }
    expect(samples).toBeGreaterThan(900);
    expect(worst).toBeLessThan(0.07);
  });

  it('leaves no crack round a junction or along a quay: no sliver of grass under 0.6 m wide and 0.75 m long between paved surfaces', { timeout: 90000 }, () => {
    const cracks: string[] = [];
    const q = v3();
    // round every node, and every 8 m along each sea wall (its apron back to the quay street)
    const areas = region.nodes.map((n) => ({ dir: n.dir, h: n.h, reach: n.radius + 9, name: `node ${n.id} (${n.place})` }));
    for (const st of region.settlements) {
      const w = st.wall;
      if (!w) continue;
      for (let i = 0; i < w.line.length; i += 16) areas.push({ dir: chartToDir(st.chart, w.line[i] - w.nx * 7, w.line[i + 1] - w.nz * 7), h: st.h, reach: 10, name: `${st.id} quay at ${i / 2}` });
    }
    for (const n of areas) {
      const c = chartAt(n.dir, R + n.h);
      const paved = (x: number, z: number) => (chartToDir(c, x, z, q), top(q) > ground(q) + 0.005);
      const reach = n.reach;
      const N = Math.ceil(reach / 0.25);
      // grass points with paving both ways within 0.3 m (a concave corner flags a point or two; a crack a line)
      const flag = new Set<number>();
      for (let i = -N; i <= N; i++) {
        for (let j = -N; j <= N; j++) {
          const x = i * 0.25, z = j * 0.25;
          if (x * x + z * z > reach * reach || paved(x, z) || ground(q) < 0.2) continue;
          for (const [dx, dz] of [[0.3, 0], [0, 0.3], [0.21, 0.21], [0.21, -0.21]]) {
            if (paved(x + dx, z + dz) && paved(x - dx, z - dz)) {
              flag.add(i * 1000 + j);
              break;
            }
          }
        }
      }
      const seen = new Set<number>();
      for (const k of flag) {
        if (seen.has(k)) continue;
        const stack = [k];
        let size = 0;
        seen.add(k);
        while (stack.length) {
          const m = stack.pop()!;
          size++;
          const i = Math.round(m / 1000), j = m - i * 1000;
          for (let a = -1; a <= 1; a++) {
            for (let b = -1; b <= 1; b++) {
              const nk = (i + a) * 1000 + j + b;
              if (flag.has(nk) && !seen.has(nk)) seen.add(nk), stack.push(nk);
            }
          }
        }
        if (size >= 4) cracks.push(`${n.name}: ${size} points from ${(Math.round(k / 1000) * 0.25).toFixed(2)}, ${((k - Math.round(k / 1000) * 1000) * 0.25).toFixed(2)}`);
      }
    }
    expect(cracks).toEqual([]);
  });

  it('stands no structure on a carriageway (a bridge abutment, a pillar, a rail: all under or beside it)', () => {
    const near = new Map<number, number[]>();
    const key = (x: number, y: number, z: number) => ((Math.floor(x / 4) + 128) * 256 + Math.floor(y / 4) + 128) * 256 + Math.floor(z / 4) + 128;
    region.edges.forEach((e, ei) => {
      for (let i = 0; i < e.centre.h.length; i++) {
        const k = key(e.centre.dir[i * 3] * R, e.centre.dir[i * 3 + 1] * R, e.centre.dir[i * 3 + 2] * R);
        (near.get(k) ?? near.set(k, []).get(k)!).push(ei, i);
      }
    });
    const bad: string[] = [];
    const q = v3();
    const check = (x: number, y: number, z: number) => {
      const l = Math.hypot(x, y, z);
      q.x = x / l;
      q.y = y / l;
      q.z = z / l;
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++)
          for (let c = -1; c <= 1; c++) {
            const list = near.get(key(q.x * R + a * 4, q.y * R + b * 4, q.z * R + c * 4)) ?? [];
            for (let k = 0; k < list.length; k += 2) {
              const e = region.edges[list[k]];
              const i = list[k + 1];
              const d = Math.hypot(e.centre.dir[i * 3] - q.x, e.centre.dir[i * 3 + 1] - q.y, e.centre.dir[i * 3 + 2] - q.z) * R;
              if (d < e.width / 2 - 0.15 && l - R > top(q) + 0.004) bad.push(`${e.name} s ${e.centre.s[i].toFixed(1)}: ${(l - R - top(q)).toFixed(2)} m up`);
            }
          }
    };
    for (let t = 0; t < S.ni; t += 3) {
      const a = S.idx[t] * 3, b = S.idx[t + 1] * 3, c = S.idx[t + 2] * 3;
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1 / 3, 1 / 3], [0.5, 0], [0, 0.5], [0.5, 0.5]]) {
        const w = 1 - u - v;
        check(S.pos[a] * w + S.pos[b] * u + S.pos[c] * v, S.pos[a + 1] * w + S.pos[b + 1] * u + S.pos[c + 1] * v, S.pos[a + 2] * w + S.pos[b + 2] * u + S.pos[c + 2] * v);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('rounds every lane without walks into its turning circle (fillets, no corner), and kerbs a car park round with gravel', () => {
    const q = v3();
    for (const n of region.nodes) {
      if (n.kind !== 'end' || region.edges[n.edges[0]].sidewalk) continue;
      const c = chartAt(n.dir, R + n.h);
      const A = armsOf(region, c, n);
      const o = outlineOf(n, A, 0);
      const m = o.length / 2;
      // (past its two curb points, where it meets the lane's own ribbon, the outline turns smoothly)
      let worst = 0;
      for (let k = 2; k < m; k++) {
        const i = (k - 1) * 2, j = k * 2, l = ((k + 1) % m) * 2;
        const a = Math.atan2(o[j + 1] - o[i + 1], o[j] - o[i]), b = Math.atan2(o[l + 1] - o[j + 1], o[l] - o[j]);
        worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))));
      }
      expect(worst, `node ${n.id} (${n.place}): sharpest turn`).toBeLessThan(0.5);
      if (n.place !== 'viewpoint') continue;
      // the far side: a kerbed rim CURB_H over the car park, gravel out past the rail
      for (const r of [n.turnR + 0.5, n.turnR + 1.0]) {
        chartToDir(c, -A[0].ux * r, -A[0].uz * r, q);
        expect(top(q) - ground(q), `node ${n.id}: rim at ${r.toFixed(1)} m`).toBeGreaterThan(ROAD_H + 0.1);
      }
    }
  });

  it('is deterministic', async () => {
    const G2 = new Geo(1 << 16);
    const P2 = new Geo(1 << 14);
    await buildGround({ region, ground, G: G2, P: P2, tick: async () => {} });
    expect(G2.n).toBe(G.n);
    expect(G2.ni).toBe(G.ni);
    expect(Array.from(G2.pos.subarray(0, 3000))).toEqual(Array.from(G.pos.subarray(0, 3000)));
  });
});

describe('roads: streetlights', () => {
  const lamps = lampLayout(region, 0.2, 0.03);
  const arc = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)) * R;
  it('lights the network: town streets, the open road between the towns, bridges, plazas, piers, every yard', () => {
    expect(lamps.length).toBeGreaterThan(100);
    for (const g of region.gates) expect(lamps.filter((l) => arc(l.q, g.dir) < g.r + 1).length).toBeGreaterThanOrEqual(2);
    for (const b of region.bridges) expect(lamps.filter((l) => l.kind === 1 && b.abutments.some((ab) => arc(l.q, ab.dir) < region.edges[b.edge].width)).length).toBe(4);
    for (const n of region.nodes) if (deadEnd(region, n) && deadEnd(region, n) !== 'end') expect(lamps.some((l) => arc(l.q, n.dir) < n.turnR + 4), `yard ${n.id}`).toBe(true);
    // every country road over 30 m carries lights
    for (const e of region.edges) {
      if (e.settlement >= 0 || e.kind === 'ring' || e.centre.length < 30) continue;
      const on = lamps.filter((l) => {
        for (let i = 0; i < e.centre.h.length; i += 2) {
          const dx = e.centre.dir[i * 3] - l.q.x, dy = e.centre.dir[i * 3 + 1] - l.q.y, dz = e.centre.dir[i * 3 + 2] - l.q.z;
          if (Math.hypot(dx, dy, dz) * R < e.width / 2 + 2) return true;
        }
        return false;
      });
      expect(on.length, e.name).toBeGreaterThan(0);
    }
  });

  it('never stands on a carriageway, in a junction or a turning circle (a yard island\'s lamp in its island)', { timeout: 30000 }, () => {
    for (const l of lamps) {
      const isle = region.nodes.find((n) => ['villa', 'school', 'airport'].includes(deadEnd(region, n)) && arc(l.q, n.dir) < n.turnR - 2.9);
      if (isle) continue;
      let clear = Infinity;
      for (const e of region.edges) {
        const p = e.centre;
        for (let i = 0; i < p.h.length; i++) {
          const dx = p.dir[i * 3] - l.q.x, dy = p.dir[i * 3 + 1] - l.q.y, dz = p.dir[i * 3 + 2] - l.q.z;
          clear = Math.min(clear, Math.hypot(dx, dy, dz) * (R + 2) - e.width / 2);
        }
      }
      expect(clear).toBeGreaterThan(0.25);
      for (const n of region.nodes) {
        if (arc(n.dir, l.q) > 20) continue;
        const c = chartAt(n.dir, R + n.h);
        const o = outlineOf(n, armsOf(region, c, n), 0);
        const q = dirToChart(c, l.q);
        let inside = false;
        for (let i = 0, j = o.length - 2; i < o.length; j = i, i += 2) {
          if (o[i + 1] > q.z !== o[j + 1] > q.z && q.x < ((o[j] - o[i]) * (q.z - o[i + 1])) / (o[j + 1] - o[i + 1]) + o[i]) inside = !inside;
        }
        expect(inside, `lamp in node ${n.id}'s patch`).toBe(false);
      }
    }
  });
});
