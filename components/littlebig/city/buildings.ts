// Building geometry: each plan Building becomes chunky toon geometry in its own local frame
// (x along the frontage, y up, z into the lot; the front faces −z), merged into the city mesh.
// Everything stays inside the plan box (w × d × h; thin props may poke ≤ 3 m above), which is what
// collision uses: walls are inset so cornices, eaves, canopies and awnings reach the box edge at most.
//
// Street level is where the descent lands, so every building has an entrance: a recessed shop
// floor under the overhang of the floors above (shopfronts with mullions on every face that meets a
// street, sparse windows elsewhere), a door with a canopy on the front, a downpipe or two, and on
// some side walls a painted ad panel. The café the street viewpoint looks at gets an awning, a blade
// sign and a lettered fascia.

import { Color } from 'three';
import { PALETTE } from '../render/palette';
import { Rng } from '../world/rng';
import { planBasis, toSphere } from '../world/city/frame';
import { stadiumMasts, stadiumRing } from '../world/city/index-grid';
import type { Building } from '../world/city/types';
import { v3 } from '../world/sphere';
import { F, Geo, K, type Xf } from './geo';

const WHITE = new Color(1, 1, 1);
const tmp = new Color();
const shade = (c: Color, k: number) => tmp.copy(c).multiplyScalar(k);
const tint = (c: Color, to: Color, k: number) => tmp.copy(c).lerp(to, k);

/** Awning stripe colours (with cream). */
const AWNINGS = [new Color('#E2543F'), new Color('#2F8F8A'), new Color('#F2A93B'), new Color('#5866B8'), new Color('#7FB04A')];
const CREAM = new Color('#FFF6E4');
const METAL = new Color('#8C93A3');
const DARK = new Color('#3B3F4C');
const INK = new Color('#2A2342');
const SUNSET = new Color('#F28A5B');
const SEA = new Color('#2F6FB8');
const _hsl = { h: 0, s: 0, l: 0 };
const GLASS_DOOR = new Color('#26384A');
const PIPE = new Color('#6E7482');
const SKY_GLASS = new Color('#9FD3F2');
const HOUSE_GREEN = new Color('#2F7F78');

const _B = { up: v3(), ax: v3(), az: v3() };

/** Flat-roof membranes, by Building.roofColor: warm clay, slate, cool grey. */
const FLAT_ROOFS = [new Color('#B9775F'), new Color('#6C7891'), new Color('#8A93A3')];
const GREEN_ROOF = new Color('#6BB24A');

/** Per-building context the renderer works out from the plan and index. */
export interface BuildCtx {
  /** Whether face (0 front, 1 right, 2 back, 3 left) of b looks onto a street. */
  roadFace(b: Building, face: number): boolean;
  /** The tallest tower (gets the helipad). */
  tallest: number;
}

const DEFAULT_CTX: BuildCtx = { roadFace: (_b, f) => f === 0, tallest: -1 };

function flatRoof(b: Building, rng: Rng): { color: Color; garden: boolean } {
  const garden = (b.style === 'midrise' || b.style === 'office') && rng.chance(0.28);
  return { color: garden ? GREEN_ROOF : FLAT_ROOFS[b.roofColor] ?? FLAT_ROOFS[1], garden };
}

/** The building's local frame (planBasis columns: footprints match their plan box exactly). */
export function frameFor(x: number, z: number, angle: number, h = 0): Xf {
  planBasis(x, z, _B);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const o = toSphere(x, z, h);
  return {
    o,
    ex: v3(_B.ax.x * c + _B.az.x * s, _B.ax.y * c + _B.az.y * s, _B.ax.z * c + _B.az.z * s),
    ey: v3(_B.up.x, _B.up.y, _B.up.z),
    ez: v3(-_B.ax.x * s + _B.az.x * c, -_B.ax.y * s + _B.az.y * c, -_B.ax.z * s + _B.az.z * c),
  };
}

const facadeParam = (style: number, seed: number) => style * 1024 + (seed % 1024);

/**
 * Floor coordinates for a wall spanning y0..y1: v = 0 at street level (0.2 m, or y0 if higher),
 * one unit per floor of about `floor` metres; the buried base gets negative v.
 */
function vr(y0: number, y1: number, floor: number): [number, number] {
  const base = Math.max(y0, 0.2);
  const nf = Math.max(1, Math.round((y1 - base) / floor));
  const fh = (y1 - base) / nf;
  return [(y0 - base) / fh, nf];
}

/** Bays / floors grid for a wall: the face's [u0, u1, v0, v1]. */
function grid(width: number, y0: number, y1: number, bay: number, floor: number): [number, number, number, number] {
  return [0, Math.max(1, Math.round(width / bay)), ...vr(y0, y1, floor)];
}

export function buildBuilding(g: Geo, b: Building, delay: number, ctx: BuildCtx = DEFAULT_CTX): void {
  const xf = frameFor(b.x, b.z, b.angle);
  const rng = new Rng(b.seed || 1);
  g.pivot.x = xf.o.x;
  g.pivot.y = xf.o.y;
  g.pivot.z = xf.o.z;
  g.delay = delay;
  if (b.landmark === 'clocktower') return clockTower(g, xf, b);
  if (b.landmark === 'stadium') return stadium(g, xf, b);
  if (b.landmark === 'church') return churchB(g, xf, b);
  switch (b.style) {
    case 'house':
      return house(g, xf, b, rng);
    case 'shop':
      return b.roof === 'gable' ? cornerShop(g, xf, b, rng, ctx) : shop(g, xf, b, rng, ctx);
    default:
      return block(g, xf, b, rng, ctx);
  }
}

// ── Entrances ──

/**
 * A door on a wall facing −z at z = zf: a glazed door in a frame, a canopy reaching `reach` out,
 * a step. `wide` = double doors (lobbies).
 */
function entrance(g: Geo, xf: Xf, x: number, zf: number, reach: number, frameC: Color, canopyC: Color, wide: boolean, y0 = 0.2) {
  const hw = wide ? 1.05 : 0.55;
  const top = y0 + (wide ? 2.6 : 2.25);
  g.kind = K.plain;
  g.param = 0;
  // frame (jambs and head, a little proud of the wall)
  g.color.copy(frameC);
  g.box(xf, x - hw - 0.14, x - hw, y0, top + 0.14, zf - 0.08, zf + 0.01, 0, { bottom: false });
  g.box(xf, x + hw, x + hw + 0.14, y0, top + 0.14, zf - 0.08, zf + 0.01, 0, { bottom: false });
  g.box(xf, x - hw - 0.14, x + hw + 0.14, top, top + 0.14, zf - 0.08, zf + 0.01, 0, { bottom: true });
  // glazed door leaves, set back a touch, with a bar and a handle
  g.color.copy(GLASS_DOOR);
  g.box(xf, x - hw, x + hw, y0, top, zf - 0.03, zf + 0.01, 0, { top: false });
  g.color.copy(frameC);
  if (wide) g.box(xf, x - 0.03, x + 0.03, y0, top, zf - 0.045, zf - 0.02, 0, { top: false });
  g.box(xf, x - hw + 0.04, x + hw - 0.04, y0 + 1.0, y0 + 1.06, zf - 0.06, zf - 0.03, 0);
  // canopy: a slab with a darker fascia
  if (reach > 0.15) {
    g.color.copy(canopyC);
    g.box(xf, x - hw - 0.5, x + hw + 0.5, top + 0.32, top + 0.46, zf - reach, zf, 0.04, { bottom: true });
  }
  // step
  g.color.copy(shade(PALETTE.road.sidewalk, 0.86));
  g.box(xf, x - hw - 0.2, x + hw + 0.2, y0 - 0.25, y0 + 0.08, zf - Math.min(0.45, reach), zf, 0);
}

/** A downpipe down a wall corner (local x, z of the corner, pushed `out` along (ox, oz)). */
function downpipe(g: Geo, xf: Xf, x: number, z: number, top: number) {
  g.color.copy(PIPE);
  g.kind = K.plain;
  g.box(xf, x - 0.06, x + 0.06, 0.1, top, z - 0.06, z + 0.06, 0, { top: false });
  g.box(xf, x - 0.1, x + 0.1, top - 0.12, top, z - 0.1, z + 0.1, 0);
}

/** A painted ad panel on a side wall facing ±x at x = xw (face sign sx), centred on zc. */
function adPanel(g: Geo, xf: Xf, xw: number, sx: number, zc: number, y0: number, w: number, h: number, rng: Rng) {
  g.kind = K.plain;
  const x0 = sx > 0 ? xw : xw - 0.06;
  g.color.copy(INK);
  g.box(xf, x0, x0 + 0.06, y0, y0 + h, zc - w / 2, zc + w / 2, 0.03, { bottom: true });
  poster(g, xf, (a, y, k, out) => {
    out[0] = xw + sx * (0.065 + 0.02 * k);
    out[1] = y0 + y;
    out[2] = zc + sx * a;
  }, [sx, 0, 0], w, h, rng);
}

/** Maps poster coordinates (a across from −w/2, y up from 0, layer k) to local xyz. */
type PosterMap = (a: number, y: number, k: number, out: number[]) => void;
const _pp = [0, 0, 0];
const POSTER_BG = [new Color('#8EC9F0'), new Color('#FFF1D6'), new Color('#E2543F'), new Color('#F2CC5B'), new Color('#3D9CA8'), new Color('#A99CDA')];

/**
 * An illustrated poster (flat shapes on an ink border), one of four motifs: a sun setting over the
 * sea, a curling wave, a soda bottle with a bold title, a two-colour diagonal stripe with a dot.
 */
