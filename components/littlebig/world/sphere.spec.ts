import { describe, expect, it } from 'vitest';
import { icosphere } from './icosphere';
import {
  angleBetween,
  chartToDir,
  createChart,
  dirFromLatLon,
  dirToChart,
  dot3,
  geodesicMove,
  headingOf,
  headingVector,
  latLonFromDir,
  len3,
  tangentFrame,
  v3,
} from './sphere';

describe('sphere math', () => {
  it('lat/lon round-trips and follows the documented axes', () => {
    const d = dirFromLatLon(0, 0);
    expect(d.z).toBeCloseTo(1);
    expect(dirFromLatLon(90, 0).y).toBeCloseTo(1);
    expect(dirFromLatLon(0, 90).x).toBeCloseTo(1);
    for (const [la, lo] of [[20, 10], [-63, 170], [5, -120]]) {
      const ll = latLonFromDir(dirFromLatLon(la, lo));
      expect(ll.lat).toBeCloseTo(la, 9);
      expect(ll.lon).toBeCloseTo(lo, 9);
    }
  });

  it('tangent frames are orthonormal with east × north = up, also at the poles', () => {
    for (const d of [dirFromLatLon(20, 10), dirFromLatLon(90, 0), dirFromLatLon(-90, 0), dirFromLatLon(-89.99999, 33)]) {
      const e = v3();
      const n = v3();
      tangentFrame(d, e, n);
      expect(len3(e)).toBeCloseTo(1, 9);
      expect(len3(n)).toBeCloseTo(1, 9);
      expect(dot3(e, n)).toBeCloseTo(0, 9);
      expect(dot3(e, d)).toBeCloseTo(0, 9);
      // e × n = up
      const cx = e.y * n.z - e.z * n.y;
      const cy = e.z * n.x - e.x * n.z;
      const cz = e.x * n.y - e.y * n.x;
      expect(cx * d.x + cy * d.y + cz * d.z).toBeCloseTo(1, 9);
    }
    // At the equator, east is +x at lon 0 and north is +y.
    const e = v3();
    const n = v3();
    tangentFrame(dirFromLatLon(0, 0), e, n);
    expect(e.x).toBeCloseTo(1);
    expect(n.y).toBeCloseTo(1);
  });

  it('headings are compass headings and round-trip', () => {
    const up = dirFromLatLon(20, 10);
    for (const h of [0, 0.5, Math.PI / 2, -2.5, 3]) expect(headingOf(up, headingVector(up, h))).toBeCloseTo(h, 9);
    // heading π/2 at lon 0 lat 0 points east (+x)
    expect(headingVector(dirFromLatLon(0, 0), Math.PI / 2).x).toBeCloseTo(1);
  });

  it('geodesic moves cover the right arc and parallel-transport the heading', () => {
    const d = dirFromLatLon(0, 0);
    const f = headingVector(d, Math.PI / 2); // east along the equator
    const od = v3();
    const of = v3();
    geodesicMove(d, f, (Math.PI / 2) * 160, 160, od, of);
    expect(od.x).toBeCloseTo(1, 9); // a quarter turn east lands at lon 90
    expect(headingOf(od, of)).toBeCloseTo(Math.PI / 2, 9);
    // Many small steps equal one big step.
    const sd = v3(d.x, d.y, d.z);
    const sf = v3(f.x, f.y, f.z);
    for (let i = 0; i < 1000; i++) geodesicMove(sd, sf, 0.25, 160, sd, sf);
    const bd = v3();
    const bf = v3();
    geodesicMove(d, f, 250, 160, bd, bf);
    expect(angleBetween(sd, bd)).toBeLessThan(1e-9);
  });

  it('the exponential-map chart round-trips and preserves radial distance', () => {
    const c = createChart(20, 10, 162);
    for (const [x, z] of [[0, 0], [10, -3], [-60, 45], [80, 20]]) {
      const d = chartToDir(c, x, z);
      expect(angleBetween(c.origin, d) * 162).toBeCloseTo(Math.hypot(x, z), 9);
      const p = dirToChart(c, d);
      expect(p.x).toBeCloseTo(x, 9);
      expect(p.z).toBeCloseTo(z, 9);
    }
    // +x is east, +z is south at the origin
    const e = chartToDir(c, 1, 0);
    expect(headingOf(c.origin, v3(e.x - c.origin.x, e.y - c.origin.y, e.z - c.origin.z))).toBeCloseTo(Math.PI / 2, 3);
    const s = chartToDir(c, 0, 1);
    expect(Math.abs(headingOf(c.origin, v3(s.x - c.origin.x, s.y - c.origin.y, s.z - c.origin.z)))).toBeCloseTo(Math.PI, 3);
  });

  it('icospheres have the right counts and outward winding', () => {
    const ico = icosphere(3);
    expect(ico.vertexCount).toBe(642);
    expect(ico.triangleCount).toBe(1280);
    const p = ico.positions;
    for (let f = 0; f < ico.indices.length; f += 3) {
      const [a, b, c] = [ico.indices[f] * 3, ico.indices[f + 1] * 3, ico.indices[f + 2] * 3];
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      expect(nx * p[a] + ny * p[a + 1] + nz * p[a + 2]).toBeGreaterThan(0);
    }
  });
});
