// The lighting rig and day-cycle look as plain math (A3): what colour the sun, fill, rim, dusk tint,
// fog and sky are for a given sun elevation, and how far the sky dome reaches at a given altitude.
// The sky system calls these once per frame (zero allocation: everything writes into `out`), and
// the specs pin the art direction (a golden, never orange, sun; a pink/purple terminator).

import { Color } from 'three';
import { PALETTE } from '../render/palette';

const DEG = Math.PI / 180;

/**
 * The linear colour that three's Neutral tone curve displays as `hex`. The curve subtracts an
 * offset set by the darkest channel x (x − 6.25x² below 0.08, else 0.04), so dark, saturated
 * colours come out far darker and more saturated than written. For dark palette entries only.
 */
export function fromScreen(hex: string, out = new Color()): Color {
  out.set(hex);
  const m = Math.min(out.r, out.g, out.b);
  const off = m < 0.04 ? Math.sqrt(m / 6.25) - m : 0.04;
  return out.setRGB(out.r + off, out.g + off, out.b + off);
}

// ── colours (sRGB hex → linear via three's ColorManagement) ──
export const SKY = {
  horizon: PALETTE.sky.horizon.clone(),
  top: PALETTE.sky.top.clone(),
  /** The saturated blue between the day sky and space (the upper air, the outer rim). */
  deep: new Color('#1d4fc4'),
  /**
   * Space: the palette's #070B1A sits so deep that the Neutral tone curve crushes it to near black;
   * this linear value lands on screen as a deep blue (~#0a1030).
   */
  space: new Color().setRGB(0.017, 0.02, 0.047),
  nightHorizon: new Color('#2b3474'),
  nightTop: new Color('#0b1236'),
  /** Golden-hour glow low around the sun. */
  gold: new Color('#ffd98f'),
  /** The outer edge of the glow around a low sun (where it meets the blue). */
  peach: new Color('#ffb48c'),
  /** Dusk: orange right at the sun, pink beside it, purple away from it (the belt of Venus). */
  duskOrange: new Color('#ff9a62'),
  duskPink: new Color('#ff8fb1'),
  duskPurple: new Color('#8b6fd6'),
  sunDisc: new Color('#fff6d8'),
};

const SUN_DAY = new Color('#fff4e2');
/** The warmest the key light gets over the planet: golden, never sunset orange (the terminator is per fragment). */
export const SUN_GOLD = new Color('#ffcb80');
/**
 * Alpenglow: the key light as the EYE sees a low sun from inside the air (street … cloud layer), when
 * the sun hangs on the dipped visible horizon. Only near the eye (faded out toward orbit), so the
 * lit hemisphere seen from space is never orange.
 */
export const SUN_ALPEN = new Color('#ff9f86');
/** Direct-light tint in the terminator band (lbDuskTint × lbDuskAt): rose, fading into the purple night fill. */
export const DUSK_TINT = new Color('#ff8fb4');
/**
 * Fill colours. three divides indirect diffuse by π and the Neutral tone curve crushes anything
 * whose darkest channel is under ~0.08, so the fill must be strong (×π-scaled) and not too blue, or
 * neutral surfaces in shade lose their red and land as navy holes (BRIEF §3: tinted, not black).
 */
const SKY_FILL_DAY = new Color('#a8b6f2');
const SKY_FILL_GOLD = new Color('#e6c4dc');
/** At dusk the open sky is pink and lilac: so is the light it throws. */
const SKY_FILL_DUSK = new Color('#d9a0dc');
const GROUND_FILL = new Color('#e0b892');
/** Moonlight: a deep blue-violet, dim enough that the night side reads as night and the city lights pop. */
const NIGHT_FILL = new Color('#4e58ac');
/** The fill near the eye while the sun is on the dipped horizon: the sunset sky's pink-lilac. */
const DUSK_FILL = new Color('#c49ce0');
const RIM_DAY = PALETTE.sky.rim.clone();
const RIM_GOLD = new Color('#ffd9a8');
const RIM_ALPEN = new Color('#ffb08c');
const RIM_NIGHT = new Color('#7b8cff');
const FOG_NIGHT = new Color('#1d2556');
const WHITE = new Color(1, 1, 1);
// The sun disc by its elevation over the visible horizon: cream high up, golden below ~25°, the site
// amber around 10°, deep amber-orange on the horizon. Never white-clipped (the shader mixes it in).
const DISC: Array<[number, Color]> = [
  [-2, new Color('#ff7a3a')],
  [4, new Color('#ff8f3f')],
  [11, PALETTE.accent.clone()],
  [24, new Color('#ffd27c')],
  [40, new Color('#fff0cc')],
];
const _c = new Color();