function poster(g: Geo, xf: Xf, at: PosterMap, face: [number, number, number], w: number, h: number, rng: Rng) {
  const m = rng.int(0, 3);
  const hw = w / 2 - 0.09;
  const y0 = 0.09;
  const y1 = h - 0.09;
  const ph = y1 - y0;
  /** A convex polygon (poster coords a, y pairs, fanned from the first point) on layer k. */
  const poly = (pts: number[], k: number, c: Color) => {
    g.color.copy(c);
    const p: number[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      at(Math.max(-hw, Math.min(hw, pts[i])), Math.max(y0, Math.min(y1, pts[i + 1])), k, _pp);
      p.push(_pp[0], _pp[1], _pp[2]);
    }
    for (let i = 3; i + 5 < p.length; i += 3) g.triL(xf, [p[0], p[1], p[2], p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5]], [0, 0, 1, 0, 1, 1], face);
  };
  const rect = (a0: number, a1: number, b0: number, b1: number, k: number, c: Color) => poly([a0, b0, a1, b0, a1, b1, a0, b1], k, c);
  const disc = (ca: number, cy: number, r: number, k: number, c: Color) => {
    const pts: number[] = [];
    for (let i = 0; i < 14; i++) pts.push(ca + Math.cos((i / 14) * Math.PI * 2) * r, cy + Math.sin((i / 14) * Math.PI * 2) * r);
    poly(pts, k, c);
  };
  /** A band from the poster's foot up to a wavy top edge (one convex slice per segment). */
  const wave = (top: number, amp: number, ph0: number, k: number, c: Color) => {
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a0 = -hw + (2 * hw * i) / n;
      const a1 = -hw + (2 * hw * (i + 1)) / n;
      const t0 = top + amp * Math.sin(ph0 + (i / n) * Math.PI * 3);
      const t1 = top + amp * Math.sin(ph0 + ((i + 1) / n) * Math.PI * 3);
      poly([a0, y0, a1, y0, a1, t1, a0, t0], k, c);
    }
  };
  if (m === 0) {
    // sunset over the sea
    rect(-hw, hw, y0, y1, 0, POSTER_BG[3]);
    rect(-hw, hw, y0 + ph * 0.62, y1, 1, SUNSET);
    disc(-hw * 0.2, y0 + ph * 0.5, ph * 0.24, 2, CREAM);
    wave(y0 + ph * 0.36, ph * 0.04, 0.4, 3, SEA);
    rect(-hw * 0.38, -hw * 0.02, y0 + ph * 0.22, y0 + ph * 0.26, 4, CREAM);
    rect(-hw * 0.3, -hw * 0.1, y0 + ph * 0.12, y0 + ph * 0.15, 4, CREAM);
  } else if (m === 1) {
    // a curling wave under a little sun
    rect(-hw, hw, y0, y1, 0, POSTER_BG[1]);
    disc(hw * 0.55, y0 + ph * 0.74, ph * 0.13, 1, AWNINGS[2]);
    wave(y0 + ph * 0.5, ph * 0.1, 0, 1, AWNINGS[1]);
    wave(y0 + ph * 0.3, ph * 0.07, 2.2, 2, SEA);
    wave(y0 + ph * 0.13, ph * 0.04, 1.1, 3, SKY_GLASS);
  } else if (m === 2) {
    // a soda bottle and a bold title
    const bg = rng.chance(0.5) ? AWNINGS[0] : AWNINGS[3];
    rect(-hw, hw, y0, y1, 0, bg);
    const ba = -hw + Math.min(hw * 0.5, ph * 0.32);
    const bw = ph * 0.11;
    rect(ba - bw, ba + bw, y0 + ph * 0.1, y0 + ph * 0.56, 1, CREAM);
    poly([ba - bw, y0 + ph * 0.56, ba + bw, y0 + ph * 0.56, ba + bw * 0.42, y0 + ph * 0.7, ba - bw * 0.42, y0 + ph * 0.7], 1, CREAM);
    rect(ba - bw * 0.42, ba + bw * 0.42, y0 + ph * 0.7, y0 + ph * 0.84, 1, CREAM);
    rect(ba - bw * 0.5, ba + bw * 0.5, y0 + ph * 0.84, y0 + ph * 0.9, 2, INK);
    rect(ba - bw, ba + bw, y0 + ph * 0.28, y0 + ph * 0.42, 2, AWNINGS[2]);
    const t0 = ba + bw + ph * 0.18;
    rect(t0, hw - 0.1, y0 + ph * 0.52, y0 + ph * 0.74, 1, CREAM);
    rect(t0, t0 + (hw - 0.1 - t0) * 0.7, y0 + ph * 0.3, y0 + ph * 0.4, 1, CREAM);
  } else {
    // a bold two-colour diagonal stripe and a dot
    const bg = POSTER_BG[rng.int(0, POSTER_BG.length - 1)];
    rect(-hw, hw, y0, y1, 0, bg);
    const c2 = bg === AWNINGS[0] || bg === POSTER_BG[2] ? AWNINGS[1] : AWNINGS[0];
    const k = ph * 0.9;
    poly([-hw * 0.3, y0, -hw * 0.3 + ph * 0.4, y0, -hw * 0.3 + ph * 0.4 + k, y1, -hw * 0.3 + k, y1], 1, c2);
    poly([-hw * 0.3 + ph * 0.48, y0, -hw * 0.3 + ph * 0.6, y0, -hw * 0.3 + ph * 0.6 + k, y1, -hw * 0.3 + ph * 0.48 + k, y1], 1, CREAM);
    disc(-hw * 0.62, y0 + ph * 0.66, ph * 0.17, 2, CREAM);
  }
}

/**
 * Sign lettering on a board facing −z at z = zf (local x from a0 to a1, cap band y0..y1): words of
 * chunky rounded glyph blocks — mostly x-height, some ascenders, a capital to start each word.
 */
function lettering(g: Geo, xf: Xf, a0: number, a1: number, y0: number, y1: number, zf: number, ink: Color, rng: Rng) {
  g.color.copy(ink);
  const H = y1 - y0;
  const xh = H * 0.62;
  let x = a0;
  let start = true;
  let left = 3 + rng.int(0, 3);
  while (x < a1 - H * 0.3) {
    const cap = start;
    const tall = cap || rng.chance(0.22);
    const w = H * (cap ? 0.58 : 0.34 + rng.float() * 0.2);
    if (x + w > a1) break;
    g.box(xf, x, x + w, y0, y0 + (tall ? H : xh), zf - 0.025, zf, 0, { top: tall });
    x += w + H * 0.12;
    start = false;
    if (--left <= 0) {
      x += H * 0.4; // word gap
      start = true;
      left = 3 + rng.int(0, 4);
    }
  }
}

/** Ink colour for lettering on a board of colour c: dark on light boards, cream on dark ones. */
const inkOn = (c: Color) => (c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.55 ? INK : CREAM);

// ── Towers, offices, mid-rise: a recessed shop floor, stacked tiers, cornices, roof clutter ──

function block(g: Geo, xf: Xf, b: Building, rng: Rng, ctx: BuildCtx) {
  const wall = PALETTE.walls[b.wall] ?? PALETTE.walls[0];
  const glassWall = b.wall === 6;
  const style = b.style === 'office' ? F.ribbon : glassWall || (b.style === 'tower' && rng.chance(0.35)) ? F.curtain : F.punched;
  const floorH = b.style === 'tower' ? 3.3 : 3.2;
  const bay = style === F.curtain ? 2.4 : style === F.ribbon ? 2.8 : 2.6;
  const tiers = b.tiers?.length ? b.tiers : [{ h: b.h, inset: 0 }];
  const trim = tint(wall, WHITE, glassWall ? 0.7 : 0.45).clone();
  const podium = glassWall ? new Color('#E9E2D2') : tint(wall, DARK, 0.18).clone();
  const cafe = b.decor === 'cafe';
  const hasShops = cafe || b.frontEdge >= 0 && (b.zone === 'downtown' || rng.chance(0.6));
  const seed = b.seed;
  const ch = b.style === 'tower' ? 0.55 : 0.35;
  const roofTop = flatRoof(b, rng);
  const balconies = rng.chance(0.6);
  const balconyEvery = rng.chance(0.5) ? 1 : 2;
  const balconyRail = rng.chance(0.5) ? new Color('#F4EFE4') : tint(wall, WHITE, 0.6).clone();
  const canopyC = cafe ? AWNINGS[0] : rng.chance(0.5) ? DARK : AWNINGS[rng.int(0, AWNINGS.length - 1)];
  const door = b.door ?? 0;
  let y0 = -0.8;
  let topHW = 0;
  let topHD = 0;
  let topY = 0;
  tiers.forEach((t, i) => {
    const inset = t.inset + 0.28;
    const hw = b.w / 2 - inset;
    const hd = b.d / 2 - inset;
    if (hw < 1.5 || hd < 1.5) return;
    const y1 = t.h - 0.3;
    let ya = y0;
    if (i === 0) {
      // Ground floor recessed 0.62 m under the floors above: shopfronts on the street faces,
      // sparse windows on the others; the overhang's soffit and a ledge read as depth.
      const gy = Math.min(hasShops ? 4.2 : 3.6, y1 - 1);
      const rec = 0.62;
      const ghw = hw - rec;
      const ghd = hd - rec;
      g.color.copy(hasShops ? podium : shade(wall, 0.92));
      g.kind = K.facade;
      g.box(xf, -ghw, ghw, ya, gy, -ghd, ghd, ch * 0.6, {
        top: false,
        side: (f, w) => {
          const street = f === 0 || (cafe && f !== 2) || ctx.roadFace(b, f);
          g.param = facadeParam(hasShops && street ? F.shop : street ? F.punched : F.sparse, seed + f);
          return hasShops && street ? [0, Math.max(1, Math.round(w / 3.3)), ...vr(ya, gy, 10)] : [0, Math.max(1, Math.round(w / 2.6)), ...vr(ya, gy, 10)];
        },
      });
      // soffit of the overhang + a slim ledge
      g.kind = K.plain;
      g.color.copy(shade(trim, 0.8));
      g.box(xf, -hw, hw, gy, gy + 0.05, -hd, hd, ch, { top: false, bottom: true });
      g.color.copy(trim);
      g.box(xf, -hw - 0.12, hw + 0.12, gy + 0.05, gy + 0.3, -hd - 0.12, hd + 0.12, ch, { top: false, bottom: true });
      // the entrance, under the overhang, with a canopy (or the café front)
      if (cafe) {
        const col = cafeFront(g, xf, b, -ghw, ghw, -ghd, gy, door, rng);
        // one awning wrapping round the front corners and down both (glazed) sides, mitred at the
        // corners; the cantilevered overhang needs no corner columns here (they would cut it)
        const r = rec - 0.04;
        awningWrap(g, xf, [-ghw, ghd - 0.6, -ghw, -ghd, ghw, -ghd, ghw, ghd - 0.6], [-1, 0, 0, -1, 1, 0], [r, r, r], gy - 1.05, col);
      } else {
        entrance(g, xf, Math.max(-ghw + 1.3, Math.min(ghw - 1.3, door)), -ghd, rec - 0.04, trim, canopyC, b.style === 'tower' || b.style === 'office');
        // a column at each front corner carrying the overhang
        g.color.copy(trim);
        for (const sx of [-1, 1]) g.box(xf, sx * hw - 0.2, sx * hw + 0.2, -0.2, gy, -hd, -hd + 0.4, 0, { top: false });
      }
      // downpipes at the back corners
      downpipe(g, xf, -hw + 0.08, hd - 0.08, t.h);
      if (b.w > 9) downpipe(g, xf, hw - 0.08, hd - 0.08, t.h);
      ya = gy;
    }
    // Main shaft.
    g.color.copy(wall);
    g.kind = K.facade;
    g.param = facadeParam(style, seed + i * 17);
    const yb = ya;
    g.box(xf, -hw, hw, ya, y1, -hd, hd, ch, { top: false, side: (_f, w) => grid(w, yb, y1, bay, floorH) });
    if (b.style === 'midrise' && style === F.punched && i === 0 && balconies) {
      const faceW = 2 * hw - 2 * Math.min(ch, hw * 0.6, hd * 0.6);
      const nb = Math.max(1, Math.round(faceW / bay));
      const bw = faceW / nb;
      const [, nf] = vr(yb, y1, floorH);
      const base = Math.max(yb, 0.2);
      const fh = (y1 - base) / nf;
      for (let j = 1; j < nf; j++) {
        const y = base + j * fh + 0.04 * fh;
        for (let k = 0; k < nb; k++) {
          if (balconyEvery === 2 && (k + j) % 2) continue;
          const cx = -faceW / 2 + (k + 0.5) * bw;
          const hwB = bw * 0.36;
          g.color.copy(trim);
          g.box(xf, cx - hwB, cx + hwB, y - 0.12, y, -hd - 0.26, -hd, 0, { bottom: true });
          g.color.copy(balconyRail);
          g.box(xf, cx - hwB, cx + hwB, y, y + 0.55, -hd - 0.26, -hd - 0.22, 0);
          g.box(xf, cx - hwB, cx - hwB + 0.04, y, y + 0.55, -hd - 0.22, -hd, 0);
          g.box(xf, cx + hwB - 0.04, cx + hwB, y, y + 0.55, -hd - 0.22, -hd, 0);
        }
      }
    }
    // Cornice slab: its top is the roof (or the next tier's terrace).
    g.color.copy(trim);
    g.kind = K.plain;
    const co = 0.26;
    g.box(xf, -hw - co, hw + co, y1, t.h, -hd - co, hd + co, ch, { top: false, bottom: true });
    g.color.copy(roofTop.color);
    g.kind = roofTop.garden && i === tiers.length - 1 ? K.lawn : K.roof;
    g.param = 0;
    g.capRing(xf, ringOf(-hw - co, hw + co, -hd - co, hd + co, ch), t.h, true);
    y0 = t.h;
    topHW = hw;
    topHD = hd;
    topY = t.h;
  });
  if (!topHW) return;
  roofClutter(g, xf, b, rng, topHW, topHD, topY, wall, trim, roofTop.garden, ctx.tallest === b.id);
}

