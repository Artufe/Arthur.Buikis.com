// The breaker's cross-section through every stage of its life, as a keyframe table.
//
// Normalised units: face height H = 1, g = 1, time T_s = sqrt(H/g); u runs with the wave (+ =
// shoreward), y is height above still water, u = 0 is the crest of the swell train the breaker
// replaces. Stage φ is time since the breaking onset in T_s. For each φ (and plunge intensity κ)
// the profile is one continuous curve sampled at NJ points whose indices keep their meaning
// through the whole life (point j is the same bit of water), so interpolating keyframes is a
// smooth morph:
//
//   A  back slope (blends from the swell to the breaker)        j ∈ [0, J_OUT)
//   B  lip outer surface: from the root behind the crest out to the tip
//   C  the rounded tip
//   D  lip inner surface / tube ceiling: from the tip back to the hinge on the face
//   E  the face / tube back wall, down to the toe
//   F  the trough in front (the landing zone, splash-up), blending back to the swell
//
// Life: φ < 0 the face steepens toward vertical; 0..φ_launch the nose pitches over; then the lip
// is thrown out ballistically (launch velocity v0, gravity) until it lands in the trough at φ_imp;
// the enclosed tube holds for a moment, then collapses into a rolling bore that decays.
// Bottom-up: B, C, D are one path (outer → cap → inner) re-sampled by arc length each keyframe,
// so the lip grows out of the rounded crest nose continuously.

export const NJ = 128;
/** Keyframes in φ: φ_k = PHI0 + k·DPHI. */
export const NK = 96;
export const PHI0 = -4;
export const DPHI = 0.25;
export const PHI_END = PHI0 + (NK - 1) * DPHI;
/** Plunge levels κ = 0 (spilling), 0.5, 1 (plunging barrel). */
export const NP = 3;

/** Segment boundaries (point indices). */
export const J_A = 18; // A: [0, J_A)
export const J_LIP = 62; // B + C + D: [J_A, J_A + J_LIP)
export const J_E = 22; // E
export const J_F = NJ - J_A - J_LIP - J_E; // F
export const J_LIP0 = J_A;
export const J_FACE0 = J_A + J_LIP;
export const J_FRONT0 = J_FACE0 + J_E;

/** Cross-section extent (H units) the ribbon covers, and where it blends into the swell. */
export const U_BACK = -5;
export const U_FRONT = 6.5;
export const BLEND_BACK = -2.2; // W = 1 shoreward of here
export const BLEND_FRONT = 3.2; // W = 1 seaward of here

/** Blend weight toward the breaker at rest offset σ (H units); the ocean hook uses the same. */
export const blendW = (sigma: number) =>
  sigma < BLEND_BACK ? smooth(U_BACK, BLEND_BACK, sigma) : sigma > BLEND_FRONT ? 1 - smooth(BLEND_FRONT, U_FRONT, sigma) : 1;

export interface ProfileTables {
  /** (u, y, sss path, chord) per (j, k, p): index ((p·NK + k)·NJ + j)·4. */
  a: Float32Array;
  /** (foam coverage, rest σ, blend weight W, tube 0-1) per (j, k, p). */
  b: Float32Array;
  /**
   * (texture σ, 0, 0, 0): where the water's detail (FFT chop, foam) is sampled. Arc length through
   * the lip and face (so a 3 m face isn't one stretched ripple), easing back to the rest σ where
   * the ribbon blends into the swell.
   */
  c: Float32Array;
}

/** Stage timing for a plunge level (all in T_s). */
export function stageTimes(kappa: number) {
  const launch = 0.45;
  const v = launchVelocity(kappa);
  // Ballistic fall from the crest (y_c) to the trough (y_t): y_c + vy·s − s²/2 = y_t.
  const drop = Y_CREST - Y_TROUGH;
  const s = v.y + Math.sqrt(v.y * v.y + 2 * drop);
  const imp = launch + s;
  // The tube holds a moment after the lip lands, then collapses into the roller.
  const collapse0 = imp + 0.35 + 0.6 * kappa;
  const collapse1 = collapse0 + 1.6 + 0.8 * kappa;
  return { launch, imp, sImp: s, collapse0, collapse1 };
}

const Y_CREST = 0.64;
const Y_TROUGH = -0.36;

