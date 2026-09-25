import { describe, expect, it } from 'vitest';
import { ARENA_R } from '../engine/types';
import { DUNE_START, groundHeight, TERRAIN_GLSL } from './terrain-shape';

describe('terrain shape', () => {
  it('keeps the arena floor gentle', () => {
    for (let x = -ARENA_R; x <= ARENA_R; x += 0.7) {
      for (let z = -ARENA_R; z <= ARENA_R; z += 0.7) {
        expect(Math.abs(groundHeight(x, z))).toBeLessThanOrEqual(0.28);
      }
    }
  });

  it('is continuous (no steps between neighbouring points)', () => {
    for (let x = -15; x < 15; x += 0.37) {
      expect(Math.abs(groundHeight(x, 3) - groundHeight(x + 0.05, 3))).toBeLessThan(0.02);
    }
  });

  it('uses the same undulation constants in GLSL and starts dunes outside the rock ring', () => {
    expect(TERRAIN_GLSL).toContain('0.1800');
    expect(TERRAIN_GLSL).toContain(`#define DUNE_START ${DUNE_START.toFixed(1)}`);
    expect(DUNE_START).toBeGreaterThanOrEqual(ARENA_R + 3);
  });
});