/**
 * The café: a lettered fascia, a blade sign and a door on a glazed front (the caller hangs the
 * striped awning, gy − 1.05, in the returned colour, wrapping it round the corners).
 */
function cafeFront(g: Geo, xf: Xf, b: Building, x0: number, x1: number, zf: number, gy: number, door: number, rng: Rng): Color {
  const col = AWNINGS[rng.int(0, 1)];
  // fascia sign board with "lettering" (dark blocks of varying width)
  g.kind = K.plain;
  g.color.copy(CREAM);
  g.box(xf, x0 + 0.4, x1 - 0.4, gy - 0.95, gy - 0.25, zf - 0.08, zf, 0, { bottom: true });
  g.color.copy(col);
  g.box(xf, x0 + 0.5, x1 - 0.5, gy - 0.88, gy - 0.32, zf - 0.1, zf - 0.08, 0);
  const half = Math.min(2.4, (x1 - x0) / 2 - 1);
  lettering(g, xf, -half, half, gy - 0.78, gy - 0.42, zf - 0.1, inkOn(col), rng);
  // door
  entrance(g, xf, Math.max(x0 + 1.2, Math.min(x1 - 1.2, door)), zf, 0, CREAM, col, false);
  // blade sign on a bracket at the front corner, projecting toward the street side
  const bx = x1 - 0.1;
  g.color.copy(DARK);
  g.box(xf, bx - 0.04, bx + 0.04, gy + 0.6, gy + 0.68, zf - 0.6, zf, 0);
  g.color.copy(col);
  g.box(xf, bx - 0.05, bx + 0.05, gy - 0.2, gy + 0.6, zf - 0.58, zf - 0.08, 0.04);
  g.color.copy(CREAM);
  g.cylinder(xf, bx, zf - 0.33, 0.17, gy + 0.05, gy + 0.08, 8, true);
  g.box(xf, bx - 0.065, bx + 0.065, gy + 0.08, gy + 0.36, zf - 0.45, zf - 0.21, 0.08);
  void b;
  return col;
}

function ringOf(x0: number, x1: number, z0: number, z1: number, ch: number): number[] {
  const c = Math.min(ch, (x1 - x0) * 0.3, (z1 - z0) * 0.3);
  return c > 0 ? [x0 + c, z0, x1 - c, z0, x1, z0 + c, x1, z1 - c, x1 - c, z1, x0 + c, z1, x0, z1 - c, x0, z0 + c] : [x0, z0, x1, z0, x1, z1, x0, z1];
}

function parapet(g: Geo, xf: Xf, hw: number, hd: number, y: number, hgt: number, th: number, c: Color) {
  g.color.copy(c);
  g.kind = K.plain;
  g.box(xf, -hw, hw, y, y + hgt, -hd, -hd + th, 0, { bottom: false });
  g.box(xf, -hw, hw, y, y + hgt, hd - th, hd, 0, { bottom: false });
  g.box(xf, -hw, -hw + th, y, y + hgt, -hd + th, hd - th, 0, { bottom: false });
  g.box(xf, hw - th, hw, y, y + hgt, -hd + th, hd - th, 0, { bottom: false });
}

