// The pier's construction plan: where every plank, stringer, piling, brace, post and rope span
// goes. Pure data computed once at boot from PIER (world/layout.ts) and the terrain height, so
// the steps and piling lengths follow whatever the beach and seabed owners do to the ground.
//
// Local frame: the deck runs along X (root at PIER.rootX on the sand, tip at PIER.tipX in the
// channel); planks run across it along Z. Heights are absolute (sea level 0).

import { PIER } from '../world/layout';

export const DECK_TOP = PIER.deckHeight;
export const HALF_W = PIER.width / 2;

export const PLANK = { t: 0.042, w: 0.14, gapMin: 0.011, gapMax: 0.021 };
export const STRINGER = { w: 0.075, h: 0.25, z: [-1.42, -0.71, 0, 0.71, 1.42] };
export const STRINGER_BOTTOM = DECK_TOP - PLANK.t - STRINGER.h;
export const PILE = { z: 1.42, rMin: 0.155, rMax: 0.195, embed: 2.2 };
export const CAP = { t: 0.075, h: 0.3, len: 3.55 };
export const RIM = { t: 0.05, h: 0.28 };
export const POST = { s: 0.1, z: HALF_W + RIM.t + 0.05, bottom: DECK_TOP - 0.3, top: DECK_TOP + 1.0, spacing: 2 };
export const RAIL = { w: 0.14, h: 0.055 };
export const ROPE = { r: 0.0135, heights: [0.66, 0.33], sag: 0.035 };
export const BRACE = { t: 0.05, w: 0.2 };
export const STAIR = { halfW: 1.0, tread: 0.285, maxRise: 0.19 };
export const LAMP = { top: DECK_TOP + 2.35, s: 0.12, arm: 0.42 };
/**
 * [surf] The open end: a gap in the tip rail (half-width, centred on the deck) with a timber swim
 * ladder hanging off the deck end, down into the channel: round stiles (shaded like the pilings:
 * tide band, algae, barnacles) topped just under the deck and bolted back to the tip cap, flat
 * treads every `pitch`. Nothing stands above the deck in the gap (it's also the jump), so a
 * climber steps up holding the gap posts.
 */
export const GAP = { half: 0.7 };
export const LADDER = { x: PIER.tipX - 0.4, half: 0.3, r: 0.045, bottom: -1.9, top: DECK_TOP - 0.03, tread0: -1.5, pitch: 0.3 };

/** Deterministic PRNG (mulberry32) so the pier is identical on every boot. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One board instance: centre, half-extents in its own frame, a yaw/pitch/roll and the
 * per-instance shading seeds. `axis` is the grain direction in the board's local frame.
 */
export interface Board {
  x: number;
  y: number;
  z: number;
  /** Euler rotation (radians), order 'YXZ'. Board geometry has its grain along local +Z. */
  rx: number;
  ry: number;
  rz: number;
  /** Scale along the grain relative to the geometry's nominal length. */
  lenScale: number;
  seed: [number, number, number, number];
  env: [number, number, number, number];
}

export interface Pile {
  x: number;
  z: number;
  r: number;
  bottom: number;
  top: number;
  ground: number;
  seed: [number, number, number, number];
}

export interface Span {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  sag: number;
}

export interface Lamp {
  x: number;
  z: number;
  /** +1 or -1: which side of the deck; the arm reaches toward the centre line. */
  side: number;
}

export interface PierPlan {
  bents: number[];
  planks: Board[];
  treads: Board[];
  stringers: Board[];
  caps: Board[];
  rims: Board[];
  posts: Board[];
  rails: Board[];
  braces: Board[];
  piles: Pile[];
  ropes: Span[];
  /** Rope whippings round the top rail: x, y, z, unused (axis along X). */
  hitches: number[];
  lamps: Lamp[];
  stair: { x0: number; x1: number; rise: number; steps: number; bottom: number };
  /** [surf] Heights of the swim ladder's treads (bottom first). */
  ladder: number[];
}

/** Spray exposure 0..1 from the break: the seaward end and the reef side see the most. */
export function sprayExposure(x: number) {
  const t = Math.min(1, Math.max(0, (-40 - x) / 110));
  return t * t * (3 - 2 * t);
}

