import { Color, Vector3 } from 'three';

export type Theme = 'light' | 'dark';

export type Palette = {
  skyZenith: Color;
  skyHorizon: Color;
  fog: Color;
  fogDensity: number;
  sunDir: Vector3; // world direction toward the sun / moon
  sunColor: Color;
  sunIntensity: number;
  sunSize: number; // angular radius, radians
  stars: number; // 0..1
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  sandA: Color; // light sand
  sandB: Color; // dark sand
  groove: Color; // compacted sand in the groove
  rim: Color; // pushed-up sand either side
  dust: Color; // particle colour
  glint: number;
  foodGlow: number;
  bloom: number;
  exposure: number;
};

const COLOR_KEYS = [
  'skyZenith',
  'skyHorizon',
  'fog',
  'sunColor',
  'hemiSky',
  'hemiGround',
  'sandA',
  'sandB',
  'groove',
  'rim',
  'dust',
] as const;
const NUMBER_KEYS = [
  'fogDensity',
  'sunIntensity',
  'sunSize',
  'stars',
  'hemiIntensity',
  'glint',
  'foodGlow',
  'bloom',
  'exposure',
] as const;

export const PALETTES: Record<Theme, Palette> = {
  // Golden hour: low warm sun behind the play field, long shadows toward the camera.
  light: {
    skyZenith: new Color('#4f79b8'),
    skyHorizon: new Color('#ffc995'),
    fog: new Color('#f0c39a'),
    fogDensity: 0.011,
    sunDir: new Vector3(-0.5, 0.26, -0.83).normalize(),
    sunColor: new Color('#ffcf9a'),
    sunIntensity: 3.4,
    sunSize: 0.035,
    stars: 0,
    hemiSky: new Color('#a9c3e8'),
    hemiGround: new Color('#d49a5e'),
    hemiIntensity: 0.7,
    sandA: new Color('#e7b67c'),
    sandB: new Color('#c8894f'),
    groove: new Color('#9c6538'),
    rim: new Color('#f2cd98'),
    dust: new Color('#e9c28f'),
    glint: 1,
    foodGlow: 1,
    bloom: 0.32,
    exposure: 1.0,
  },
  // Moonlit night: cool silver key light, stars, food as the brightest thing on screen.
  dark: {
    skyZenith: new Color('#03060f'),
    skyHorizon: new Color('#16213d'),
    fog: new Color('#141c33'),
    fogDensity: 0.014,
    sunDir: new Vector3(0.45, 0.55, -0.7).normalize(),
    sunColor: new Color('#aebfff'),
    sunIntensity: 1.25,
    sunSize: 0.022,
    stars: 1,
    hemiSky: new Color('#2b3a6b'),
    hemiGround: new Color('#2e2a26'),
    hemiIntensity: 0.45,
    sandA: new Color('#a8a095'),
    sandB: new Color('#7d776f'),
    groove: new Color('#4d4a4a'),
    rim: new Color('#c2bcb0'),
    dust: new Color('#8e8a86'),
    glint: 1.6,
    foodGlow: 1.8,
    bloom: 0.55,
    exposure: 1.1,
  },
};

export function clonePalette(p: Palette): Palette {
  const out = { ...p } as Palette;
  for (const k of COLOR_KEYS) out[k] = p[k].clone();
  out.sunDir = p.sunDir.clone();
  return out;
}

export function mixPalette(a: Palette, b: Palette, t: number, out: Palette): Palette {
  for (const k of COLOR_KEYS) out[k].lerpColors(a[k], b[k], t);
  for (const k of NUMBER_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  out.sunDir.lerpVectors(a.sunDir, b.sunDir, t).normalize();
  return out;
}