function roofClutter(g: Geo, xf: Xf, b: Building, rng: Rng, hw: number, hd: number, y: number, wall: Color, trim: Color, garden: boolean, tallest: boolean) {
  const co = 0.26;
  if (b.roof === 'hip') {
    hipRoof(g, xf, hw + co, hd + co, y, Math.min(hw, hd) * 0.55 + 0.6, PALETTE.roofs[b.roofColor] ?? PALETTE.roofs[0]);
    return;
  }
  parapet(g, xf, hw + co, hd + co, y, 0.55, 0.28, shade(trim, 0.95).clone());
  if (garden) {
    const k = rng.int(4, 7);
    for (let i = 0; i < k; i++) {
      const sx = rng.range(-hw + 0.9, hw - 0.9);
      const sz = rng.range(-hd + 0.9, hd - 0.9);
      const r = rng.range(0.45, 0.8);
      g.color.set('#C9B79A');
      g.kind = K.plain;
      g.box(xf, sx - r, sx + r, y, y + 0.35, sz - r, sz + r, 0.1);
      g.color.set('#2F8F4E').multiplyScalar(0.85 + rng.float() * 0.3);
      g.kind = K.leaf;
      g.param = rng.float() * 10;
      g.box(xf, sx - r * 0.8, sx + r * 0.8, y + 0.35, y + 0.8 + rng.float() * 0.4, sz - r * 0.8, sz + r * 0.8, 0.25);
      g.param = 0;
    }
    g.color.set('#E2D6BF');
    g.kind = K.tiles;
    g.capRing(xf, [-hw * 0.35, -hd * 0.35, hw * 0.35, -hd * 0.35, hw * 0.35, hd * 0.35, -hw * 0.35, hd * 0.35], y + 0.02, true);
    g.kind = K.plain;
    g.color.copy(WHITE);
    g.cylinder(xf, 0, 0, 0.04, y, y + 2.1, 4, false);
    g.color.copy(AWNINGS[rng.int(0, AWNINGS.length - 1)]);
    cone(g, xf, 0, 0, 1.2, y + 1.85, y + 2.35, 8);
    return;
  }
  // A tiny occupancy grid so props never overlap: cells of 1 m over the roof.
  const nx = Math.max(1, Math.floor((2 * hw - 1.2) / 1));
  const nz = Math.max(1, Math.floor((2 * hd - 1.2) / 1));
  const used = new Uint8Array(nx * nz);
  const take = (sx: number, sz: number): [number, number] | null => {
    // find a free sx × sz cell block (cells); returns its centre (local) or null
    for (let tries = 0; tries < 14; tries++) {
      const i0 = rng.int(0, Math.max(0, nx - sx));
      const j0 = rng.int(0, Math.max(0, nz - sz));
      if (i0 + sx > nx || j0 + sz > nz) continue;
      let ok = true;
      for (let j = j0; j < j0 + sz && ok; j++) for (let i = i0; i < i0 + sx; i++) if (used[j * nx + i]) ok = false;
      if (!ok) continue;
      for (let j = j0; j < j0 + sz; j++) for (let i = i0; i < i0 + sx; i++) used[j * nx + i] = 1;
      return [-hw + 0.6 + i0 + sx / 2, -hd + 0.6 + j0 + sz / 2];
    }
    return null;
  };
  if (tallest) {
    // Helipad: a dark disc with a yellow ring and an H, a little light at each corner.
    const r = Math.min(hw, hd) - 0.7;
    g.kind = K.plain;
    g.color.set('#3B4150');
    discAt(g, xf, 0, 0, r, y + 0.04, 16);
    g.color.set('#FFD54A');
    ringAt(g, xf, 0, 0, r * 0.82, r * 0.72, y + 0.05, 16);
    g.color.copy(WHITE);
    const s = r * 0.42;
    g.box(xf, -s, -s + s * 0.3, y + 0.04, y + 0.07, -s, s, 0);
    g.box(xf, s - s * 0.3, s, y + 0.04, y + 0.07, -s, s, 0);
    g.box(xf, -s, s, y + 0.04, y + 0.07, -s * 0.15, s * 0.15, 0);
    g.color.setRGB(1, 0.85, 0.4);
    g.kind = K.glow;
    g.param = 2;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.box(xf, sx * (hw - 0.45) - 0.1, sx * (hw - 0.45) + 0.1, y, y + 0.2, sz * (hd - 0.45) - 0.1, sz * (hd - 0.45) + 0.1, 0);
    g.kind = K.plain;
    g.param = 0;
    return;
  }
  if (b.roof === 'stepped') {
    let cw = hw * 0.7;
    let cd = hd * 0.7;
    let cy = y;
    for (let k = 0; k < 2; k++) {
      const top = cy + 1.6 - k * 0.3;
      g.color.copy(k === 0 ? wall : trim);
      g.kind = K.plain;
      g.box(xf, -cw, cw, cy, top, -cd, cd, 0.3, { top: true });
      cy = top;
      cw *= 0.66;
      cd *= 0.66;
    }
    for (let j = Math.floor(nz * 0.2); j < Math.ceil(nz * 0.8); j++) for (let i = Math.floor(nx * 0.2); i < Math.ceil(nx * 0.8); i++) used[j * nx + i] = 1;
  }
  // Rooftop pool on a tall office or tower (not every one).
  if ((b.style === 'office' || b.style === 'tower') && b.h > 18 && rng.chance(0.3) && hw > 3.5 && hd > 3) {
    const c = take(Math.min(nx - 1, 5), Math.min(nz - 1, 3));
    if (c) {
      const [px, pz] = c;
      const pw = Math.min(nx - 1, 5) / 2 - 0.15;
      const pd = Math.min(nz - 1, 3) / 2 - 0.15;
      g.kind = K.plain;
      g.color.copy(WHITE);
      g.box(xf, px - pw - 0.2, px + pw + 0.2, y, y + 0.3, pz - pd - 0.2, pz + pd + 0.2, 0.1, { top: false });
      ringAtRect(g, xf, px, pz, pw + 0.2, pd + 0.2, pw, pd, y + 0.3);
      g.color.set('#3FC1E0');
      g.kind = K.water;
      g.capRing(xf, [px - pw, pz - pd, px + pw, pz - pd, px + pw, pz + pd, px - pw, pz + pd], y + 0.24, true);
      g.kind = K.plain;
      // two loungers
      g.color.copy(AWNINGS[2]);
      for (const k of [-0.6, 0.6]) g.box(xf, px + k - 0.25, px + k + 0.25, y, y + 0.25, pz + pd + 0.35, pz + pd + 1.0, 0.04);
    }
  }
  // Water tank on legs.
  if ((b.style !== 'midrise' || rng.chance(0.55)) && rng.chance(0.7)) {
    const c = take(3, 3);
    if (c) {
      const [tx, tz] = c;
      g.color.copy(DARK);
      g.kind = K.plain;
      for (const [lx, lz] of [[-0.7, -0.7], [0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]]) g.box(xf, tx + lx - 0.08, tx + lx + 0.08, y, y + 0.9, tz + lz - 0.08, tz + lz + 0.08, 0, { top: false });
      g.color.set('#B98D62');
      g.cylinder(xf, tx, tz, 1.05, y + 0.9, y + 2.4, 10, false);
      g.color.set('#7D5A3E');
      cone(g, xf, tx, tz, 1.12, y + 2.4, y + 2.9, 10);
    }
  }
  // AC units, vents, a roof hatch, skylights: a scatter that differs roof to roof.
  g.kind = K.plain;
  const nAc = rng.int(0, 3);
  for (let k = 0; k < nAc; k++) {
    const c = take(2, 1);
    if (!c) break;
    g.color.set('#CBD0D8');
    g.box(xf, c[0] - 0.6, c[0] + 0.6, y, y + 0.8, c[1] - 0.42, c[1] + 0.42, 0.08);
    g.color.set('#7E8594');
    g.cylinder(xf, c[0] + 0.25, c[1], 0.26, y + 0.8, y + 0.84, 8, true);
  }
  const nVent = rng.int(1, 4);
  for (let k = 0; k < nVent; k++) {
    const c = take(1, 1);
    if (!c) break;
    g.color.copy(METAL);
    g.cylinder(xf, c[0], c[1], 0.14, y, y + 0.6, 6, false);
    g.color.copy(DARK);
    cone(g, xf, c[0], c[1], 0.24, y + 0.6, y + 0.82, 6);
  }
  if (rng.chance(0.6)) {
    const c = take(1, 1);
    if (c) {
      g.color.copy(shade(wall, 0.85));
      g.box(xf, c[0] - 0.42, c[0] + 0.42, y, y + 0.55, c[1] - 0.42, c[1] + 0.42, 0.04, { top: false });
      g.color.copy(DARK);
      g.box(xf, c[0] - 0.46, c[0] + 0.46, y + 0.55, y + 0.62, c[1] - 0.46, c[1] + 0.46, 0);
    }
  }
  if ((b.style === 'midrise' || b.style === 'office' || b.style === 'shop') && rng.chance(0.5)) {
    const n = rng.int(1, 3);
    for (let k = 0; k < n; k++) {
      const c = take(2, 2);
      if (!c) break;
      g.color.copy(WHITE);
      g.box(xf, c[0] - 0.8, c[0] + 0.8, y, y + 0.3, c[1] - 0.8, c[1] + 0.8, 0);
      g.color.copy(SKY_GLASS);
      // a glazed pyramid
      g.quadL(xf, [c[0] - 0.75, y + 0.3, c[1] - 0.75, c[0] + 0.75, y + 0.3, c[1] - 0.75, c[0] + 0.15, y + 0.75, c[1], c[0] - 0.15, y + 0.75, c[1]], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, -1]);
      g.quadL(xf, [c[0] + 0.75, y + 0.3, c[1] + 0.75, c[0] - 0.75, y + 0.3, c[1] + 0.75, c[0] - 0.15, y + 0.75, c[1], c[0] + 0.15, y + 0.75, c[1]], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 1]);
      g.triL(xf, [c[0] + 0.75, y + 0.3, c[1] - 0.75, c[0] + 0.75, y + 0.3, c[1] + 0.75, c[0] + 0.15, y + 0.75, c[1]], [0, 0, 1, 0, 0.5, 1], [1, 1, 0]);
      g.triL(xf, [c[0] - 0.75, y + 0.3, c[1] + 0.75, c[0] - 0.75, y + 0.3, c[1] - 0.75, c[0] - 0.15, y + 0.75, c[1]], [0, 0, 1, 0, 0.5, 1], [-1, 1, 0]);
    }
  }
  // Stair hut.
  if (b.style !== 'shop' && rng.chance(0.55)) {
    const c = take(2, 2);
    if (c) {
      g.color.copy(shade(wall, 0.9));
      g.box(xf, c[0] - 1.0, c[0] + 1.0, y, y + 2.2, c[1] - 1.0, c[1] + 1.0, 0.1);
      g.color.copy(GLASS_DOOR);
      g.box(xf, c[0] - 0.4, c[0] + 0.4, y, y + 1.9, c[1] - 1.03, c[1] - 0.99, 0, { top: false });
    }
  }
  // Billboard on a few mid-rise roofs, facing the street (front).
  if ((b.style === 'midrise' || b.style === 'shop') && b.frontEdge >= 0 && rng.chance(0.18) && hw > 2.6) {
    const bw = Math.min(hw * 1.5, 5);
    const zb = -hd + 0.9;
    g.color.copy(DARK);
    for (const sx of [-bw * 0.35, bw * 0.35]) g.box(xf, sx - 0.07, sx + 0.07, y, y + 1.2, zb - 0.07, zb + 0.07, 0, { top: false });
    g.color.copy(INK);
    g.box(xf, -bw / 2, bw / 2, y + 1.1, y + 2.75, zb - 0.06, zb + 0.06, 0.03, { bottom: true });
    poster(g, xf, (a, py, k, out) => {
      out[0] = a;
      out[1] = y + 1.1 + py;
      out[2] = zb - 0.065 - 0.02 * k;
    }, [0, 0, -1], bw, 1.65, rng);
  }
  if (b.style === 'tower' && b.h >= 26) {
    const mx = hw * 0.35;
    const mz = -hd * 0.2;
    g.color.copy(METAL);
    g.kind = K.plain;
    g.box(xf, mx - 0.07, mx + 0.07, y, y + 2.7, mz - 0.07, mz + 0.07, 0, { top: false });
    g.color.setRGB(1, 0.12, 0.08);
    g.kind = K.glow;
    g.param = -3;
    g.box(xf, mx - 0.16, mx + 0.16, y + 2.7, y + 3.0, mz - 0.16, mz + 0.16, 0);
    g.kind = K.plain;
    g.param = 0;
  }
  if ((b.style === 'office' || b.style === 'midrise') && rng.chance(0.35)) {
    const c = take(4, 3);
    if (c) {
      g.color.set('#4C78B8');
      g.kind = K.plain;
      for (let k = -1; k <= 1; k++) g.quadL(xf, [c[0] - 1.8, y + 0.25, c[1] + k * 1.0 - 0.38, c[0] + 1.8, y + 0.25, c[1] + k * 1.0 - 0.38, c[0] + 1.8, y + 0.7, c[1] + k * 1.0 + 0.38, c[0] - 1.8, y + 0.7, c[1] + k * 1.0 + 0.38], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, -0.6]);
    }
  }
}

function discAt(g: Geo, xf: Xf, cx: number, cz: number, r: number, y: number, n: number) {
  const ring: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
  }
  g.capRing(xf, ring, y, true);
}

function ringAt(g: Geo, xf: Xf, cx: number, cz: number, r0: number, r1: number, y: number, n: number) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    g.quadL(xf, [cx + Math.cos(a0) * r0, y, cz + Math.sin(a0) * r0, cx + Math.cos(a1) * r0, y, cz + Math.sin(a1) * r0, cx + Math.cos(a1) * r1, y, cz + Math.sin(a1) * r1, cx + Math.cos(a0) * r1, y, cz + Math.sin(a0) * r1], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 0]);
  }
}

/** A flat rectangular frame (outer half sizes ox, oz; inner ix, iz) at height y, facing up. */
function ringAtRect(g: Geo, xf: Xf, cx: number, cz: number, ox: number, oz: number, ix: number, iz: number, y: number) {
  const q = (x0: number, z0: number, x1: number, z1: number) => g.quadL(xf, [cx + x0, y, cz + z0, cx + x1, y, cz + z0, cx + x1, y, cz + z1, cx + x0, y, cz + z1], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 0]);
  q(-ox, -oz, ox, -iz);
  q(-ox, iz, ox, oz);
  q(-ox, -iz, -ix, iz);
  q(ix, -iz, ox, iz);
}

/** A cone / pyramid roof cap (n-gon base at y0, apex at y1). */
function cone(g: Geo, xf: Xf, cx: number, cz: number, r: number, y0: number, y1: number, n: number) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2 + Math.PI / n;
    const a1 = ((i + 1) / n) * Math.PI * 2 + Math.PI / n;
    const ax = cx + Math.cos(a0) * r, az = cz + Math.sin(a0) * r;
    const bx = cx + Math.cos(a1) * r, bz = cz + Math.sin(a1) * r;
    const mx = (ax + bx) / 2 - cx;
    const mz = (az + bz) / 2 - cz;
    g.triL(xf, [bx, y0, bz, ax, y0, az, cx, y1, cz], [1, 0, 0, 0, 0.5, 1], [mx, r * 0.5, mz]);
  }
}

