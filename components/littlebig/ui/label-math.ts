// World labels (pure, zero allocation per frame): projection to CSS px, the planet's limb, the
// altitude fade and a greedy, stable declutter. labels.tsx drives it from one rAF.

/** out = a · b for column-major 4×4 matrices (three's Matrix4.elements). */
export function mul4(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array | Float32Array | number[]): void {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** Clip w: > 0 in front of the camera. */
  w: number;
  /** NDC depth (−1 near … 1 far). */
  z: number;
}

/** Project world (x, y, z) with the view-projection `m` onto a w × h CSS-px viewport. */
export function project(m: ArrayLike<number>, x: number, y: number, z: number, w: number, h: number, out: ScreenPoint): ScreenPoint {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  out.w = cw;
  const iw = cw !== 0 ? 1 / cw : 0;
  out.x = (cx * iw * 0.5 + 0.5) * w;
  out.y = (0.5 - cy * iw * 0.5) * h;
  out.z = cz * iw;
  return out;
}

/**
 * How far (m) the sight line from the eye to point p clears a sphere of radius r at the origin:
 * > 0 visible, < 0 hidden behind it. A point nearer than the closest approach is always clear.
 */
export function limbClearance(ex: number, ey: number, ez: number, px: number, py: number, pz: number, r: number): number {
  const dx = px - ex;
  const dy = py - ey;
  const dz = pz - ez;
  const dd = dx * dx + dy * dy + dz * dz;
  if (dd < 1e-9) return 1e9;
  // Closest approach of the segment eye → p to the origin.
  const s = -(ex * dx + ey * dy + ez * dz) / dd;
  if (s >= 1) {
    // The point is in front of the closest approach: hidden only if it is itself inside.
    return Math.sqrt(px * px + py * py + pz * pz) - r + 1e3;
  }
  if (s <= 0) return 1e9;
  const qx = ex + dx * s;
  const qy = ey + dy * s;
  const qz = ez + dz * s;
  return Math.sqrt(qx * qx + qy * qy + qz * qz) - r;
}

/** Does the circle (cx, cy, r) touch the box [x0, y0]–[x1, y1]? (CSS px.) */
export function circleHitsBox(cx: number, cy: number, r: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0;
  const dy = cy < y0 ? y0 - cy : cy > y1 ? cy - y1 : 0;
  return dx * dx + dy * dy < r * r;
}

/**
 * Screen radius (CSS px) of a sphere of radius r (m) at clip w (its view depth), for a projection
 * whose element [5] is p5 (1 / tan(fov / 2)), on a viewport h px tall.
 */
export function screenRadius(r: number, w: number, p5: number, h: number): number {
  return w > 1e-6 ? ((r * p5) / w) * h * 0.5 : 0;
}

/** How far (px) the circle (cx, cy, r) reaches into the box [x0, y0]–[x1, y1]; ≤ 0: clear of it. */
export function circleIntoBox(cx: number, cy: number, r: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0;
  const dy = cy < y0 ? y0 - cy : cy > y1 ? cy - y1 : 0;
  return r - Math.sqrt(dx * dx + dy * dy);
}

/**
 * The planet (a sphere of radius r at the origin) as a screen circle (CSS px) seen from `eye`
 * through the view-projection `m` (p5: projection element [5]). The silhouette's true angular
 * radius, asin(r / d), so it is right close in too; r = Infinity when the eye is inside the sphere,
 * 0 when the planet is behind the camera.
 */
export function planetDisc(m: ArrayLike<number>, eye: V3, r: number, p5: number, w: number, h: number, out: { x: number; y: number; r: number }): typeof out {
  const d = Math.sqrt(eye.x * eye.x + eye.y * eye.y + eye.z * eye.z);
  const sp: ScreenPoint = { x: 0, y: 0, w: 0, z: 0 };
  project(m, 0, 0, 0, w, h, sp);
  out.x = sp.x;
  out.y = sp.y;
  if (d <= r * 1.0005) out.r = Infinity;
  else if (sp.w <= 0) out.r = 0;
  else out.r = (p5 * h * 0.5 * r) / Math.sqrt(d * d - r * r);
  return out;
}

// ── fly-to framing (a label click) ──

type V3 = { x: number; y: number; z: number };

// camera/model.ts pitchForAlt, mirrored (importing it would pull world/ into the canvas chunk;
// ui.spec.ts keeps the two equal).
const P_LOW = (-8 * Math.PI) / 180;
const P_EYE = (-4 * Math.PI) / 180;
const LOG_LOW = Math.log(4 / 1.7);
const LOG_TOP = Math.log(120 / 4);
const M_KNOT_UP = (-Math.PI / 2 - P_LOW) * 0.39;
const M_KNOT_LOW = (M_KNOT_UP * LOG_LOW) / LOG_TOP;
const M_EYE = (-2 * Math.PI) / 180;

