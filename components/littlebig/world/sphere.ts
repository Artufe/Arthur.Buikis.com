// Sphere math for a planet centred on the origin. Pure TS, no three.js, zero allocation in the
// hot paths (everything writes into an `out` argument).
//
// Vec3 is structural ({x, y, z}), so a THREE.Vector3 can be passed anywhere a Vec3 is expected.
//
// Conventions (shared by every system; see also config.ts):
// - "dir" = a unit vector from the planet centre. Positions are dir · radius.
// - lat/lon in degrees: dir = (cos lat · sin lon, sin lat, cos lat · cos lon). +Y = north pole.
// - Tangent frame at dir: up = dir, east = normalize(Y × up), north = up × east.
//   At the poles (|dir.y| > 0.999999) east falls back to +X projected onto the tangent plane.
// - Heading: radians clockwise from north seen from above (0 = north, π/2 = east), compass style.
// - Local 2D charts (the city plan) use +x = east and +z = south, so (x, up, z) is right-handed and
//   the right-hand side of a 2D direction (dx, dz) is (−dz, dx). See rightOf().

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

const DEG = Math.PI / 180;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function set3(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copy3(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const len3 = (a: Vec3) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);

/** out = a × b. Safe when out aliases a or b. */
export function cross3(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function normalize3(out: Vec3, a: Vec3 = out): Vec3 {
  const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) || 1;
  out.x = a.x / l;
  out.y = a.y / l;
  out.z = a.z / l;
  return out;
}

/** out = a + b · s */
export function addScaled3(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function scale3(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** Angle between two unit vectors (rad), robust near 0 and π. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), dot3(a, b));
}

export function dirFromLatLon(latDeg: number, lonDeg: number, out: Vec3 = v3()): Vec3 {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  const c = Math.cos(la);
  out.x = c * Math.sin(lo);
  out.y = Math.sin(la);
  out.z = c * Math.cos(lo);
  return out;
}

export function latLonFromDir(dir: Vec3, out: LatLon = { lat: 0, lon: 0 }): LatLon {
  const l = len3(dir) || 1;
  out.lat = Math.asin(Math.max(-1, Math.min(1, dir.y / l))) / DEG;
  out.lon = Math.atan2(dir.x, dir.z) / DEG;
  return out;
}

/** East and north unit tangents at unit vector `up`. */
export function tangentFrame(up: Vec3, outEast: Vec3, outNorth: Vec3): void {
  if (Math.abs(up.y) > 0.999999) {
    // Pole: east = +X with its radial part removed.
    set3(outEast, 1 - up.x * up.x, -up.x * up.y, -up.x * up.z);
  } else {
    // Y × up = (up.z, 0, -up.x)
    set3(outEast, up.z, 0, -up.x);
  }
  normalize3(outEast);
  cross3(outNorth, up, outEast);
}

const _e = v3();
const _n = v3();

/** Unit tangent pointing along `heading` (rad, clockwise from north) at `up`. */
export function headingVector(up: Vec3, heading: number, out: Vec3 = v3()): Vec3 {
  tangentFrame(up, _e, _n);
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return set3(out, _n.x * c + _e.x * s, _n.y * c + _e.y * s, _n.z * c + _e.z * s);
}

/** Heading (rad, clockwise from north, in (−π, π]) of tangent `fwd` at `up`. */
export function headingOf(up: Vec3, fwd: Vec3): number {
  tangentFrame(up, _e, _n);
  return Math.atan2(dot3(fwd, _e), dot3(fwd, _n));
}

/** Remove the radial part of `t` at unit `up` and normalise: keeps a tangent a tangent. */
export function orthonormalizeTangent(t: Vec3, up: Vec3): Vec3 {
  const d = dot3(t, up);
  t.x -= up.x * d;
  t.y -= up.y * d;
  t.z -= up.z * d;
  const l = len3(t);
  if (l < 1e-9) return headingVector(up, 0, t);
  return scale3(t, t, 1 / l);
}

/**
 * Walk `dist` metres along the great circle through unit `dir` heading along unit tangent `fwd`,
 * on a sphere of `radius`. Writes the new position dir and the parallel-transported forward
 * tangent. outDir/outFwd may alias dir/fwd.
 */
export function geodesicMove(dir: Vec3, fwd: Vec3, dist: number, radius: number, outDir: Vec3, outFwd: Vec3): void {
  const a = dist / radius;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = dir.x * c + fwd.x * s;
  const dy = dir.y * c + fwd.y * s;
  const dz = dir.z * c + fwd.z * s;
  const fx = fwd.x * c - dir.x * s;
  const fy = fwd.y * c - dir.y * s;
  const fz = fwd.z * c - dir.z * s;
  set3(outDir, dx, dy, dz);
  normalize3(outDir);
  set3(outFwd, fx, fy, fz);
  orthonormalizeTangent(outFwd, outDir);
}