/** Hip roof over a hw × hd rectangle from eave height y, rising `rise`. */
function hipRoof(g: Geo, xf: Xf, hw: number, hd: number, y: number, rise: number, color: Color, tiles = true) {
  g.color.copy(color);
  g.kind = K.roof;
  g.param = tiles ? 1 : 0;
  const long = hw >= hd;
  const r = long ? Math.max(0, hw - hd) : Math.max(0, hd - hw);
  const yt = y + rise;
  const slope = Math.hypot(Math.min(hw, hd), rise);
  if (long) {
    g.quadL(xf, [hw, y, -hd, -hw, y, -hd, -r, yt, 0, r, yt, 0], [hw, slope, -hw, slope, -r, 0, r, 0], [0, 1, -1]);
    g.quadL(xf, [-hw, y, hd, hw, y, hd, r, yt, 0, -r, yt, 0], [-hw, slope, hw, slope, r, 0, -r, 0], [0, 1, 1]);
    g.triL(xf, [hw, y, hd, hw, y, -hd, r, yt, 0], [hd, slope, -hd, slope, 0, 0], [1, 1, 0]);
    g.triL(xf, [-hw, y, -hd, -hw, y, hd, -r, yt, 0], [-hd, slope, hd, slope, 0, 0], [-1, 1, 0]);
  } else {
    g.quadL(xf, [hw, y, hd, hw, y, -hd, 0, yt, -r, 0, yt, r], [hd, slope, -hd, slope, -r, 0, r, 0], [1, 1, 0]);
    g.quadL(xf, [-hw, y, -hd, -hw, y, hd, 0, yt, r, 0, yt, -r], [-hd, slope, hd, slope, r, 0, -r, 0], [-1, 1, 0]);
    g.triL(xf, [hw, y, -hd, -hw, y, -hd, 0, yt, -r], [hw, slope, -hw, slope, 0, 0], [0, 1, -1]);
    g.triL(xf, [-hw, y, hd, hw, y, hd, 0, yt, r], [-hw, slope, hw, slope, 0, 0], [0, 1, 1]);
  }
  g.kind = K.plain;
  g.color.copy(shade(color, 0.55));
  g.capRing(xf, [-hw, -hd, hw, -hd, hw, hd, -hw, hd], y - 0.02, false);
}

/** Gable roof: ridge along local x (or z), eaves at y, ridge at y + rise. Gable ends filled with `wall`. */
function gableRoof(g: Geo, xf: Xf, hw: number, hd: number, wallHW: number, wallHD: number, y: number, rise: number, color: Color, wall: Color, alongX: boolean) {
  const yt = y + rise;
  const fascia = shade(color, 0.6).clone();
  g.color.copy(color);
  g.kind = K.roof;
  g.param = 1;
  if (alongX) {
    const sl = Math.hypot(hd, rise);
    g.quadL(xf, [hw, y, -hd, -hw, y, -hd, -hw, yt, 0, hw, yt, 0], [hw, sl, -hw, sl, -hw, 0, hw, 0], [0, 1, -1]);
    g.quadL(xf, [-hw, y, hd, hw, y, hd, hw, yt, 0, -hw, yt, 0], [-hw, sl, hw, sl, hw, 0, -hw, 0], [0, 1, 1]);
    g.kind = K.plain;
    g.color.copy(fascia);
    g.quadL(xf, [-hw, y - 0.14, -hd, hw, y - 0.14, -hd, hw, yt - 0.14, 0, -hw, yt - 0.14, 0], [0, 0, 1, 0, 1, 1, 0, 1], [0, -1, 0]);
    g.quadL(xf, [hw, y - 0.14, hd, -hw, y - 0.14, hd, -hw, yt - 0.14, 0, hw, yt - 0.14, 0], [0, 0, 1, 0, 1, 1, 0, 1], [0, -1, 0]);
    g.quadL(xf, [-hw, y - 0.14, -hd, hw, y - 0.14, -hd, hw, y, -hd, -hw, y, -hd], [0, 0, 1, 0, 1, 1, 0, 1], [0, 0, -1]);
    g.quadL(xf, [-hw, y - 0.14, hd, hw, y - 0.14, hd, hw, y, hd, -hw, y, hd], [0, 0, 1, 0, 1, 1, 0, 1], [0, 0, 1]);
    for (const sx of [-1, 1]) {
      const x = sx * hw;
      g.quadL(xf, [x, y - 0.14, -hd, x, y, -hd, x, yt, 0, x, yt - 0.14, 0], [0, 0, 1, 0, 1, 1, 0, 1], [sx, 0, 0]);
      g.quadL(xf, [x, y - 0.14, hd, x, y, hd, x, yt, 0, x, yt - 0.14, 0], [0, 0, 1, 0, 1, 1, 0, 1], [sx, 0, 0]);
    }
    g.color.copy(wall);
    g.triL(xf, [wallHW, y, -wallHD, wallHW, y, wallHD, wallHW, yt - 0.14, 0], [0, 0, 1, 0, 0.5, 1], [1, 0, 0]);
    g.triL(xf, [-wallHW, y, wallHD, -wallHW, y, -wallHD, -wallHW, yt - 0.14, 0], [0, 0, 1, 0, 0.5, 1], [-1, 0, 0]);
  } else {
    const sl = Math.hypot(hw, rise);
    g.quadL(xf, [-hw, y, -hd, -hw, y, hd, 0, yt, hd, 0, yt, -hd], [-hd, sl, hd, sl, hd, 0, -hd, 0], [-1, 1, 0]);
    g.quadL(xf, [hw, y, hd, hw, y, -hd, 0, yt, -hd, 0, yt, hd], [hd, sl, -hd, sl, -hd, 0, hd, 0], [1, 1, 0]);
    g.kind = K.plain;
    g.color.copy(fascia);
    g.quadL(xf, [-hw, y - 0.14, hd, -hw, y - 0.14, -hd, 0, yt - 0.14, -hd, 0, yt - 0.14, hd], [0, 0, 1, 0, 1, 1, 0, 1], [0, -1, 0]);
    g.quadL(xf, [hw, y - 0.14, -hd, hw, y - 0.14, hd, 0, yt - 0.14, hd, 0, yt - 0.14, -hd], [0, 0, 1, 0, 1, 1, 0, 1], [0, -1, 0]);
    g.quadL(xf, [-hw, y - 0.14, -hd, -hw, y - 0.14, hd, -hw, y, hd, -hw, y, -hd], [0, 0, 1, 0, 1, 1, 0, 1], [-1, 0, 0]);
    g.quadL(xf, [hw, y - 0.14, -hd, hw, y - 0.14, hd, hw, y, hd, hw, y, -hd], [0, 0, 1, 0, 1, 1, 0, 1], [1, 0, 0]);
    for (const sz of [-1, 1]) {
      const z = sz * hd;
      g.quadL(xf, [-hw, y - 0.14, z, -hw, y, z, 0, yt, z, 0, yt - 0.14, z], [0, 0, 1, 0, 1, 1, 0, 1], [0, 0, sz]);
      g.quadL(xf, [hw, y - 0.14, z, hw, y, z, 0, yt, z, 0, yt - 0.14, z], [0, 0, 1, 0, 1, 1, 0, 1], [0, 0, sz]);
    }
    g.color.copy(wall);
    g.triL(xf, [-wallHW, y, -wallHD, wallHW, y, -wallHD, 0, yt - 0.14, -wallHD], [0, 0, 1, 0, 0.5, 1], [0, 0, -1]);
    g.triL(xf, [wallHW, y, wallHD, -wallHW, y, wallHD, 0, yt - 0.14, wallHD], [0, 0, 1, 0, 0.5, 1], [0, 0, 1]);
  }
}

// ── Shops: one or two storeys, a striped awning, a fascia sign; shopfronts on every street face ──

function shop(g: Geo, xf: Xf, b: Building, rng: Rng, ctx: BuildCtx) {
  const wall = PALETTE.walls[b.wall] ?? PALETTE.walls[0];
  const trim = tint(wall, WHITE, 0.5).clone();
  const hw = b.w / 2 - 0.9;
  const hd = b.d / 2 - 0.3;
  const front = -b.d / 2 + 0.9; // walls set back so the awning stays inside the box
  const gy = 3.6;
  const top = Math.max(gy + 0.9, b.h - 0.35);
  const cafe = b.decor === 'cafe';
  const street = [true, ctx.roadFace(b, 1), ctx.roadFace(b, 2), ctx.roadFace(b, 3)];
  g.color.copy(wall);
  g.kind = K.facade;
  g.box(xf, -hw, hw, -0.8, gy, front, hd, 0.25, {
    top: false,
    side: (f, w) => {
      // blank sides bigger than ~20 m² get a full row of windows (a sparse row left one window on a
      // big bare box); small ones stay sparse
      g.param = facadeParam(street[f] ? F.shop : w * gy > 20 ? F.punched : F.sparse, b.seed + f);
      return street[f] ? [0, Math.max(1, Math.round(w / 3.2)), ...vr(-0.8, gy, 10)] : [0, Math.max(1, Math.round(w / 2.6)), ...vr(-0.8, gy, 10)];
    },
  });
  if (top - gy > 2.2) {
    g.param = facadeParam(F.punched, b.seed);
    g.box(xf, -hw, hw, gy, top, front, hd, 0.25, { top: false, side: (_f, w) => grid(w, gy, top, 2.6, 3) });
  } else {
    // a one-storey shop: a coloured fascia band all round over the shop floor
    g.kind = K.plain;
    g.color.copy(shade(wall, 0.9));
    g.box(xf, -hw, hw, gy, top, front, hd, 0.25, { top: false });
  }
  g.color.copy(trim);
  g.kind = K.plain;
  g.box(xf, -hw - 0.2, hw + 0.2, top, b.h, front - 0.2, hd + 0.2, 0.25, { top: false, bottom: true });
  g.color.copy(flatRoof(b, rng).color);
  g.kind = K.roof;
  g.param = 0;
  g.capRing(xf, ringOf(-hw - 0.2, hw + 0.2, front - 0.2, hd + 0.2, 0.25), b.h, true);
  parapet(g, xf, hw + 0.2, hd + 0.2, b.h, 0.45, 0.22, trim);
  const sign = AWNINGS[rng.int(0, AWNINGS.length - 1)];
  // The awning runs along the front and wraps (mitred) down every side that meets a street.
  const sideReach = Math.min(0.85, b.w / 2 - hw - 0.05);
  const wrapAwning = (y: number, col: Color) => {
    const pts: number[] = [];
    const nor: number[] = [];
    const reach: number[] = [];
    const wrapL = street[3] && sideReach >= 0.3 && hd - 0.6 - front > 1;
    const wrapR = street[1] && sideReach >= 0.3 && hd - 0.6 - front > 1;
    if (wrapL) {
      pts.push(-hw, hd - 0.6);
      nor.push(-1, 0);
      reach.push(sideReach);
    }
    pts.push(wrapL ? -hw : -hw + 0.15, front, wrapR ? hw : hw - 0.15, front);
    nor.push(0, -1);
    reach.push(front - (-b.d / 2 + 0.05));
    if (wrapR) {
      pts.push(hw, hd - 0.6);
      nor.push(1, 0);
      reach.push(sideReach);
    }
    awningWrap(g, xf, pts, nor, reach, y, col);
  };
  if (cafe) wrapAwning(gy - 0.05, cafeFront(g, xf, b, -hw, hw, front, gy + 0.9, b.door ?? 0, rng));
  else {
    g.color.copy(sign);
    g.kind = K.plain;
    g.box(xf, -hw * 0.7, hw * 0.7, gy - 0.05, gy + 0.55, front - 0.12, front, 0, { bottom: true });
    lettering(g, xf, -hw * 0.55, hw * 0.55, gy + 0.1, gy + 0.42, front - 0.12, inkOn(sign), rng);
    wrapAwning(gy - 0.25, AWNINGS[rng.int(0, AWNINGS.length - 1)]);
    entrance(g, xf, Math.max(-hw + 1.1, Math.min(hw - 1.1, b.door ?? 0)), front, 0, trim, sign, false);
  }
  // Side faces that meet a street get an awning too; blank sides an ad panel or a side door.
  for (const sx of [-1, 1]) {
    const f = sx > 0 ? 1 : 3;
    const zc = (front + hd) / 2;
    if (!street[f] && hd - front > 4) {
      // a big blank side: an ad panel high up (over the windows) and a downpipe at its front corner
      if (top - gy > 1.6 || rng.chance(0.8)) adPanel(g, xf, sx * hw, sx, zc, top - gy > 2.2 ? gy + 0.4 : 1.2, Math.min(3.2, hd - front - 1.2), Math.min(2.2, top - (top - gy > 2.2 ? gy + 0.8 : 1.8)), rng);
      downpipe(g, xf, sx * (hw - 0.08), front + 0.08, top);
    }
  }
  downpipe(g, xf, -hw + 0.08, hd - 0.08, top);
  g.color.set('#CBD0D8');
  if (hw > 2.5 && hd > 2.5) g.box(xf, hw * 0.3 - 0.6, hw * 0.3 + 0.6, b.h, b.h + 0.75, hd * 0.2 - 0.45, hd * 0.2 + 0.45, 0.08);
}