/** The explore camera's altitude-driven pitch (rad) — camera/model.ts pitchForAlt. */
export function pitchForAlt(alt: number): number {
  if (alt >= 120) return -Math.PI / 2;
  if (alt <= 1.7) return P_EYE;
  if (alt <= 4) {
    const t = Math.log(alt / 1.7) / LOG_LOW;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * P_EYE + (t3 - 2 * t2 + t) * M_EYE + (-2 * t3 + 3 * t2) * P_LOW + (t3 - t2) * M_KNOT_LOW;
  }
  const u = Math.log(alt / 4) / LOG_TOP;
  const u2 = u * u;
  const u3 = u2 * u;
  const f = -2 * u3 + 3 * u2 + 0.39 * (u3 - 2 * u2 + u) - 1.5 * u2 * (1 - u) * (1 - u);
  return P_LOW + (-Math.PI / 2 - P_LOW) * f;
}

/** Unit tangent at unit `up` along compass `heading` (rad, clockwise from north) — world/sphere.ts headingVector. */
export function headingTangent(up: V3, heading: number, out: V3): V3 {
  let ex: number;
  let ey: number;
  let ez: number;
  if (Math.abs(up.y) > 0.999999) {
    ex = 1 - up.x * up.x;
    ey = -up.x * up.y;
    ez = -up.x * up.z;
  } else {
    ex = up.z;
    ey = 0;
    ez = -up.x;
  }
  const el = Math.hypot(ex, ey, ez) || 1;
  ex /= el;
  ey /= el;
  ez /= el;
  // north = up × east
  const nx = up.y * ez - up.z * ey;
  const ny = up.z * ex - up.x * ez;
  const nz = up.x * ey - up.y * ex;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  out.x = nx * c + ex * s;
  out.y = ny * c + ey * s;
  out.z = nz * c + ez * s;
  return out;
}

/**
 * Where to fly the explore camera so that `dir` sits in the middle of the view on arrival. The
 * camera's fly-to carries its heading along the great circle (camera/index.ts rotateState) and ends
 * directly above the target at the altitude-driven pitch, which at a town's 40-odd metres looks
 * ~68° down: the town would sit at the bottom edge, its tag off screen. So aim short of it, along
 * the heading the camera will arrive with, by alt / tan(|pitch|). r: the sphere's radius (m).
 */
