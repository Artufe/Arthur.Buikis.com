import { describe, expect, it } from 'vitest';
import { clonePalette, mixPalette, PALETTES } from './palettes';

describe('palettes', () => {
  it('mixes endpoints exactly and midpoints linearly', () => {
    const out = clonePalette(PALETTES.light);
    mixPalette(PALETTES.light, PALETTES.dark, 0, out);
    expect(out.fogDensity).toBeCloseTo(PALETTES.light.fogDensity);
    expect(out.sandA.equals(PALETTES.light.sandA)).toBe(true);
    mixPalette(PALETTES.light, PALETTES.dark, 1, out);
    expect(out.bloom).toBeCloseTo(PALETTES.dark.bloom);
    mixPalette(PALETTES.light, PALETTES.dark, 0.5, out);
    expect(out.stars).toBeCloseTo((PALETTES.light.stars + PALETTES.dark.stars) / 2);
  });

  it('keeps the sun direction normalised while mixing', () => {
    const out = clonePalette(PALETTES.light);
    mixPalette(PALETTES.light, PALETTES.dark, 0.37, out);
    expect(out.sunDir.length()).toBeCloseTo(1);
  });

  it('clones deeply', () => {
    const c = clonePalette(PALETTES.light);
    c.sandA.setRGB(0, 0, 0);
    expect(PALETTES.light.sandA.r).toBeGreaterThan(0);
  });
});