/**
 * A striped awning hung along a run of wall: `pts` are the wall points (local x, z, at height y)
 * of consecutive wall segments, `nor` each segment's outward unit normal (x, z) and `reach` how far
 * it sticks out. It slopes gently down to its outer edge and drops a 0.3 m valance from it. Where
 * the run turns a corner the two segments meet on the mitre (the corner of their offset lines),
 * so a wrap-around awning is one continuous, closed piece with no gap or sliver at the corner.
 */
export function awningWrap(g: Geo, xf: Xf, pts: number[], nor: number[], reach: number[], y: number, col: Color) {
  const ns = reach.length;
  if (ns < 1 || pts.length < 2 * (ns + 1)) return;
  // A shallow pitch (drop = 0.4 × the deepest reach): the awning's plane then meets a 1.9 m eye
  // only 3+ m out from the wall, past the sidewalk, so from anywhere on the pavement you see its
  // striped underside instead of catching it edge-on as a thin line.
  let maxReach = 0;
  for (const r of reach) maxReach = Math.max(maxReach, r);
  const drop = Math.max(0.2, maxReach * 0.4);
  const v0 = g.n;
  // outer edge points: on each segment's offset line, mitred where two segments meet
  const out: number[] = [];
  for (let k = 0; k <= ns; k++) {
    const px = pts[k * 2], pz = pts[k * 2 + 1];
    if (k === 0 || k === ns) {
      const j = k === 0 ? 0 : ns - 1;
      out.push(px + nor[j * 2] * reach[j], pz + nor[j * 2 + 1] * reach[j]);
      continue;
    }
    const ax = nor[(k - 1) * 2], az = nor[(k - 1) * 2 + 1], ra = reach[k - 1];
    const bx = nor[k * 2], bz = nor[k * 2 + 1], rb = reach[k];
    // along segment k − 1
    const dx = pts[k * 2] - pts[(k - 1) * 2];
    const dz = pts[k * 2 + 1] - pts[(k - 1) * 2 + 1];
    const dl = Math.hypot(dx, dz) || 1;
    const den = (dx / dl) * bx + (dz / dl) * bz;
    if (Math.abs(den) < 1e-3) {
      out.push(px + (ax * ra + bx * rb) / 2, pz + (az * ra + bz * rb) / 2);
    } else {
      const t = (rb - ra * (ax * bx + az * bz)) / den;
      out.push(px + ax * ra + (dx / dl) * t, pz + az * ra + (dz / dl) * t);
    }
  }
  g.kind = K.plain;
  g.param = 0;
  let stripe = 0;
  for (let k = 0; k < ns; k++) {
    const nx = nor[k * 2], nz = nor[k * 2 + 1];
    const w0x = pts[k * 2], w0z = pts[k * 2 + 1], w1x = pts[k * 2 + 2], w1z = pts[k * 2 + 3];
    const o0x = out[k * 2], o0z = out[k * 2 + 1], o1x = out[k * 2 + 2], o1z = out[k * 2 + 3];
    const len = Math.max(Math.hypot(w1x - w0x, w1z - w0z), Math.hypot(o1x - o0x, o1z - o0z));
    const n = Math.max(1, Math.round(len / 0.55));
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const ax = w0x + (w1x - w0x) * t0, az = w0z + (w1z - w0z) * t0;
      const bx = w0x + (w1x - w0x) * t1, bz = w0z + (w1z - w0z) * t1;
      const cx = o0x + (o1x - o0x) * t1, cz = o0z + (o1z - o0z) * t1;
      const dx = o0x + (o1x - o0x) * t0, dz = o0z + (o1z - o0z) * t0;
      const c = stripe++ % 2 ? CREAM : col;
      g.color.copy(c);
      g.quadL(xf, [ax, y, az, bx, y, bz, cx, y - drop, cz, dx, y - drop, dz], [0, 0, 1, 0, 1, 1, 0, 1], [nx * 0.5, 1, nz * 0.5]);
      g.color.copy(shade(c, 0.72));
      g.quadL(xf, [ax, y - 0.03, az, bx, y - 0.03, bz, cx, y - drop - 0.03, cz, dx, y - drop - 0.03, dz], [0, 0, 1, 0, 1, 1, 0, 1], [-nx * 0.5, -1, -nz * 0.5]);
      g.color.copy(c);
      // valance: outer face, and its back a hair inside
      g.quadL(xf, [dx, y - drop - 0.3, dz, cx, y - drop - 0.3, cz, cx, y - drop, cz, dx, y - drop, dz], [0, 0, 1, 0, 1, 1, 0, 1], [nx, 0, nz]);
      const ix = -nx * 0.02, iz = -nz * 0.02;
      g.quadL(xf, [dx + ix, y - drop - 0.3, dz + iz, cx + ix, y - drop - 0.3, cz + iz, cx + ix, y - drop, cz + iz, dx + ix, y - drop, dz + iz], [0, 0, 1, 0, 1, 1, 0, 1], [-nx, 0, -nz]);
    }
  }
  if (g.awnings) {
    const wall: number[] = [];
    for (let k = 0; k <= ns; k++) {
      Geo.apply(xf, pts[k * 2], y, pts[k * 2 + 1], _w);
      wall.push(_w.x, _w.y, _w.z);
    }
    g.awnings.push({ v0, v1: g.n, wall });
  }
}
const _w = v3();

// ── The corner shop: a gabled two-storey house with a shop on the ground floor ──

function cornerShop(g: Geo, xf: Xf, b: Building, rng: Rng, ctx: BuildCtx) {
  const wall = PALETTE.walls[b.wall] ?? PALETTE.walls[0];
  const roofC = PALETTE.roofs[b.roofColor] ?? PALETTE.roofs[0];
  const eave = 0.4;
  const hw = b.w / 2 - eave;
  const hd = b.d / 2 - 0.85; // front set back for the awning
  const zf = -hd;
  const zb = b.d / 2 - eave;
  const gy = 3.4;
  const wallH = Math.max(gy + 2.6, b.h - 2.2);
  const rise = b.h - wallH;
  const zc = (zf + zb) / 2;
  const hdd = (zb - zf) / 2;
  // local frame shifted so the body is centred (zc)
  const body: Xf = { o: { x: xf.o.x + xf.ez.x * zc, y: xf.o.y + xf.ez.y * zc, z: xf.o.z + xf.ez.z * zc }, ex: xf.ex, ey: xf.ey, ez: xf.ez };
  g.color.copy(wall);
  g.kind = K.facade;
  const street = [true, ctx.roadFace(b, 1), false, ctx.roadFace(b, 3)];
  g.box(body, -hw, hw, -0.8, gy, -hdd, hdd, 0.12, {
    top: false,
    side: (f, w) => {
      g.param = facadeParam(street[f] ? F.shop : F.house, b.seed + f);
      return [0, Math.max(1, Math.round(w / (street[f] ? 3.0 : 2.6))), ...vr(-0.8, gy, 10)];
    },
  });
  g.param = facadeParam(F.house, b.seed);
  g.box(body, -hw, hw, gy, wallH, -hdd, hdd, 0.12, { top: false, side: (_f, w) => [0, Math.max(1, Math.round(w / 2.4)), ...vr(gy, wallH, 2.8)] });
  // a band between the floors
  g.kind = K.plain;
  g.color.copy(CREAM);
  g.box(body, -hw - 0.06, hw + 0.06, gy - 0.1, gy + 0.12, -hdd - 0.06, hdd + 0.06, 0.12, { top: true, bottom: true });
  gableRoof(g, body, hw + eave, hdd + eave * 0.5, hw, hdd, wallH, rise, roofC, wall, true);
  const sign = AWNINGS[rng.int(0, AWNINGS.length - 1)];
  g.color.copy(sign);
  g.kind = K.plain;
  g.box(xf, -hw * 0.75, hw * 0.75, gy + 0.2, gy + 0.85, zf - 0.1, zf, 0, { bottom: true });
  lettering(g, xf, -hw * 0.6, hw * 0.6, gy + 0.35, gy + 0.7, zf - 0.1, inkOn(sign), rng);
  {
    // the awning along the front, wrapping (mitred) down the street sides under the eaves
    const pts: number[] = [];
    const nor: number[] = [];
    const reach: number[] = [];
    if (street[3]) {
      pts.push(-hw, zb - 0.6);
      nor.push(-1, 0);
      reach.push(0.35);
    }
    pts.push(street[3] ? -hw : -hw + 0.1, zf, street[1] ? hw : hw - 0.1, zf);
    nor.push(0, -1);
    reach.push(zf - (-b.d / 2 + 0.05));
    if (street[1]) {
      pts.push(hw, zb - 0.6);
      nor.push(1, 0);
      reach.push(0.35);
    }
    awningWrap(g, xf, pts, nor, reach, gy - 0.2, sign);
  }
  entrance(g, xf, Math.max(-hw + 1.1, Math.min(hw - 1.1, b.door ?? 0)), zf, 0, CREAM, sign, false);
  // a chimney
  g.color.set('#B5654C');
  g.box(xf, hw * 0.45 - 0.32, hw * 0.45 + 0.32, wallH, b.h + 0.4, zc + hdd * 0.3 - 0.32, zc + hdd * 0.3 + 0.32, 0);
}

// ── Houses: walls, a gable or hip roof with eaves, a door, a chimney ──

/** Local x of a house's front door (ground.ts runs the garden path to it). */
export function doorX(b: Building): number {
  if (b.door !== undefined) return b.door;
  const hw = b.w / 2 - 0.42;
  return (((b.seed >>> 3) % 1000) / 1000 - 0.5) * 0.8 * hw;
}