function launchVelocity(kappa: number) {
  // Jet speed relative to the wave (sqrt(gH) units): a real plunger throws ~0.8, a spiller barely.
  return { x: 0.2 + 0.62 * kappa, y: 0.1 + 0.2 * kappa };
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// Scratch polyline for the lip path (outer → cap → inner), resampled by arc length.
const LIP_RAW = 400;
const px = new Float64Array(LIP_RAW);
const py = new Float64Array(LIP_RAW);
const pth = new Float64Array(LIP_RAW);
const cum = new Float64Array(LIP_RAW);

/** Cubic Bézier point. */
function bez(p0: number, p1: number, p2: number, p3: number, t: number) {
  const s = 1 - t;
  return s * s * s * p0 + 3 * s * s * t * p1 + 3 * s * t * t * p2 + t * t * t * p3;
}

interface Shape {
  u: Float64Array;
  y: Float64Array;
  th: Float64Array; // local water thickness across the lip (for SSS) or 0
}

/** The profile at stage φ for plunge κ, written into `out` (NJ points). */
export function profileAt(phi: number, kappa: number, out: Shape) {
  const T = stageTimes(kappa);
  const v0 = launchVelocity(kappa);
  // ── the crest nose and the jet ──
  // Crest height rises a little as the wave steepens, and holds while the lip throws.
  const yc = mix(0.54, Y_CREST, smooth(-4, 0, phi));
  const thRoot = mix(0.36, 0.27, kappa);
  const rNose = mix(0.5, thRoot / 2, smooth(-4, 0, phi));
  // The nose (and later the jet) is centred a radius below the crest top.
  const R0x = 0;
  const R0y = yc - rNose;
  // Face angle below horizontal at the top of the face (steepens to vertical, then overhangs).
  const alphaMax = mix(58, 90, kappa) * (Math.PI / 180);
  const alpha = mix(33 * (Math.PI / 180), alphaMax, smooth(-4, 0, phi));
  // Launch direction and the outer root angle.
  const la = Math.atan2(v0.y, v0.x);
  const psiOut = la + Math.PI / 2;
  // The cap's end angle: 90° − α on a monotone face, rotating under to psiOut − π as it pitches.
  const pitch = smooth(0, T.launch, phi) * kappa;
  const psiEnd = mix(Math.PI / 2 - alpha, psiOut - Math.PI, pitch);
  // Jet length (tip age), frozen at impact.
  const S = Math.max(0, Math.min(phi - T.launch, T.sImp)) * (kappa > 0.01 ? 1 : 0);
  const thTip = mix(thRoot, 0.09, smooth(0, 1.2, S));
  const jet = (s: number, o: { x: number; y: number; tx: number; ty: number }) => {
    o.x = R0x + v0.x * s;
    o.y = R0y + v0.y * s - 0.5 * s * s;
    const tx = v0.x;
    const ty = v0.y - s;
    const l = Math.hypot(tx, ty) || 1;
    o.tx = tx / l;
    o.ty = ty / l;
  };
  const J = { x: 0, y: 0, tx: 0, ty: 0 };
  const thAt = (s: number) => (S > 1e-6 ? mix(thRoot, thTip, Math.pow(s / S, 0.8)) : thRoot);
  // Build the raw lip path.
  let n = 0;
  const NS = 120;
  const add = (x: number, y: number, th: number) => {
    px[n] = x;
    py[n] = y;
    pth[n] = th;
    n++;
  };
  if (S > 1e-5) {
    // Outer surface: root → tip.
    for (let i = 0; i <= NS; i++) {
      const s = (i / NS) * S;
      jet(s, J);
      const h = thAt(s) / 2;
      add(J.x - J.ty * h, J.y + J.tx * h, thAt(s));
    }
    // Cap round the tip.
    jet(S, J);
    const psiT = Math.atan2(J.ty, J.tx);
    const r = thAt(S) / 2;
    for (let i = 1; i < 40; i++) {
      const a = psiT + Math.PI / 2 - (i / 40) * Math.PI;
      add(J.x + Math.cos(a) * r, J.y + Math.sin(a) * r, thAt(S));
    }
    // Inner surface: tip → root.
    for (let i = NS; i >= 0; i--) {
      const s = (i / NS) * S;
      jet(s, J);
      const h = thAt(s) / 2;
      add(J.x + J.ty * h, J.y - J.tx * h, thAt(s));
    }
  } else {
    // Nose arc around the crest: from the outer root clockwise to psiEnd.
    for (let i = 0; i <= 160; i++) {
      const a = mix(psiOut, psiEnd, i / 160);
      add(R0x + Math.cos(a) * rNose, R0y + Math.sin(a) * rNose, 2 * rNose);
    }
  }
  // Arc-length resample into the lip points, denser round the tip.
  cum[0] = 0;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
  const total = cum[n - 1] || 1e-6;
  let q = 0;
  for (let j = 0; j < J_LIP; j++) {
    // Warp: t → arc fraction, concentrating points near the middle (the tip).
    const t = j / (J_LIP - 1);
    const w = t + (0.12 * Math.sin(2 * Math.PI * t)) / (2 * Math.PI);
    const target = w * total;
    while (q < n - 2 && cum[q + 1] < target) q++;
    const f = cum[q + 1] > cum[q] ? (target - cum[q]) / (cum[q + 1] - cum[q]) : 0;
    const jj = J_LIP0 + j;
    out.u[jj] = mix(px[q], px[q + 1], f);
    out.y[jj] = mix(py[q], py[q + 1], f);
    out.th[jj] = mix(pth[q], pth[q + 1], f);
  }
  const Rout = { x: out.u[J_LIP0], y: out.y[J_LIP0] };
  const Rin = { x: out.u[J_FACE0 - 1], y: out.y[J_FACE0 - 1] };
  // Tangent leaving the lip set into the face (direction of travel along the curve).
  let tix = out.u[J_FACE0 - 1] - out.u[J_FACE0 - 2];
  let tiy = out.y[J_FACE0 - 1] - out.y[J_FACE0 - 2];
  const tl = Math.hypot(tix, tiy) || 1;
  tix /= tl;
  tiy /= tl;

  // ── the face (tube back wall) down to the toe ──
  // The toe sits a little ahead of the crest line; a hollow wave draws the trough down and up the face.
  const drawdown = 0.08 * kappa * smooth(-1, 1, phi);
  const toeX = mix(2.1, mix(1.0, 0.34, kappa), smooth(-4, 0, phi)) + 0.12 * kappa * smooth(0, T.imp, phi);
  const toeY = Y_TROUGH - drawdown;
  const fh = Math.max(0.2, Rin.y - toeY);
  // Bézier from Rin (continuing the lip's direction) to the toe (arriving nearly horizontal).
  const c1x = Rin.x + tix * fh * 0.45;
  const c1y = Rin.y + tiy * fh * 0.45;
  const c2x = toeX - fh * 0.42;
  const c2y = toeY + fh * 0.1;
  for (let j = 0; j < J_E; j++) {
    const t = (j + 1) / J_E;
    const jj = J_FACE0 + j;
    out.u[jj] = bez(Rin.x, c1x, c2x, toeX, t);
    out.y[jj] = bez(Rin.y, c1y, c2y, toeY, t);
    out.th[jj] = 0;
  }

  // ── the back slope: from the swell 6.5 H behind up to the outer root ──
  // Leaving the root along the outer surface's (reversed) tangent.
  let tox = out.u[J_LIP0 + 1] - out.u[J_LIP0];
  let toy = out.y[J_LIP0 + 1] - out.y[J_LIP0];
  const ol = Math.hypot(tox, toy) || 1;
  tox /= ol;
  toy /= ol;
  const bx0 = U_BACK;
  const by0 = -0.22;
  for (let j = 0; j < J_A; j++) {
    const t = j / J_A;
    // Denser toward the crest.
    const tt = 1 - (1 - t) * (1 - t);
    const span = Rout.x - bx0;
    out.u[j] = bez(bx0, bx0 + span * 0.4, Rout.x - tox * span * 0.35, Rout.x, tt);
    out.y[j] = bez(by0, by0 + 0.02, Rout.y - toy * span * 0.35, Rout.y, tt);
    out.th[j] = 0;
  }

  // ── the trough in front, out to where it rejoins the swell ──
  for (let j = 0; j < J_F; j++) {
    const t = (j + 1) / J_F;
    const tt = t * t * 0.4 + t * 0.6;
    const jj = J_FRONT0 + j;
    out.u[jj] = mix(toeX, U_FRONT, tt);
    // Trough rises back to the swell's level far ahead.
    out.y[jj] = mix(toeY, -0.3, smooth(0, 1, tt));
    out.th[jj] = 0;
  }

  // ── collapse: the tube closes into a rolling bore (all of B..F morph onto the roller) ──
  const col = smooth(T.collapse0, T.collapse1, phi) * (kappa > 0.01 ? 1 : 1);
  const spill = kappa < 0.01 ? smooth(-0.5, 2.5, phi) : 0;
  const beta = Math.max(col, spill);
  if (beta > 0) {
    const landX = kappa > 0.01 ? R0x + v0.x * T.sImp : 0.6;
    rollerInto(out, beta, landX, yc, phi - T.collapse1);
  }
}

/**
 * The collapsed state: a bore with a rounded foam roller on its front. Every point morphs onto
 * one monotone curve (same indices, so the tube closes smoothly), weighted by `beta`.
 */
function rollerInto(out: Shape, beta: number, landX: number, yc: number, age: number) {
  // Roller front toe: about where the lip landed, easing forward as the bore takes over.
  const toe = landX * 0.8 + 0.1 + 0.25 * smooth(0, 6, age);
  const crestU = toe - mix(0.95, 1.25, smooth(0, 8, age));
  const top = mix(yc * 0.92, 0.56, smooth(0, 5, age));
  const rollerY = (u: number) => {
    if (u <= crestU) return mix(-0.22, top, Math.pow(smooth(U_BACK, crestU, u), 1.35));
    if (u <= toe) return mix(top, Y_TROUGH, smooth(crestU, toe, u));
    return mix(Y_TROUGH, -0.3, smooth(toe, U_FRONT, u));
  };
  const uRoot = crestU - 1.2;
  for (let j = 0; j < NJ; j++) {
    let u: number;
    if (j < J_LIP0) u = mix(U_BACK, uRoot, 1 - (1 - j / J_LIP0) * (1 - j / J_LIP0));
    else if (j < J_FRONT0) {
      const t = (j - J_LIP0) / (J_FRONT0 - 1 - J_LIP0);
      // Denser over the roller's front, where the curvature is.
      u = mix(uRoot, toe, t < 0.35 ? (t / 0.35) * 0.55 : 0.55 + ((t - 0.35) / 0.65) * 0.45);
    } else {
      const t = (j - J_FRONT0 + 1) / J_F;
      u = mix(toe, U_FRONT, t * t * 0.4 + t * 0.6);
    }
    out.u[j] = mix(out.u[j], u, beta);
    out.y[j] = mix(out.y[j], rollerY(u), beta);
    out.th[j] = mix(out.th[j], 0, beta);
  }
}

const shape: Shape = { u: new Float64Array(NJ), y: new Float64Array(NJ), th: new Float64Array(NJ) };

/** Bake every keyframe. ~NP·NK profiles; runs once at boot (a few ms). */
export function bakeProfiles(): ProfileTables {
  const a = new Float32Array(NP * NK * NJ * 4);
  const b = new Float32Array(NP * NK * NJ * 4);
  const c = new Float32Array(NP * NK * NJ * 4);
  const arc = new Float64Array(NJ);
  const sigma0 = new Float64Array(NJ);
  for (let p = 0; p < NP; p++) {
    const kappa = p / (NP - 1);
    const T = stageTimes(kappa);
    profileAt(PHI0, kappa, shape);
    const sA = shape.u[J_LIP0 - 1];
    const sF = shape.u[J_FRONT0];
    for (let j = 0; j < NJ; j++) sigma0[j] = j < J_LIP0 ? shape.u[j] : j >= J_FRONT0 ? shape.u[j] : mix(sA, sF, (j - J_LIP0 + 1) / (J_FRONT0 - J_LIP0 + 1));
    for (let k = 0; k < NK; k++) {
      const phi = PHI0 + k * DPHI;
      profileAt(phi, kappa, shape);
      arc[0] = 0;
      for (let j = 1; j < NJ; j++) arc[j] = arc[j - 1] + Math.hypot(shape.u[j] - shape.u[j - 1], shape.y[j] - shape.y[j - 1]);
      // Texture σ: the rest σ on the back slope; through the lip a compressed 0.6 H (the lip's
      // own arc can be 3-4 H, which the trough ahead would then have to squeeze back out); arc
      // length down the face; easing back to the rest σ through the front blend zone.
      const jA = J_LIP0 - 1;
      const lipSpan = 1.5;
      for (let j = 0; j < NJ; j++) {
        const oc = ((p * NK + k) * NJ + j) * 4;
        let t: number;
        if (j <= jA) t = sigma0[j];
        else if (j < J_FACE0) t = sigma0[jA] + (lipSpan * (j - jA)) / (J_FACE0 - jA);
        else t = sigma0[jA] + lipSpan + arc[j] - arc[J_FACE0 - 1];
        c[oc] = j <= jA ? t : mix(sigma0[j], t, blendW(sigma0[j]));
      }
      for (let j = 0; j < NJ; j++) {
        const o = ((p * NK + k) * NJ + j) * 4;
        const u = shape.u[j];
        const y = shape.y[j];
        // SSS light path (H units): across the lip it's the lip's own thickness (the low sun
        // crosses it at a slant); on the face it's the water above this point along the steep
        // refracted sun (≈ 43° down), capped by the crest chord at this height.
        const lip = j >= J_LIP0 && j < J_FACE0;
        const below = Math.max(0, Y_CREST - y);
        const faceChord = chordAt(shape, y);
        const path = lip ? shape.th[j] * 1.25 : Math.min(below / 0.68 + 0.05, faceChord + 0.05);
        a[o] = u;
        a[o + 1] = y;
        a[o + 2] = path;
        a[o + 3] = lip ? shape.th[j] : faceChord;
        // Foam: the lip's leading edge feathers after it's thrown; the landing zone and roller
        // are whitewater; the clean face stays clear until the collapse.
        b[o] = foamAt(j, phi, kappa, T, u);
        // Rest σ for texture/state sampling: the first keyframe's u in the blend zones (so the
        // swell point and the breaker point line up there), monotone across the lip and face.
        const sig = sigma0[j];
        b[o + 1] = sig;
        b[o + 2] = blendW(sig);
        // Tube membership (for the tube ceiling glow / B1): lip inner surface and face while open.
        const open = smooth(T.launch, T.launch + 0.5, phi) * (1 - smooth(T.collapse0, T.collapse1, phi)) * kappa;
        const land = T.sImp * 0.82 + 0.1;
        const floor = j >= J_FRONT0 ? 1 - smooth(land - 0.3, land + 0.2, u) : 0;
        b[o + 3] = (j >= J_LIP0 + J_LIP / 2 && j < J_FRONT0 ? 1 : floor) * open;
      }
    }
  }
  return { a, b, c };
}

/** Horizontal chord (H units) through the water body at height y (back slope → face). */
function chordAt(s: Shape, y: number) {
  // Back crossing: last point on A..B rising through y; front crossing: first point on E below y.
  let ub = s.u[0];
  for (let j = 1; j < J_LIP0 + 4; j++) {
    if (s.y[j - 1] <= y && s.y[j] >= y) {
      const f = (y - s.y[j - 1]) / (s.y[j] - s.y[j - 1] || 1);
      ub = mix(s.u[j - 1], s.u[j], f);
    }
  }
  let uf = s.u[J_FRONT0 - 1];
  for (let j = J_FACE0; j < J_FRONT0; j++) {
    if (s.y[j - 1] >= y && s.y[j] <= y) {
      const f = (s.y[j - 1] - y) / (s.y[j - 1] - s.y[j] || 1);
      uf = mix(s.u[j - 1], s.u[j], f);
      break;
    }
  }
  return Math.max(0.05, uf - ub);
}

function foamAt(j: number, phi: number, kappa: number, T: ReturnType<typeof stageTimes>, u: number) {
  const lipMid = J_LIP0 + J_LIP / 2;
  // Position along the lip set: −1 at the outer root, 0 at the tip, +1 at the inner root.
  const q = (j - lipMid) / (J_LIP / 2);
  const dTip = Math.abs(q);
  const inLip = j >= J_LIP0 && j < J_FACE0;
  const land = T.sImp * 0.82 + 0.1;
  let f = 0;
  // The lip's leading edge feathers once it's thrown: the outer side and the very tip (the
  // ceiling seen from inside stays glassy).
  if (inLip) f = Math.max(f, smooth(T.launch + 0.5, T.imp, phi) * (1 - smooth(q < 0 ? 0.06 : 0.02, q < 0 ? 0.3 : 0.1, dTip)) * 0.7);
  // The rim of the thrown lip is torn white from the moment it pitches (seen from inside the tube
  // it's the bright edge of the ceiling, not a dark refracting rim).
  if (inLip) f = Math.max(f, smooth(T.launch, T.launch + 0.4, phi) * (1 - smooth(0.015, 0.06, dTip)) * 0.55 * kappa);
  // After the landing: the curtain's outer face and tip turn to whitewater; the tube's ceiling and
  // floor stay clear water until the collapse (you can see out of the barrel).
  const post = smooth(T.imp - 0.15, T.imp + 0.35, phi);
  if (inLip) f = Math.max(f, post * (q < 0 ? 0.55 + 0.45 * (1 - dTip) : 1 - smooth(0.03, 0.2, q)));
  // Ahead of the curtain the explosion's foam spreads over the trough (not behind it, in the tube).
  if (j >= J_FRONT0) f = Math.max(f, post * smooth(land - 0.25, land + 0.3, u) * (1 - smooth(land + 0.8, land + 3.6, u)));
  // The roller: solid whitewater over its whole front and top.
  const roll = Math.min(1, smooth(T.collapse0 - 0.3, T.collapse1, phi) + (kappa < 0.01 ? smooth(-0.5, 1.5, phi) : 0));
  if (j >= J_LIP0 && j < J_FRONT0) f = Math.max(f, roll);
  if (j >= J_FRONT0) f = Math.max(f, roll * (1 - smooth(0.2, 2.0, u - 1.2)));
  // (an old bore keeps only a narrow line on its front: the back and the trough ahead clear first)
  const old = smooth(7, 13, phi);
  if (j < J_LIP0) f = Math.max(f, roll * smooth(-2.5, -0.8, u) * 0.8 * (1 - old));
  if (j >= J_FRONT0) f *= 1 - 0.7 * old;
  if (j >= J_LIP0 && j < J_LIP0 + 12) f *= 1 - 0.8 * old;
  // Old bore: the roller foam thins into lace as the bore loses energy (the state's foam takes over).
  f *= 1 - 0.6 * smooth(7, PHI_END - 3, phi);
  return Math.min(1, f);
}

/**
 * CPU lookup of the tables at point j (integer) for stage pk[0] = φ and plunge pk[1] = κ
 * (bilinear in φ and κ, like the GPU's filtered fetch). Writes (u, y, path, chord) into outA and
 * (foam, σ, W, tube) into outB (either may be null). Zero-alloc: the doubles travel in typed
 * arrays (a double argument to a call V8 doesn't inline is boxed).
 */
export function lookupProfile(t: ProfileTables, j: number, pk: Float64Array, outA: Float64Array | null, outB: Float64Array | null) {
  let kf = (pk[0] - PHI0) / DPHI;
  kf = kf < 0 ? 0 : kf > NK - 1 ? NK - 1 : kf;
  const kap = pk[1];
  const pf = (kap < 0 ? 0 : kap > 1 ? 1 : kap) * (NP - 1);
  const k0 = Math.min(NK - 2, Math.floor(kf));
  const p0 = Math.min(NP - 2, Math.floor(pf));
  const fk = kf - k0;
  const fp = pf - p0;
  const jj = j < 0 ? 0 : j > NJ - 1 ? NJ - 1 : j;
  const i00 = ((p0 * NK + k0) * NJ + jj) * 4;
  const i01 = ((p0 * NK + k0 + 1) * NJ + jj) * 4;
  const i10 = (((p0 + 1) * NK + k0) * NJ + jj) * 4;
  const i11 = (((p0 + 1) * NK + k0 + 1) * NJ + jj) * 4;
  const w00 = (1 - fk) * (1 - fp);
  const w01 = fk * (1 - fp);
  const w10 = (1 - fk) * fp;
  const w11 = fk * fp;
  for (let c = 0; c < 4; c++) {
    if (outA) outA[c] = t.a[i00 + c] * w00 + t.a[i01 + c] * w01 + t.a[i10 + c] * w10 + t.a[i11 + c] * w11;
    if (outB) outB[c] = t.b[i00 + c] * w00 + t.b[i01 + c] * w01 + t.b[i10 + c] * w10 + t.b[i11 + c] * w11;
  }
}