/** Fill strength knobs (×π-scaled) and the key light's intensity, tunable live through params (sky.fill / sky.bounce / sky.key / sky.moon). */
export const FILL = { sky: 2.6, bounce: 1.25, key: 3.3, moon: 1.1 };

export function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── the sky dome's reach ──
// Seen from orbit the air is a thin rim hugging the planet's limb; descending, it grows up from the
// limb until it fills the whole sky below the cloud layer. The dome angle θ is how far above the
// limb (rad) the air's colours reach: the shader's profile runs horizon → sky blue → deep blue →
// space over [0, θ]. A table in log-altitude, interpolated smoothly (C1), so the sky "takes over"
// gracefully instead of ballooning into a bright halo mid-dive.
const DOME: Array<[number, number]> = [
  // [altitude above sea level (m), θ (deg)]
  [20, 190],
  [34, 150],
  [50, 96],
  [75, 44],
  [110, 19],
  [160, 9],
  [250, 3.6],
  [420, 2.5],
];
const DOME_L = DOME.map(([a]) => Math.log(a));
const DOME_V = DOME.map(([, d]) => Math.log(d * DEG));

/** Dome angle θ (rad) for an eye at `altSea` m above sea level. Monotone, smooth in log-altitude. */
export function domeAngle(altSea: number): number {
  const l = Math.log(Math.max(1, altSea));
  if (l <= DOME_L[0]) return Math.exp(DOME_V[0]);
  const n = DOME_L.length - 1;
  if (l >= DOME_L[n]) {
    // Keep thinning gently past the table (the far end of the orbit range).
    const slope = (DOME_V[n] - DOME_V[n - 1]) / (DOME_L[n] - DOME_L[n - 1]);
    return Math.exp(DOME_V[n] + slope * (l - DOME_L[n]));
  }
  let i = 0;
  while (l > DOME_L[i + 1]) i++;
  // Monotone cubic Hermite in log-log space (Fritsch–Carlson tangents: no overshoot).
  const h = DOME_L[i + 1] - DOME_L[i];
  const t = (l - DOME_L[i]) / h;
  const m0 = domeTangent(i);
  const m1 = domeTangent(i + 1);
  const t2 = t * t;
  const t3 = t2 * t;
  const v = (2 * t3 - 3 * t2 + 1) * DOME_V[i] + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * DOME_V[i + 1] + (t3 - t2) * h * m1;
  return Math.exp(v);
}

function domeTangent(i: number): number {
  const n = DOME_L.length - 1;
  const d = (k: number) => (DOME_V[k + 1] - DOME_V[k]) / (DOME_L[k + 1] - DOME_L[k]);
  if (i === 0) return d(0);
  if (i === n) return d(n - 1);
  const a = d(i - 1);
  const b = d(i);
  if (a * b <= 0) return 0;
  return (2 * a * b) / (a + b); // harmonic mean: monotone
}

/**
 * Reach of the air's soft outer fade (rad, ≥ domeAngle): from altitude the cloud shell (up to
 * ~R + 50) stands up to ~6° above the limb, so the fade must reach past it or limb clouds hang in
 * black space. Inside the air it is the dome angle itself.
 */
export function tailAngle(altSea: number, R: number): number {
  const theta = domeAngle(altSea);
  const r = R + Math.max(1, altSea);
  const top = R + 50;
  if (r <= top + 2) return theta;
  const cloud = Math.asin(top / r) - Math.asin(R / r);
  return Math.max(theta, cloud * 1.15);
}

/** 0 inside the air (street … cloud layer) … 1 in orbit: star visibility, halo tightness. */
export function spaceAmount(altSea: number): number {
  return smooth(Math.log(45), Math.log(330), Math.log(Math.max(1, altSea)));
}

/**
 * sin of the (capped) horizon dip at the eye, faded out toward orbit: the sky as the EYE sees it
 * keeps the sun a little after it has set underfoot (the horizon dips ~8° at eye height here).
 */
export function skyDipSin(ground: number, altTerrain: number, altSea: number, R: number): number {
  const dip = Math.acos(Math.min(1, (R + ground) / (R + ground + Math.max(0, altTerrain))));
  return Math.sin(Math.min(dip, 9 * DEG)) * (1 - spaceAmount(altSea));
}

/** 0 inside the air … 1 in orbit: where sky and clouds switch from the eye's time of day to per-ray / per-cloud. */
export function airSpace(altSea: number): number {
  return smooth(60, 300, altSea);
}

/** GLSL twins: lbNightAt / lbDuskAt (render/toon.ts) on a sun elevation sine. */
export function nightAtSin(e: number): number {
  return 1 - smooth(-0.18, 0.12, e);
}
export function duskAtSin(e: number): number {
  return smooth(-0.12, 0.05, e) * (1 - smooth(0.05, 0.35, e));
}