export function framedFlyTarget(focus: V3, heading: number, dir: V3, alt: number, r: number, out: V3): V3 {
  const f = headingTangent(focus, heading, { x: 0, y: 0, z: 0 });
  // Parallel-transport f from focus to dir (rotation about focus × dir).
  let ax = focus.y * dir.z - focus.z * dir.y;
  let ay = focus.z * dir.x - focus.x * dir.z;
  let az = focus.x * dir.y - focus.y * dir.x;
  const s = Math.hypot(ax, ay, az);
  const c = focus.x * dir.x + focus.y * dir.y + focus.z * dir.z;
  if (s > 1e-7) {
    ax /= s;
    ay /= s;
    az /= s;
    const kd = ax * f.x + ay * f.y + az * f.z;
    const cx = ay * f.z - az * f.y;
    const cy = az * f.x - ax * f.z;
    const cz = ax * f.y - ay * f.x;
    const fx = f.x * c + cx * s + ax * kd * (1 - c);
    const fy = f.y * c + cy * s + ay * kd * (1 - c);
    const fz = f.z * c + cz * s + az * kd * (1 - c);
    f.x = fx;
    f.y = fy;
    f.z = fz;
  }
  // Keep it a unit tangent at dir.
  const d0 = f.x * dir.x + f.y * dir.y + f.z * dir.z;
  f.x -= dir.x * d0;
  f.y -= dir.y * d0;
  f.z -= dir.z * d0;
  const fl = Math.hypot(f.x, f.y, f.z);
  const pitch = pitchForAlt(alt);
  const back = Math.abs(pitch) > 1.55 || fl < 1e-6 ? 0 : alt / Math.tan(-pitch);
  const ang = back / r;
  const k = fl > 1e-6 ? Math.sin(ang) / fl : 0;
  out.x = dir.x * Math.cos(ang) - f.x * k;
  out.y = dir.y * Math.cos(ang) - f.y * k;
  out.z = dir.z * Math.cos(ang) - f.z * k;
  const ol = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= ol;
  out.y /= ol;
  out.z /= ol;
  return out;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** 0..1: a label shown inside [minAlt, maxAlt] fades in and out over ~25 % of altitude at each end. */
export function altFade(alt: number, minAlt: number, maxAlt: number): number {
  const la = Math.log(Math.max(0.5, alt));
  const lo = minAlt > 0 ? smooth(Math.log(minAlt) - 0.22, Math.log(minAlt) + 0.06, la) : 1;
  const hi = Number.isFinite(maxAlt) ? 1 - smooth(Math.log(maxAlt) - 0.06, Math.log(maxAlt) + 0.22, la) : 1;
  return lo * hi;
}

/** Draw order and declutter priority by kind (higher wins a collision). */
export const KIND_PRIORITY: Record<string, number> = {
  capital: 8,
  station: 7,
  city: 6,
  town: 5,
  airport: 4,
  harbour: 3,
  village: 2,
  landmark: 1,
};

/**
 * Greedy declutter with memory. Each frame: begin(), add() every candidate (its tag's screen box),
 * reserve() the HUD's own panels, then solve(): a candidate is shown unless its box (plus a margin)
 * overlaps a better one already placed or a reserved panel. Ties go to labels shown last frame, then
 * the nearer one, so the set does not flicker. Preallocated; zero allocation per frame once warm.
 */
export class Declutter {
  private cap = 0;
  private n = 0;
  private boxes = new Float64Array(0); // x0, y0, x1, y1
  private keys = new Float64Array(0);
  private order = new Int32Array(0);
  /** 1 = shown, per candidate index (valid after solve()). */
  shown = new Uint8Array(0);
  private placed = new Int32Array(0);
  private reserved = new Float64Array(32);
  private nReserved = 0;

  constructor(private readonly margin = 4) {}

  private grow(n: number) {
    if (n <= this.cap) return;
    const cap = Math.max(16, n * 2);
    const boxes = new Float64Array(cap * 4);
    boxes.set(this.boxes);
    this.boxes = boxes;
    const keys = new Float64Array(cap);
    keys.set(this.keys);
    this.keys = keys;
    this.order = new Int32Array(cap);
    this.placed = new Int32Array(cap);
    const shown = new Uint8Array(cap);
    shown.set(this.shown);
    this.shown = shown;
    this.cap = cap;
  }

  begin(): void {
    this.n = 0;
    this.nReserved = 0;
  }

  /** A panel the labels must stay clear of (CSS px box). */
  reserve(x0: number, y0: number, x1: number, y1: number): void {
    if (this.nReserved * 4 + 4 > this.reserved.length) return;
    const r = this.reserved;
    const i = this.nReserved++ * 4;
    r[i] = x0;
    r[i + 1] = y0;
    r[i + 2] = x1;
    r[i + 3] = y1;
  }

  /** Candidate i (must be added in index order 0, 1, 2…). Returns its index. */
  add(x0: number, y0: number, x1: number, y1: number, priority: number, wasShown: boolean, depth: number): number {
    const i = this.n++;
    this.grow(this.n);
    const b = this.boxes;
    b[i * 4] = x0;
    b[i * 4 + 1] = y0;
    b[i * 4 + 2] = x1;
    b[i * 4 + 3] = y1;
    // One sortable key: priority, then shown-last-frame, then nearer (depth in (−1, 1)).
    this.keys[i] = priority * 4 + (wasShown ? 2 : 0) + (1 - Math.min(0.999, Math.max(-0.999, depth))) * 0.5;
    return i;
  }

  solve(): void {
    const n = this.n;
    const o = this.order;
    const k = this.keys;
    for (let i = 0; i < n; i++) o[i] = i;
    // Insertion sort, descending by key (n is small: tens of labels).
    for (let i = 1; i < n; i++) {
      const v = o[i];
      let j = i - 1;
      while (j >= 0 && k[o[j]] < k[v]) {
        o[j + 1] = o[j];
        j--;
      }
      o[j + 1] = v;
    }
    const b = this.boxes;
    const m = this.margin;
    const r = this.reserved;
    let np = 0;
    for (let s = 0; s < n; s++) {
      const i = o[s];
      const x0 = b[i * 4] - m;
      const y0 = b[i * 4 + 1] - m;
      const x1 = b[i * 4 + 2] + m;
      const y1 = b[i * 4 + 3] + m;
      let ok = true;
      for (let q = 0; q < this.nReserved && ok; q++) {
        if (x0 < r[q * 4 + 2] && x1 > r[q * 4] && y0 < r[q * 4 + 3] && y1 > r[q * 4 + 1]) ok = false;
      }
      for (let p = 0; p < np && ok; p++) {
        const j = this.placed[p];
        if (x0 < b[j * 4 + 2] && x1 > b[j * 4] && y0 < b[j * 4 + 3] && y1 > b[j * 4 + 1]) ok = false;
      }
      this.shown[i] = ok ? 1 : 0;
      if (ok) this.placed[np++] = i;
    }
  }
}