export function buildPlan(height: (x: number, z: number) => number): PierPlan {
  const r = rng(0x9e3779b1);
  const rnd = (a: number, b: number) => a + (b - a) * r();
  const seed = (bleach: number, lenScale = 1): [number, number, number, number] => [r(), r(), bleach, lenScale];
  const Z = PIER.z;

  const bents: number[] = [];
  for (let x = PIER.rootX; x >= PIER.tipX - 0.01; x -= PIER.pilingSpacing) bents.push(x);

  // ── Deck planks: running across the pier, butted edge to edge with irregular gaps. ──
  const planks: Board[] = [];
  let px = PIER.rootX + 0.06;
  while (px - PLANK.w > PIER.tipX - 0.12) {
    const cx = px - PLANK.w / 2;
    const fresh = r() < 0.035; // the odd replacement plank: less bleached, warmer
    const g = height(cx, Z);
    // [surf] Where people stand at the open end, drip after climbing out and jump: worn darker,
    // less bleached, damp.
    const worn = cx < PIER.tipX + 0.9 ? 1 - (cx - PIER.tipX) / 0.9 : 0;
    planks.push({
      x: cx,
      y: DECK_TOP - PLANK.t / 2 + rnd(-0.0025, 0.0015),
      z: Z + rnd(-0.012, 0.012),
      rx: rnd(-0.004, 0.004),
      ry: rnd(-0.0035, 0.0035),
      rz: rnd(-0.004, 0.004),
      lenScale: rnd(0.992, 1.0),
      seed: seed((fresh ? rnd(0.15, 0.35) : rnd(0.5, 1.0)) * (1 - 0.55 * worn)),
      env: [g, Math.max(sprayExposure(cx), worn), r(), fresh ? 1 : 0],
    });
    px -= PLANK.w + rnd(PLANK.gapMin, PLANK.gapMax);
  }

  // ── Stringers: five lines under the planks, one segment per bay, joints over the caps. ──
  const stringers: Board[] = [];
  const caps: Board[] = [];
  const rims: Board[] = [];
  const braces: Board[] = [];
  const piles: Pile[] = [];
  for (let i = 0; i < bents.length - 1; i++) {
    const x0 = bents[i];
    const x1 = bents[i + 1];
    const cx = (x0 + x1) / 2;
    const env: [number, number, number, number] = [height(cx, Z), sprayExposure(cx), 0, 0];
    for (let s = 0; s < STRINGER.z.length; s++) {
      stringers.push({
        x: cx,
        y: STRINGER_BOTTOM + STRINGER.h / 2,
        z: Z + STRINGER.z[s] + rnd(-0.01, 0.01),
        rx: rnd(-0.002, 0.002),
        ry: Math.PI / 2 + rnd(-0.002, 0.002),
        rz: rnd(-0.002, 0.002),
        lenScale: 1,
        seed: seed(rnd(0.1, 0.3)),
        env: [env[0], env[1], r(), 0],
      });
    }
    for (let s = -1; s <= 1; s += 2) {
      rims.push({
        x: cx,
        y: DECK_TOP - 0.012 - RIM.h / 2,
        z: Z + s * (HALF_W + RIM.t / 2),
        rx: rnd(-0.0015, 0.0015),
        ry: Math.PI / 2,
        rz: 0,
        lenScale: 1,
        seed: seed(rnd(0.55, 0.85)),
        env: [env[0], env[1], r(), 0],
      });
    }
  }

  // ── Bents: two pilings, a double cap bolted either side of them, and an X-brace. ──
  for (let i = 0; i < bents.length; i++) {
    const bx = bents[i];
    const exp = sprayExposure(bx);
    let rMax = 0;
    for (let s = -1; s <= 1; s += 2) {
      const pz = Z + s * PILE.z + rnd(-0.03, 0.03);
      const pxx = bx + rnd(-0.04, 0.04);
      const pr = rnd(PILE.rMin, PILE.rMax);
      rMax = Math.max(rMax, pr);
      const ground = height(pxx, pz);
      piles.push({
        x: pxx,
        z: pz,
        r: pr,
        bottom: ground - PILE.embed,
        top: STRINGER_BOTTOM + 0.004,
        ground,
        seed: [r(), r(), r(), r()],
      });
    }
    for (let s = -1; s <= 1; s += 2) {
      caps.push({
        x: bx + s * (rMax + CAP.t / 2 + 0.004),
        y: STRINGER_BOTTOM - CAP.h / 2 + 0.03,
        z: Z + rnd(-0.03, 0.03),
        rx: 0,
        ry: rnd(-0.004, 0.004),
        rz: rnd(-0.004, 0.004),
        lenScale: 1,
        seed: seed(rnd(0.2, 0.45)),
        env: [height(bx, Z), exp, r(), 0],
      });
    }
    // X-brace in the plane of the bent, one board on each face of the pilings.
    const ground = Math.max(height(bx, Z - PILE.z), height(bx, Z + PILE.z));
    const yTop = STRINGER_BOTTOM - CAP.h + 0.05;
    const yLow = Math.max(0.55, ground + 0.45);
    if (yTop - yLow > 0.9 && i % 2 === 1 && bx < 0) {
      const dz = 2 * (PILE.z + 0.1);
      const dy = yTop - yLow;
      const len = Math.hypot(dz, dy);
      const ang = Math.atan2(dy, dz);
      for (let s = -1; s <= 1; s += 2) {
        braces.push({
          x: bx + s * (rMax + BRACE.t / 2 + 0.006),
          y: (yTop + yLow) / 2,
          z: Z,
          // Board grain along local Z; tilt it within the YZ plane.
          rx: s * ang,
          ry: 0,
          rz: 0,
          lenScale: len / 4,
          seed: seed(rnd(0.2, 0.5), len / 4),
          env: [ground, exp, r(), 1],
        });
      }
    }
  }

  // Longitudinal sway braces on the outer faces, every third bay (seaward of the sand).
  for (let i = 1; i < bents.length - 1; i += 3) {
    const x0 = bents[i];
    const x1 = bents[i + 1];
    const g = Math.max(height(x0, Z), height(x1, Z));
    const yTop = STRINGER_BOTTOM - CAP.h + 0.05;
    const yLow = Math.max(0.7, g + 0.5);
    if (yTop - yLow < 1.2) continue;
    const dx = x0 - x1;
    const dy = yTop - yLow;
    const len = Math.hypot(dx, dy);
    for (let s = -1; s <= 1; s += 2) {
      braces.push({
        x: (x0 + x1) / 2,
        y: (yTop + yLow) / 2,
        z: Z + s * (PILE.z + PILE.rMax + BRACE.t / 2 + 0.01),
        // Grain along local Z → rotate it to run along X, then tilt within the XY plane.
        rx: Math.atan2(dy, dx) * (i % 2 ? 1 : -1),
        ry: Math.PI / 2,
        rz: 0,
        lenScale: len / 4,
        seed: seed(rnd(0.2, 0.5), len / 4),
        env: [g, sprayExposure((x0 + x1) / 2), r(), 1],
      });
    }
  }

  // ── Railing: posts every 2 m (offset 1 m from the bents so they clear the cap ends). ──
  const posts: Board[] = [];
  const rails: Board[] = [];
  const ropes: Span[] = [];
  const hitches: number[] = [];
  const lamps: Lamp[] = [];
  const postX: number[] = [];
  for (let x = PIER.rootX - 1; x > PIER.tipX; x -= POST.spacing) postX.push(x);
  const lampEvery = 21; // posts (42 m)
  const addPost = (x: number, z: number, isLamp: boolean, bottom = POST.bottom, top = isLamp ? LAMP.top : POST.top) => {
    posts.push({
      x,
      y: (top + bottom) / 2,
      z,
      rx: -Math.PI / 2 + rnd(-0.006, 0.006),
      ry: rnd(-0.03, 0.03),
      rz: rnd(-0.006, 0.006),
      lenScale: (top - bottom) / 1.3,
      seed: seed(rnd(0.6, 0.95), (top - bottom) / 1.3),
      env: [height(x, Z), sprayExposure(x), r(), isLamp ? 1 : 0],
    });
  };
  for (let s = -1; s <= 1; s += 2) {
    const zc = Z + s * POST.z;
    for (let k = 0; k < postX.length; k++) {
      const isLamp = (k + (s > 0 ? 0 : Math.floor(lampEvery / 2))) % lampEvery === 3;
      addPost(postX[k], zc, isLamp);
      if (isLamp) lamps.push({ x: postX[k], z: zc, side: s });
    }
    // Corner posts at the tip, and rails/ropes between consecutive posts.
    addPost(PIER.tipX + 0.02, zc, s > 0);
    const xs = postX.concat([PIER.tipX + 0.02]);
    for (let k = 0; k + 1 < xs.length; k++) {
      const x0 = xs[k];
      const x1 = xs[k + 1];
      for (let h = 0; h < ROPE.heights.length; h++) {
        const y = DECK_TOP + ROPE.heights[h];
        ropes.push({ x0, y0: y, z0: zc, x1, y1: y, z1: zc, sag: ROPE.sag * (0.7 + 0.6 * r()) * (Math.abs(x1 - x0) / 2) });
      }
    }
    // Rope whippings bind the top rail over every rail joint (and hide the butt joint).
    for (let k = 0; k < xs.length; k += 3) hitches.push(xs[k], POST.top + RAIL.h / 2, zc, 0);
    // Top rail in 6 m lengths (three bays of posts), jointed over a post.
    for (let k = 0; k < xs.length - 1; k += 3) {
      const x0 = xs[k] + 0.06;
      const x1 = xs[Math.min(xs.length - 1, k + 3)] - (k + 3 >= xs.length - 1 ? 0.06 : 0);
      const len = x0 - x1;
      rails.push({
        x: (x0 + x1) / 2,
        y: POST.top + RAIL.h / 2,
        z: zc + rnd(-0.004, 0.004),
        rx: 0,
        ry: Math.PI / 2,
        rz: rnd(-0.001, 0.001),
        lenScale: len / 6,
        seed: seed(rnd(0.75, 1.0), len / 6),
        env: [height((x0 + x1) / 2, Z), sprayExposure((x0 + x1) / 2), r(), 0],
      });
    }
  }
  // Tip rail across the end of the deck, with its ropes. [surf] Open in the middle: a gap
  // between two posts (the jump and the ladder), each half railed and roped from its corner.
  {
    const x = PIER.tipX + 0.02;
    const za = Z - POST.z;
    const zb = Z + POST.z;
    const ga = Z - GAP.half;
    const gb = Z + GAP.half;
    addPost(x, ga, false);
    addPost(x, gb, false);
    for (let k = 0; k < 2; k++) {
      const z0 = k === 0 ? za : gb;
      const z1 = k === 0 ? ga : zb;
      rails.push({
        x,
        y: POST.top + RAIL.h / 2,
        z: (z0 + z1) / 2,
        rx: 0,
        ry: 0,
        rz: 0,
        lenScale: (z1 - z0 + 0.12) / 6,
        seed: seed(0.9, (z1 - z0) / 6),
        env: [height(x, Z), 1, r(), 0],
      });
      for (let h = 0; h < ROPE.heights.length; h++) {
        const y = DECK_TOP + ROPE.heights[h];
        ropes.push({ x0: x, y0: y, z0, x1: x, y1: y, z1, sag: 0.018 });
      }
    }
    lamps.push({ x: PIER.tipX + 0.02, z: Z + POST.z, side: 1 });
  }

  // [surf] Swim ladder off the tip bent's outer cap: two round stiles from below the tide line up
  // past the deck as grab rails, flat treads between them.
  const ladder: number[] = [];
  {
    const lx = LADDER.x;
    for (let s = -1; s <= 1; s += 2) {
      const lz = Z + s * LADDER.half;
      piles.push({
        x: lx,
        z: lz,
        r: LADDER.r,
        bottom: LADDER.bottom,
        top: LADDER.top,
        ground: height(lx, lz),
        seed: [r(), r(), r(), r()],
      });
    }
    // Standoffs from each stile's head back to the tip cap (the ladder is bolted to the bent).
    const capFace = PIER.tipX - 0.24;
    for (let s = -1; s <= 1; s += 2) {
      const len = capFace - lx + 0.06;
      rails.push({
        x: (lx + capFace) / 2,
        y: DECK_TOP - 0.2,
        z: Z + s * LADDER.half,
        rx: 0,
        ry: Math.PI / 2,
        rz: 0,
        lenScale: len / 6,
        seed: seed(0.5, 0.1),
        env: [height(lx, Z), 1, r(), 0],
      });
    }
    for (let y = LADDER.tread0; y < DECK_TOP - 0.2; y += LADDER.pitch) {
      ladder.push(y);
      rails.push({
        x: lx,
        y,
        z: Z,
        rx: rnd(-0.01, 0.01),
        ry: 0,
        rz: rnd(-0.006, 0.006),
        lenScale: (2 * LADDER.half + 0.06) / 6,
        seed: seed(y > 0.8 ? rnd(0.4, 0.7) : 0.2, 0.1),
        env: [height(lx, Z), 1, r(), 0],
      });
    }
  }

  // ── Stairs at the root: straight down from the deck onto the sand, landward (+X). ──
  let steps = 1;
  let rise = 0;
  let x1 = PIER.rootX;
  for (let n = 2; n < 30; n++) {
    x1 = PIER.rootX + (n - 1) * STAIR.tread;
    const g = height(x1 + 0.3, Z);
    rise = (DECK_TOP - g) / n;
    steps = n;
    if (rise <= STAIR.maxRise) break;
  }
  const bottom = DECK_TOP - steps * rise;
  const treads: Board[] = [];
  for (let i = 1; i < steps; i++) {
    const top = DECK_TOP - i * rise;
    const xa = PIER.rootX + (i - 1) * STAIR.tread + 0.01;
    for (let k = 0; k < 2; k++) {
      const w = (STAIR.tread - 0.02) / 2;
      treads.push({
        x: xa + w / 2 + k * (w + 0.008),
        y: top - PLANK.t / 2,
        z: Z + rnd(-0.008, 0.008),
        rx: rnd(-0.003, 0.003),
        ry: rnd(-0.004, 0.004),
        rz: rnd(-0.004, 0.004),
        lenScale: 1,
        seed: seed(rnd(0.7, 1.0)),
        env: [height(xa, Z), 0, r(), 0],
      });
    }
  }
  // Stair stringers: sloped boards either side, from the deck edge down into the sand.
  const run = x1 - PIER.rootX + STAIR.tread;
  const slope = Math.atan2(DECK_TOP - bottom, run);
  const sLen = Math.hypot(run, DECK_TOP - bottom) + 0.3;
  for (let s = -1; s <= 1; s += 2) {
    stringers.push({
      x: PIER.rootX + run / 2 + 0.05,
      y: (DECK_TOP + bottom) / 2 - 0.2,
      z: Z + s * (STAIR.halfW + 0.03),
      rx: slope,
      ry: Math.PI / 2,
      rz: 0,
      lenScale: sLen / 6,
      seed: seed(0.4, sLen / 6),
      env: [bottom, 0, r(), 0],
    });
  }
  // Stair handrails: a post at the top and the bottom each side, a sloped rail, one rope.
  for (let s = -1; s <= 1; s += 2) {
    const zc = Z + s * (STAIR.halfW + 0.11);
    const xb = PIER.rootX + run - 0.05;
    const yBotTop = bottom + 1.0;
    addPost(PIER.rootX + 0.08, zc, false);
    addPost(xb, zc, false, bottom - 0.6, yBotTop);
    // Close the deck-end gap between the stair and the deck railing.
    const zo = Z + s * POST.z;
    addPost(PIER.rootX + 0.02, zo, false);
    rails.push({
      x: PIER.rootX + 0.05,
      y: POST.top + RAIL.h / 2,
      z: (zc + zo) / 2,
      rx: 0,
      ry: 0,
      rz: 0,
      lenScale: (Math.abs(zo - zc) + 0.14) / 6,
      seed: seed(0.9, 0.1),
      env: [height(PIER.rootX, Z), 0, r(), 0],
    });
    const xTop = PIER.rootX + 0.08;
    const yTop = POST.top + RAIL.h / 2;
    const yBot = yBotTop + RAIL.h / 2;
    const len = Math.hypot(xb - xTop, yTop - yBot);
    rails.push({
      x: (xTop + xb) / 2,
      y: (yTop + yBot) / 2,
      z: zc,
      rx: Math.atan2(yTop - yBot, xb - xTop),
      ry: Math.PI / 2,
      rz: 0,
      lenScale: (len + 0.1) / 6,
      seed: seed(0.85, len / 6),
      env: [bottom, 0, r(), 0],
    });
    ropes.push({
      x0: xTop,
      y0: DECK_TOP + ROPE.heights[0] - 0.05,
      z0: zc,
      x1: xb,
      y1: yBot - 0.34,
      z1: zc,
      sag: 0.05,
    });
  }

  return {
    bents,
    planks,
    treads,
    stringers,
    caps,
    rims,
    posts,
    rails,
    braces,
    piles,
    ropes,
    hitches,
    lamps,
    stair: { x0: PIER.rootX, x1: PIER.rootX + run, rise, steps, bottom },
    ladder,
  };
}