// ── the lighting rig ──
export interface LightRig {
  /** Key light colour (intensity separate). */
  sun: Color;
  sunIntensity: number;
  skyFill: Color;
  groundFill: Color;
  nightFill: Color;
  rim: Color;
  duskTint: Color;
  fog: Color;
  /** Sun disc colour by elevation (deep amber on the horizon, golden low, cream high). */
  disc: Color;
  /** 0..1: golden-hour amount at the focus (sky glow around the sun). */
  warm: number;
  /** 0..1: sunset-band amount for the sky as the eye sees it. */
  dusk: number;
  /** 0..1: how night the sky is as the eye sees it. */
  nightSky: number;
  /** 0..1: alpenglow near the eye (sun on the dipped visible horizon, inside the air). */
  alpen: number;
}

export function createRig(): LightRig {
  return {
    sun: new Color(),
    sunIntensity: 2.7,
    skyFill: new Color(),
    groundFill: new Color(),
    nightFill: new Color(),
    rim: new Color(),
    duskTint: new Color(),
    fog: new Color(),
    disc: new Color(),
    warm: 0,
    dusk: 0,
    nightSky: 0,
    alpen: 0,
  };
}

/** Sun disc colour for an elevation (deg) over the visible horizon. */
export function discColor(elevDeg: number, out: Color): Color {
  if (elevDeg <= DISC[0][0]) return out.copy(DISC[0][1]);
  for (let i = 0; i < DISC.length - 1; i++) {
    const [e1, c1] = DISC[i + 1];
    if (elevDeg <= e1) {
      const [e0, c0] = DISC[i];
      return out.copy(c0).lerp(c1, smooth(e0, e1, elevDeg));
    }
  }
  return out.copy(DISC[DISC.length - 1][1]);
}

/**
 * The rig for a sun at elevation sin `elev` over the focus, and `elevSky` over the eye's visible
 * horizon (the sky keeps the sun a little longer: the horizon dips ~8° at eye height).
 * `night` is the surface night factor at the focus (world/sun.ts nightFactor); `space` is
 * spaceAmount(altSea); `elevGold` (default `elev`) caps the elevation the golden-hour window sees.
 */
export function computeRig(elev: number, elevSky: number, night: number, out: LightRig, space = 0, elevGold = elev): LightRig {
  const nx = Math.min(1, Math.max(0, (elevSky + 0.2) / 0.3));
  const nightSky = 1 - nx * nx * (3 - 2 * nx);
  // Golden hour: a wide window (sun below ~45°), gone below the horizon. The late-afternoon start
  // (sun ~16° over the street, ~28° over the centre) sits well inside it.
  // `elevGold` lets the city's clock decide how golden the light is near the city (see the sky
  // system): its edge is ~30° of sun angle from its middle on this tiny planet.
  const warm = (1 - smooth(0.3, 0.72, Math.min(elev, elevGold))) * smooth(-0.06, 0.08, Math.max(elev, elevSky));
  // The sunset band of the sky: sun within ~±12° of the visible horizon.
  const dusk = Math.max(0, 1 - Math.abs(elevSky - 0.02) / 0.24) * (1 - nightSky * 0.6);
  // Alpenglow: inside the air, sun from ~2° under to ~10° over the visible horizon. The key light
  // follows the sky there (it is the sun the eye sees), so sun-facing walls and tower tops catch a
  // warm rose light while the street below is in the planet's shadow.
  const alpen = (1 - space) * smooth(-0.06, -0.015, elevSky) * (1 - smooth(0.07, 0.2, elevSky));

  out.warm = warm;
  out.dusk = dusk;
  out.nightSky = nightSky;
  out.alpen = alpen;
  // From orbit the whole lit hemisphere is in view (noon included): half the golden tint there.
  out.sun.copy(SUN_DAY).lerp(SUN_GOLD, Math.min(1, warm * 0.95 + dusk * 0.15) * (1 - 0.5 * space)).lerp(SUN_ALPEN, alpen * 0.85);
  out.sunIntensity = FILL.key * (1 - 0.22 * alpen);
  // Fill: lavender sky light from above, warm bounce from below; peach in golden light, pink-lilac
  // at dusk. Strong enough that shade stays a colour (see FILL).
  out.skyFill
    .copy(SKY_FILL_DAY)
    .lerp(SKY_FILL_GOLD, warm * 0.25)
    .lerp(SKY_FILL_DUSK, dusk * 0.55)
    .multiplyScalar(FILL.sky * (1 + dusk * 0.1));
  out.groundFill.copy(GROUND_FILL).multiplyScalar(FILL.bounce);
  // Moonlight: a dim blue-violet: the night side keeps its shapes but reads as night, so windows,
  // streetlights and headlights are the brightest things there.
  // Near the eye while the sunset sky is up, the light from the sky is its pink-lilac, stronger
  // than the moon: dusk at the street is dusk, not night under a sunset sky.
  const duskNear = (1 - space) * smooth(-0.16, -0.05, elevSky) * (1 - smooth(0.02, 0.16, elevSky));
  out.nightFill.copy(NIGHT_FILL).multiplyScalar(FILL.moon).lerp(_c.copy(DUSK_FILL).multiplyScalar(1.9), duskNear);
  out.rim.copy(RIM_DAY).lerp(RIM_GOLD, warm * 0.7).lerp(RIM_ALPEN, alpen).lerp(RIM_NIGHT, night * (1 - alpen));
  out.duskTint.copy(WHITE).lerp(DUSK_TINT, 0.9);
  // Fog = the horizon colour as the eye sees it.
  out.fog.copy(SKY.horizon).lerp(SKY.gold, warm * 0.22).lerp(SKY.duskPink, dusk * 0.35).lerp(FOG_NIGHT, nightSky);
  discColor((Math.asin(Math.max(-1, Math.min(1, elevSky))) * 180) / Math.PI, out.disc);
  return out;
}