function house(g: Geo, xf: Xf, b: Building, rng: Rng) {
  const wall = PALETTE.walls[b.wall] ?? PALETTE.walls[0];
  // Green tiles read as lawn from above: houses get a deep teal-green instead.
  const roofC = b.roofColor === 2 ? HOUSE_GREEN : PALETTE.roofs[b.roofColor] ?? PALETTE.roofs[0];
  const eave = 0.42;
  const hw = b.w / 2 - eave;
  const hd = b.d / 2 - eave;
  const alongX = b.w >= b.d;
  const span = alongX ? hd + eave : hw + eave;
  const rise = Math.min(b.h * 0.42, span * 0.85, 3.4);
  const wallH = Math.max(2.8, b.h - rise);
  const floors = wallH > 4.6 ? 2 : 1;
  g.color.copy(wall);
  g.kind = K.facade;
  g.param = facadeParam(F.house, b.seed);
  g.box(xf, -hw, hw, -0.8, wallH, -hd, hd, 0.12, { top: false, side: (_f, w) => [0, Math.max(1, Math.round(w / 2.6)), ...vr(-0.8, wallH, (wallH - 0.2) / floors)] });
  g.color.copy(shade(wall, 0.72));
  g.kind = K.plain;
  g.box(xf, -hw - 0.06, hw + 0.06, -0.8, 0.45, -hd - 0.06, hd + 0.06, 0.12, { top: false });
  if (floors === 2) {
    g.color.copy(CREAM);
    g.box(xf, -hw - 0.05, hw + 0.05, wallH / 2 + 0.05, wallH / 2 + 0.2, -hd - 0.05, hd + 0.05, 0.12, { top: true, bottom: true });
  }
  if (b.roof === 'hip') hipRoof(g, xf, hw + eave, hd + eave, wallH, rise * 0.85, roofC);
  else gableRoof(g, xf, hw + eave, hd + eave, hw, hd, wallH, rise, roofC, wall, alongX);
  const dx = doorX(b);
  // a painted door, a third of the way toward the wall's own colour and at most half saturated (a
  // pure awning blue read as a violet-blue hole next to a crimson wall at dusk)
  g.color.copy(AWNINGS[rng.int(0, AWNINGS.length - 1)]).lerp(wall, 0.35).getHSL(_hsl);
  g.color.setHSL(_hsl.h, Math.min(_hsl.s, 0.5), _hsl.l * 0.9);
  g.box(xf, dx - 0.5, dx + 0.5, 0.2, 2.25, -hd - 0.06, -hd + 0.02, 0, { bottom: false });
  g.color.copy(CREAM);
  g.box(xf, dx - 0.8, dx + 0.8, 2.4, 2.55, -hd - 0.38, -hd, 0, { bottom: true });
  g.color.copy(shade(PALETTE.road.sidewalk, 0.9));
  g.box(xf, dx - 0.7, dx + 0.7, -0.2, 0.32, -hd - 0.4, -hd, 0);
  if (rng.chance(0.75)) {
    const cx = alongX ? rng.range(-hw * 0.6, hw * 0.6) : rng.range(-hw * 0.4, hw * 0.4);
    const cz = alongX ? rng.range(0.2, hd * 0.5) : rng.range(-hd * 0.6, hd * 0.6);
    g.color.set('#B5654C');
    g.box(xf, cx - 0.35, cx + 0.35, wallH, b.h + 0.55, cz - 0.35, cz + 0.35, 0);
    g.color.copy(DARK);
    g.box(xf, cx - 0.42, cx + 0.42, b.h + 0.55, b.h + 0.7, cz - 0.42, cz + 0.42, 0);
  }
}

// ── Landmarks ──

function clockTower(g: Geo, xf: Xf, b: Building) {
  const stone = new Color('#F1E4C8');
  const brick = new Color('#D98C6A');
  const trim = new Color('#FFF8EA');
  const roof = PALETTE.roofs[2];
  const hw = b.w / 2;
  g.color.copy(shade(stone, 0.85));
  g.kind = K.plain;
  g.box(xf, -hw, hw, -0.8, 1.0, -hw, hw, 0.2);
  const s = hw - 0.45;
  g.color.copy(brick);
  g.kind = K.facade;
  g.param = facadeParam(F.punched, b.seed);
  g.box(xf, -s, s, 1.0, 14.4, -s, s, 0.35, { top: false, side: () => [0, 1, ...vr(1.0, 14.4, 3.35)] });
  g.color.copy(trim);
  g.kind = K.plain;
  g.box(xf, -s - 0.3, s + 0.3, 14.4, 14.85, -s - 0.3, s + 0.3, 0.35);
  // doors at the foot of each face
  for (let f = 0; f < 4; f++) {
    const ang = (f * Math.PI) / 2;
    const rot: Xf = { o: xf.o, ex: rotY(xf, ang, 'x'), ey: xf.ey, ez: rotY(xf, ang, 'z') };
    entrance(g, rot, 0, -s, 0.3, trim, roof, false, 1.0);
  }
  const c = s + 0.12;
  g.color.copy(stone);
  g.box(xf, -c, c, 14.85, 18.5, -c, c, 0.35, { top: false });
  g.kind = K.clock;
  g.color.copy(WHITE);
  const R = 1.3;
  const n = 20;
  for (let f = 0; f < 4; f++) {
    const ang = (f * Math.PI) / 2;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const pt = (u: number, v: number, out: number[]) => {
      const lx = u;
      const lz = -(c + 0.06);
      out.push(lx * ca - lz * sa, 16.7 + v, lx * sa + lz * ca);
    };
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const p: number[] = [];
      pt(0, 0, p);
      pt(Math.cos(a1) * R, Math.sin(a1) * R, p);
      pt(Math.cos(a0) * R, Math.sin(a0) * R, p);
      g.triL(xf, p, [0, 0, -Math.cos(a1), Math.sin(a1), -Math.cos(a0), Math.sin(a0)], [sa, 0, -ca]);
    }
  }
  g.kind = K.plain;
  g.color.copy(trim);
  g.box(xf, -c - 0.25, c + 0.25, 18.5, 18.9, -c - 0.25, c + 0.25, 0.35);
  g.color.copy(DARK);
  g.box(xf, -c + 0.7, c - 0.7, 18.9, 20.6, -c + 0.7, c - 0.7, 0, { top: false });
  g.color.copy(stone);
  for (const [px, pz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const qx = px * (c - 0.31);
    const qz = pz * (c - 0.31);
    g.box(xf, qx - 0.31, qx + 0.31, 18.9, 20.6, qz - 0.31, qz + 0.31, 0, { top: false });
  }
  g.color.copy(trim);
  g.box(xf, -c - 0.3, c + 0.3, 20.6, 21.0, -c - 0.3, c + 0.3, 0.35);
  g.color.copy(roof);
  g.kind = K.roof;
  g.param = 1;
  cone(g, xf, 0, 0, (c + 0.25) * 1.414, 21.0, b.h + 2.0, 4);
  g.kind = K.plain;
  g.color.copy(PALETTE.accent);
  g.cylinder(xf, 0, 0, 0.06, b.h + 1.9, b.h + 2.55, 4, true);
  g.box(xf, -0.2, 0.2, b.h + 2.55, b.h + 2.92, -0.2, 0.2, 0.12);
}

/** Local axis of xf rotated by `ang` about local y. */
function rotY(xf: Xf, ang: number, which: 'x' | 'z') {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  // local x' = x·c + z·s ; z' = −x·s + z·c  (in the building's local frame)
  return which === 'x'
    ? { x: xf.ex.x * c + xf.ez.x * s, y: xf.ex.y * c + xf.ez.y * s, z: xf.ex.z * c + xf.ez.z * s }
    : { x: -xf.ex.x * s + xf.ez.x * c, y: -xf.ex.y * s + xf.ez.y * c, z: -xf.ex.z * s + xf.ez.z * c };
}

/** The church: a nave with a slate gable roof, arched windows, a bell tower and spire at the front. */
function churchB(g: Geo, xf: Xf, b: Building) {
  const stone = new Color('#F3E6CC');
  const trim = new Color('#FFF8EA');
  const roofC = PALETTE.roofs[1];
  const hw = b.w / 2 - 0.5;
  const hd = b.d / 2 - 0.7;
  const wallH = 6.8;
  const t = 1.9; // tower half size
  // nave
  g.color.copy(stone);
  g.kind = K.facade;
  g.param = facadeParam(F.arcade, b.seed);
  g.box(xf, -hw, hw, -0.8, wallH, -hd + 2 * t, hd, 0.2, { top: false, side: (f, w) => (f === 0 ? null : [0, Math.max(1, Math.round(w / 2.4)), ...vr(-0.8, wallH, 10)]) });
  g.kind = K.plain;
  g.color.copy(trim);
  g.box(xf, -hw - 0.1, hw + 0.1, wallH - 0.25, wallH, -hd + 2 * t, hd + 0.1, 0.2, { top: false, bottom: true });
  gableRoofZ(g, xf, hw + 0.35, -hd + 2 * t, hd + 0.35, wallH, 3.4, roofC, stone, hw);
  // tower at the front centre
  g.color.copy(stone);
  g.kind = K.facade;
  g.param = facadeParam(F.arcade, b.seed + 3);
  const tz0 = -hd;
  const tz1 = -hd + 2 * t;
  g.box(xf, -t, t, -0.8, 12.2, tz0, tz1, 0.25, { top: false, side: (_f, w) => [0, 1, ...vr(-0.8, 12.2, 4)] });
  g.kind = K.plain;
  g.color.copy(trim);
  g.box(xf, -t - 0.2, t + 0.2, 12.2, 12.6, tz0 - 0.2, tz1 + 0.2, 0.25);
  // belfry openings: dark core with corner posts
  g.color.copy(DARK);
  g.box(xf, -t + 0.45, t - 0.45, 12.6, 14.2, tz0 + 0.45, tz1 - 0.45, 0, { top: false });
  g.color.copy(stone);
  for (const [px, pz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const qx = px * (t - 0.25);
    const qz = (tz0 + tz1) / 2 + pz * (t - 0.25);
    g.box(xf, qx - 0.25, qx + 0.25, 12.6, 14.2, qz - 0.25, qz + 0.25, 0, { top: false });
  }
  g.color.copy(trim);
  g.box(xf, -t - 0.15, t + 0.15, 14.2, 14.5, tz0 - 0.15, tz1 + 0.15, 0.25);
  // spire
  g.color.copy(roofC);
  g.kind = K.roof;
  g.param = 1;
  const tc = (tz0 + tz1) / 2;
  cone(g, xf, 0, tc, (t + 0.1) * 1.3, 14.5, b.h - 0.6, 8);
  g.kind = K.plain;
  g.color.copy(PALETTE.accent);
  g.box(xf, -0.05, 0.05, b.h - 0.7, b.h + 0.9, tc - 0.05, tc + 0.05, 0);
  g.box(xf, -0.35, 0.35, b.h + 0.4, b.h + 0.5, tc - 0.05, tc + 0.05, 0);
  // the door: a big arched portal (dark doors in a pale frame) and a rose window above
  g.color.copy(trim);
  g.box(xf, -1.1, 1.1, 0.2, 3.4, tz0 - 0.12, tz0, 0, { bottom: false });
  g.color.set('#6B3E2A');
  g.box(xf, -0.85, 0.85, 0.2, 3.0, tz0 - 0.15, tz0 - 0.1, 0, { top: false });
  g.color.copy(trim);
  g.cylinder(xf, 0, tz0 - 0.06, 0.95, 7.2, 7.3, 12, true);
  g.color.set('#5866B8');
  g.kind = K.glow;
  g.param = 1.6;
  discFront(g, xf, 0, 7.6, tz0 - 0.07, 0.8, 12);
  g.kind = K.plain;
  g.param = 0;
  // steps
  g.color.copy(shade(PALETTE.road.sidewalk, 0.9));
  g.box(xf, -1.8, 1.8, -0.2, 0.32, tz0 - 0.4, tz0, 0);
}

/** A disc on a wall facing −z (centre x, y at z), as a fan. */
function discFront(g: Geo, xf: Xf, x: number, y: number, z: number, r: number, n: number) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    g.triL(xf, [x, y, z, x + Math.cos(a0) * r, y + Math.sin(a0) * r, z, x + Math.cos(a1) * r, y + Math.sin(a1) * r, z], [0, 0, Math.cos(a0), Math.sin(a0), Math.cos(a1), Math.sin(a1)], [0, 0, -1]);
  }
}