/** Rodrigues rotation of `v` about unit `axis` by `angle` (rad). out may alias v. */
export function rotateAxis(out: Vec3, v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot3(axis, v) * (1 - c);
  const x = v.x * c + (axis.y * v.z - axis.z * v.y) * s + axis.x * d;
  const y = v.y * c + (axis.z * v.x - axis.x * v.z) * s + axis.y * d;
  const z = v.z * c + (axis.x * v.y - axis.y * v.x) * s + axis.z * d;
  return set3(out, x, y, z);
}

/** Spherical interpolation between unit vectors. out may alias a. */
export function slerpDir(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  const ang = angleBetween(a, b);
  if (ang < 1e-7) return copy3(out, a);
  const s = Math.sin(ang);
  const wa = Math.sin((1 - t) * ang) / s;
  const wb = Math.sin(t * ang) / s;
  set3(out, a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb);
  return normalize3(out);
}

/** Ray (origin o, unit dir d) against a sphere at the origin. Nearest t ≥ 0, or -1 for a miss. */
export function raySphere(o: Vec3, d: Vec3, radius: number): number {
  const b = dot3(o, d);
  const c = dot3(o, o) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t0 = -b - sq;
  if (t0 >= 0) return t0;
  const t1 = -b + sq;
  return t1 >= 0 ? t1 : -1;
}

/** Distance from a point at height h above a sphere of radius r to its geometric horizon (m). */
export function horizonDistance(r: number, h: number): number {
  return Math.sqrt(Math.max(0, (r + h) * (r + h) - r * r));
}

/** 2D right-hand side of direction (dx, dz) in a +x east / +z south chart: (−dz, dx). */
export function rightOf(dx: number, dz: number, out: Vec2): Vec2 {
  out.x = -dz;
  out.z = dx;
  return out;
}

// ── Tangent charts (exponential map) ──

/**
 * A local 2D chart around `origin`: plan point (x, z) ↦ the surface point reached by walking
 * √(x²+z²) metres from origin along the great circle in direction x·east + z·south, on a sphere of
 * `radius`. Distances and angles are exact along rays from the origin; circumferential distances
 * shrink by sin(θ)/θ (−5% at the plateau edge).
 */
export interface Chart {
  origin: Vec3;
  east: Vec3;
  south: Vec3;
  radius: number;
}

export function createChart(latDeg: number, lonDeg: number, radius: number): Chart {
  const origin = dirFromLatLon(latDeg, lonDeg);
  const east = v3();
  const north = v3();
  tangentFrame(origin, east, north);
  return { origin, east, south: scale3(v3(), north, -1), radius };
}

/** Plan (x, z) → unit dir. */
export function chartToDir(c: Chart, x: number, z: number, out: Vec3 = v3()): Vec3 {
  const d = Math.sqrt(x * x + z * z);
  if (d < 1e-9) return copy3(out, c.origin);
  const th = d / c.radius;
  const s = Math.sin(th) / d;
  const co = Math.cos(th);
  set3(
    out,
    c.origin.x * co + (c.east.x * x + c.south.x * z) * s,
    c.origin.y * co + (c.east.y * x + c.south.y * z) * s,
    c.origin.z * co + (c.east.z * x + c.south.z * z) * s,
  );
  return normalize3(out);
}

/** Unit dir → plan (x, z). Inverse of chartToDir for θ < π. */
export function dirToChart(c: Chart, dir: Vec3, out: Vec2 = { x: 0, z: 0 }): Vec2 {
  const ex = dot3(dir, c.east);
  const sz = dot3(dir, c.south);
  const t = Math.sqrt(ex * ex + sz * sz);
  if (t < 1e-12) {
    // The origin itself, or its exact antipode (θ = π: as far from the city as it gets).
    out.x = dot3(dir, c.origin) > 0 ? 0 : Math.PI * c.radius;
    out.z = 0;
    return out;
  }
  const th = Math.atan2(t, dot3(dir, c.origin));
  const k = (th * c.radius) / t;
  out.x = ex * k;
  out.z = sz * k;
  return out;
}

/**
 * Local frame of the chart at plan (x, z): unit dir `up` and the images of the plan's +x and +z
 * axes, made tangent and orthonormal (ax first, az = ax × up... i.e. right-handed with up).
 * Use it to orient anything placed in the plan (a building's local +x is plan +x rotated by its
 * angle in this frame).
 */
export function chartFrame(c: Chart, x: number, z: number, outUp: Vec3, outAx: Vec3, outAz: Vec3): void {
  chartToDir(c, x, z, outUp);
  const h = 0.05;
  chartToDir(c, x + h, z, _e);
  chartToDir(c, x - h, z, _n);
  set3(outAx, _e.x - _n.x, _e.y - _n.y, _e.z - _n.z);
  orthonormalizeTangent(outAx, outUp);
  // (ax, up, az) right-handed: az = ax × up
  cross3(outAz, outAx, outUp);
  normalize3(outAz);
}