// ── the cloud palette ──
// Cloud colour by the sun's elevation (sin) at the cloud: white → cream (golden) → peach-pink (dusk)
// → mauve (twilight) → moonlit indigo (night). Every stop is saturated, and interpolation only runs
// between neighbours, so a cloud never passes through grey (a white → navy lerp did). The puff
// shader gets the same stops as uniform arrays (clouds/), the sky's painted cumulus a CPU sample.
// Peach and mauve live strictly inside the dusk band (lbDuskAt > 0.8 at both stops); by the time
// lbNightAt passes 0.5 (e ≈ −0.03) the clouds are 80 % of the way to a deep indigo, and fully there
// at −0.04, so the city lights stay the brightest thing on the night side.
// The night stops are given as the colour they should SHOW (fromScreen): the Neutral tone curve
// crushes dark colours with a small darkest channel, so a plain #2c315f rendered as (12, 25, 85),
// a saturated royal blue glowing over the black-green night ground.
export const CLOUD_PAL_E = [-0.04, 0.01, 0.07, 0.2, 0.42];
export const CLOUD_PAL_LIT = [fromScreen('#1c2041'), ...['#c69ad0', '#ffcab4', '#fff2de', '#ffffff'].map((h) => new Color(h))];
export const CLOUD_PAL_SHADE = [fromScreen('#11142d'), ...['#8a7fc4', '#c6a8dc', '#d4cdee', '#cdd3f3'].map((h) => new Color(h))];
export const CLOUD_PAL_BELLY = [fromScreen('#0d1024'), ...['#6a62ae', '#a898d4', '#bcb9e6', '#c3c8ef'].map((h) => new Color(h))];
/** Rim: a thin silvery moon edge at night, warm by day. */
export const CLOUD_PAL_RIM = ['#9aa3e0', '#e6b4e0', '#ffd6b8', '#fff0d8', '#ffffff'].map((h) => new Color(h));

/** CPU sample of the cloud palette (twin of the puff shader's cloudPal()). */
export function cloudPalette(e: number, lit: Color, shade: Color, belly: Color, rim: Color) {
  const E = CLOUD_PAL_E;
  let i = 0;
  while (i < E.length - 2 && e > E[i + 1]) i++;
  const t = Math.min(1, Math.max(0, (e - E[i]) / (E[i + 1] - E[i])));
  lit.copy(CLOUD_PAL_LIT[i]).lerp(CLOUD_PAL_LIT[i + 1], t);
  shade.copy(CLOUD_PAL_SHADE[i]).lerp(CLOUD_PAL_SHADE[i + 1], t);
  belly.copy(CLOUD_PAL_BELLY[i]).lerp(CLOUD_PAL_BELLY[i + 1], t);
  rim.copy(CLOUD_PAL_RIM[i]).lerp(CLOUD_PAL_RIM[i + 1], t);
}

const _l = new Color();
const _s = new Color();
const _b = new Color();
const _r = new Color();
/**
 * The colour inside a cloud (the white-out veil, the scene fog in the mist, the sky behind it):
 * a cool grey-lilac between the cloud's shade and belly, a touch below the lit side, so fogged
 * buildings never go whiter than the sky. `lit` (optional) receives the lit stop for highlights.
 */
export function mistColor(e: number, out: Color, lit?: Color): Color {
  cloudPalette(e, _l, _s, _b, _r);
  if (lit) lit.copy(_l).lerp(_s, 0.1);
  return out.copy(_s).lerp(_b, 0.45).lerp(_l, 0.1);
}