/** A gable roof whose ridge runs along local z from z0 to z1 (gable ends at both). */
function gableRoofZ(g: Geo, xf: Xf, hw: number, z0: number, z1: number, y: number, rise: number, color: Color, wall: Color, wallHW: number) {
  const yt = y + rise;
  const sl = Math.hypot(hw, rise);
  g.color.copy(color);
  g.kind = K.roof;
  g.param = 1;
  g.quadL(xf, [-hw, y, z0, -hw, y, z1, 0, yt, z1, 0, yt, z0], [z0, sl, z1, sl, z1, 0, z0, 0], [-1, 1, 0]);
  g.quadL(xf, [hw, y, z1, hw, y, z0, 0, yt, z0, 0, yt, z1], [z1, sl, z0, sl, z0, 0, z1, 0], [1, 1, 0]);
  g.kind = K.plain;
  g.color.copy(shade(color, 0.6));
  g.quadL(xf, [-hw, y - 0.14, z1, -hw, y - 0.14, z0, 0, yt - 0.14, z0, 0, yt - 0.14, z1], [0, 0, 1, 0, 1, 1, 0, 1], [0, -1, 0]);
  g.quadL(xf, [hw, y - 0.14, z0, hw, y - 0.14, z1, 0, yt - 0.14, z1, 0, yt - 0.14, z0], [0, 0, 1, 0, 1, 1, 0, 1], [0, -1, 0]);
  g.color.copy(wall);
  g.triL(xf, [wallHW, y, z1 - 0.35, -wallHW, y, z1 - 0.35, 0, yt - 0.14, z1 - 0.35], [0, 0, 1, 0, 0.5, 1], [0, 0, 1]);
  g.triL(xf, [-wallHW, y, z0, wallHW, y, z0, 0, yt - 0.14, z0], [0, 0, 1, 0, 0.5, 1], [0, 0, -1]);
}

function stadium(g: Geo, xf: Xf, b: Building) {
  // the wall is world/city's stadiumRing (collision uses the same superellipse)
  const n = 32;
  const outer = stadiumRing(b, 1, n);
  const lip = stadiumRing(b, 0.95, n);
  const inner = stadiumRing(b, 0.6, n);
  const A = b.w / 2 - 0.4;
  const B = b.d / 2 - 0.4;
  const wallC = new Color('#EFE6D6');
  const band = new Color('#3D9CA8');
  const seatA = new Color('#E07A5F');
  const seatB = new Color('#F3E9D2');
  const top = b.h;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const w = Math.hypot(outer[j * 2] - outer[i * 2], outer[j * 2 + 1] - outer[i * 2 + 1]);
    g.color.copy(wallC);
    g.kind = K.facade;
    g.param = facadeParam(F.arcade, b.seed);
    g.wall(xf, outer[i * 2], outer[i * 2 + 1], outer[j * 2], outer[j * 2 + 1], -0.8, top - 1.3, 0, Math.max(1, Math.round(w / 2.4)), ...vr(-0.8, top - 1.3, 10));
    g.color.copy(band);
    g.kind = K.plain;
    g.wall(xf, outer[i * 2], outer[i * 2 + 1], outer[j * 2], outer[j * 2 + 1], top - 1.3, top, 0, 1, 0, 1);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    g.color.copy(WHITE);
    g.kind = K.plain;
    g.quadL(xf, [outer[j * 2], top, outer[j * 2 + 1], outer[i * 2], top, outer[i * 2 + 1], lip[i * 2], top, lip[i * 2 + 1], lip[j * 2], top, lip[j * 2 + 1]], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 0]);
    g.color.copy(Math.floor(i / 4) % 2 ? seatA : seatB);
    g.kind = K.roof;
    g.param = 1;
    const sl = 4.6;
    g.quadL(xf, [lip[j * 2], top, lip[j * 2 + 1], lip[i * 2], top, lip[i * 2 + 1], inner[i * 2], 1.6, inner[i * 2 + 1], inner[j * 2], 1.6, inner[j * 2 + 1]], [0, 0, 1.4, 0, 1.4, sl, 0, sl], [-(lip[i * 2] + lip[j * 2]), 6, -(lip[i * 2 + 1] + lip[j * 2 + 1])]);
    g.color.set('#2F6F5A');
    g.kind = K.plain;
    g.quadL(xf, [inner[i * 2], 1.6, inner[i * 2 + 1], inner[j * 2], 1.6, inner[j * 2 + 1], inner[j * 2], 0.1, inner[j * 2 + 1], inner[i * 2], 0.1, inner[i * 2 + 1]], [0, 0, 1, 0, 1, 1, 0, 1], [-(inner[i * 2] + inner[j * 2]), 0, -(inner[i * 2 + 1] + inner[j * 2 + 1])]);
  }
  for (let i = 0; i < n; i += 4) {
    const px = outer[i * 2] * 0.985;
    const pz = outer[i * 2 + 1] * 0.985;
    g.color.copy(WHITE);
    g.kind = K.plain;
    g.cylinder(xf, px, pz, 0.05, top, top + 2.2, 4, true);
    g.color.copy(AWNINGS[(i / 4) % AWNINGS.length]);
    const ang = Math.atan2(pz, px) + Math.PI / 2;
    const fx = Math.cos(ang) * 0.9;
    const fz = Math.sin(ang) * 0.9;
    g.triL(xf, [px, top + 2.15, pz, px, top + 1.55, pz, px + fx, top + 1.85, pz + fz], [0, 0, 0, 1, 1, 0.5], [-fz, 0, fx]);
    g.triL(xf, [px, top + 2.15, pz, px, top + 1.55, pz, px + fx, top + 1.85, pz + fz], [0, 0, 0, 1, 1, 0.5], [fz, 0, -fx]);
  }
  g.color.set('#5DBB46');
  g.kind = K.lawn;
  g.capRing(xf, inner, 0.12, true, 1);
  g.color.copy(WHITE);
  g.kind = K.plain;
  const pa = A * 0.6 - 1.2;
  const pb = B * 0.6 - 1.2;
  const line = (x0: number, z0: number, x1: number, z1: number) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * 0.1;
    const nz = (dx / l) * 0.1;
    g.quadL(xf, [x0 - nx, 0.15, z0 - nz, x1 - nx, 0.15, z1 - nz, x1 + nx, 0.15, z1 + nz, x0 + nx, 0.15, z0 + nz], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 0]);
  };
  line(-pa, -pb, pa, -pb);
  line(pa, -pb, pa, pb);
  line(pa, pb, -pa, pb);
  line(-pa, pb, -pa, -pb);
  line(0, -pb, 0, pb);
  for (let i = 0; i < 16; i++) {
    const a0 = (i / 16) * Math.PI * 2;
    const a1 = ((i + 1) / 16) * Math.PI * 2;
    line(Math.cos(a0) * 2.4, Math.sin(a0) * 2.4, Math.cos(a1) * 2.4, Math.sin(a1) * 2.4);
  }
  // Floodlight masts: a dark lamp bank (2 × 4 lamps) tipped down toward the centre spot.
  const masts = stadiumMasts(b);
  for (let mi = 0; mi < masts.length; mi += 2) {
    const mx = masts[mi];
    const mz = masts[mi + 1];
    g.color.copy(METAL);
    g.kind = K.plain;
    g.param = 0;
    g.cylinder(xf, mx, mz, 0.14, 0, top + 2.2, 6, false);
    const l = Math.hypot(mx, mz) || 1;
    const nx = -mx / l, nz = -mz / l; // toward the pitch
    const tx = -nz, tz = nx;
    const ca = Math.cos(0.45), sa = Math.sin(0.45);
    // facing f = n·cos − up·sin; panel up u = n·sin + up·cos
    const fx = nx * ca, fy = -sa, fz = nz * ca;
    const ux = nx * sa, uy = ca, uz = nz * sa;
    const cx = mx + nx * 0.2, cy = top + 2.3, cz = mz + nz * 0.2;
    const P = (a: number, v: number, d: number): number[] => [cx + tx * a + ux * v + fx * d, cy + uy * v + fy * d, cz + tz * a + uz * v + fz * d];
    const quad = (a0: number, a1: number, v0: number, v1: number, d: number, face: [number, number, number]) =>
      g.quadL(xf, [...P(a0, v0, d), ...P(a1, v0, d), ...P(a1, v1, d), ...P(a0, v1, d)], [0, 0, 1, 0, 1, 1, 0, 1], face);
    g.color.copy(INK);
    quad(-0.85, 0.85, -0.5, 0.5, 0, [fx, fy, fz]);
    g.color.copy(METAL);
    quad(-0.85, 0.85, -0.5, 0.5, -0.1, [-fx, -fy, -fz]);
    quad(-0.85, 0.85, 0.5, 0.5, 0, [ux, uy, uz]);
    g.box(xf, mx - 0.08, mx + 0.08, top + 2.05, top + 2.25, mz - 0.08, mz + 0.08, 0);
    g.color.set('#FFF4D6');
    g.kind = K.glow;
    g.param = 1.8;
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
      const a0 = -0.75 + c * 0.39;
      const v0 = -0.4 + r * 0.42;
      quad(a0, a0 + 0.3, v0, v0 + 0.36, 0.02, [fx, fy, fz]);
    }
    g.kind = K.plain;
    g.param = 0;
  }
}
