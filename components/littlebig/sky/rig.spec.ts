import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import { CITY_LAT, CITY_LON, DAY_LENGTH } from '../world/config';
import { dirFromLatLon, dot3 } from '../world/sphere';
import { moonDirection, nightFactor, sunDirection, timeAtHourAngle } from '../world/sun';
import { CLOUD_PAL_E, cloudPalette, computeRig, createRig, domeAngle, DUSK_TINT, duskAtSin, fromScreen, nightAtSin } from './rig';

const DEG = 180 / Math.PI;

describe('sky dome reach', () => {
  it('fills the sky at the street, is a crisp rim from orbit, and never jumps on the way', () => {
    expect(domeAngle(4) * DEG).toBeGreaterThan(170);
    expect(domeAngle(400) * DEG).toBeLessThan(3);
    let prev = domeAngle(2);
    for (let a = 2.5; a <= 450; a += 0.5) {
      const d = domeAngle(a);
      expect(d).toBeLessThanOrEqual(prev + 1e-9); // monotone: the air only thins with altitude
      expect(prev / d).toBeLessThan(1.04); // smooth: < 4 % per half metre (no balloon, no pop)
      prev = d;
    }
  });
});

describe('lighting rig', () => {
  const city = dirFromLatLon(CITY_LAT, CITY_LON);
  const rig = createRig();
  const hsl = { h: 0, s: 0, l: 0 };

  it('keeps the key light golden at most over a whole day as seen from orbit (never sunset orange)', () => {
    for (let t = 0; t < DAY_LENGTH; t += 2) {
      const s = sunDirection(t);
      const e = dot3(city, s);
      for (const [space, elevSky] of [
        [1, e], // orbit: the whole lit hemisphere is in view
        [0, Math.max(e, 0.22)], // in the air with the sun well up
      ]) {
        computeRig(e, elevSky, nightFactor(city, s), rig, space);
        // Linear ratios: golden (#ffcb80 ≈ g/r 0.6, b/r 0.22) passes; orange (#ff9a40 ≈ 0.32, 0.05) fails.
        expect(rig.sun.g / rig.sun.r).toBeGreaterThan(0.55);
        expect(rig.sun.b / rig.sun.r).toBeGreaterThan(0.18);
      }
    }
  });

  it('gives alpenglow only near the eye, while the sun sits on the visible horizon', () => {
    computeRig(-0.12, 0.02, 0.9, rig, 0);
    expect(rig.alpen).toBeGreaterThan(0.9);
    new Color().copy(rig.sun).getHSL(hsl);
    expect(hsl.h < 0.06 || hsl.h > 0.95).toBe(true); // rose-orange, not white
    computeRig(-0.12, 0.02, 0.9, rig, 1);
    expect(rig.alpen).toBe(0);
  });

  it('keeps shade a colour: the sky fill survives the tone curve (darkest channel ≥ 0.08 × π on asphalt)', () => {
    const s = sunDirection(0);
    const e = dot3(city, s);
    computeRig(e, e, 0, rig, 0);
    // Shaded asphalt (linear albedo ≈ 0.10): fill · albedo / π must clear the Neutral curve's toe.
    expect(Math.min(rig.skyFill.r, rig.skyFill.g, rig.skyFill.b) * 0.1 / Math.PI).toBeGreaterThan(0.03);
  });

  it('starts golden over the city and puts pink, not orange, on the terminator', () => {
    const s = sunDirection(0);
    const e = dot3(city, s);
    computeRig(e, e, 0, rig);
    expect(rig.warm).toBeGreaterThan(0.4);
    new Color().copy(DUSK_TINT).getHSL(hsl);
    expect(hsl.h > 0.85 || hsl.h < 0.02).toBe(true); // rose / pink, not orange (h ≈ 0.08)
  });

  it('hangs the moon over the city at midnight', () => {
    const m = moonDirection(timeAtHourAngle(180));
    expect(Math.asin(dot3(city, m)) * DEG).toBeGreaterThan(30);
  });
});

describe('cloud palette', () => {
  // three's Neutral tone curve on one channel set (linear in, linear out), below its compression knee.
  const neutral = (c: Color) => {
    const x = Math.min(c.r, c.g, c.b);
    const off = x < 0.08 ? x - 6.25 * x * x : 0.04;
    return new Color(c.r - off, c.g - off, c.b - off);
  };
  const lum = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  it('fromScreen lands dark colours on screen as written (the tone curve crushes them otherwise)', () => {
    for (const hex of ['#1c2041', '#11142d', '#2a2f5e']) {
      const want = new Color(hex);
      const got = neutral(fromScreen(hex));
      expect(Math.abs(got.r - want.r) + Math.abs(got.g - want.g) + Math.abs(got.b - want.b)).toBeLessThan(1e-6);
    }
  });

  it('is moonlit cotton past the terminator (never a dark hole) and keeps peach and mauve inside the dusk band', () => {
    const lit = new Color();
    const shade = new Color();
    const belly = new Color();
    const rim = new Color();
    const space = lum(neutral(new Color().setRGB(0.017, 0.02, 0.047)));
    // Night (lbNightAt > 0.5): the moon side silver-lilac, ≥ 2.5× space, the body above the night
    // sky, blue-violet; still far below a warm window (~0.6).
    for (let e = -0.6; e <= 1; e += 0.005) {
      if (nightAtSin(e) <= 0.55) continue;
      cloudPalette(e, lit, shade, belly, rim);
      const shown = neutral(lit);
      expect(lum(shown)).toBeGreaterThan(2.5 * space);
      if (nightAtSin(e) > 0.9) expect(lum(shown)).toBeLessThan(0.15); // (blue hour above that: lavender afterglow)
      expect(lum(neutral(belly))).toBeGreaterThan(1.3 * space);
      expect(shown.b).toBeGreaterThan(shown.r);
    }
    // The warm stops (mauve, peach) sit where the dusk band is strong and it is not yet night.
    for (const e of [CLOUD_PAL_E[2], CLOUD_PAL_E[3]]) {
      expect(duskAtSin(e)).toBeGreaterThan(0.8);
      expect(nightAtSin(e)).toBeLessThan(0.5);
    }
  });
});

