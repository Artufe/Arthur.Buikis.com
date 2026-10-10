// @vitest-environment node
import { Vector2 } from 'three';
import { describe, expect, it } from 'vitest';
import { heldSignal, vehiclePatch } from './index';
import { buildVehicle } from './mesh';
import { KINDS } from './sim';

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** The colour × strength a glow term adds, read from the patch: `vGlow.<c>*vec3(r,g,b)*k`. */
function glow(c: string): number[] {
  const m = (vehiclePatch({ value: new Vector2() }, 1).fragment ?? '').match(new RegExp(`vGlow\\.${c}\\*vec3\\(([^)]*)\\)(?:\\*([0-9.]+))?`));
  if (!m) throw new Error(`no vGlow.${c} term`);
  return m[1].split(',').map((v) => Number(v) * Number(m[2] ?? 1));
}

describe('vehicle lamps', () => {
  it('blink a saturated amber over dark indicator glass', () => {
    const [r, g, b] = glow('w');
    // Neutral tone mapping turns a glow much past ~1.5 pastel: the lit indicator read as peach.
    expect(Math.max(r, g, b)).toBeLessThanOrEqual(1.5);
    expect(g / r).toBeGreaterThan(0.2);
    expect(g / r).toBeLessThan(0.4);
    expect(b).toBeLessThan(0.05 * r);
    for (const k of KINDS) {
      const geo = buildVehicle(k);
      const L = geo.getAttribute('aLamp');
      const C = geo.getAttribute('color');
      let n = 0;
      for (let i = 0; i < L.count; i++) {
        if (Math.abs(L.getZ(i)) !== 1) continue;
        n++;
        // unlit, the lamp is a dim amber albedo: well under half the lit glow
        expect(lum(C.getX(i), C.getY(i), C.getZ(i))).toBeLessThan(0.5 * lum(r, g, b));
        expect(C.getX(i)).toBeGreaterThan(C.getY(i));
      }
      expect(n, k.name).toBeGreaterThan(0);
    }
  });

  it('brake in red, not salmon', () => {
    const [r, g, b] = glow('z');
    expect(r).toBeLessThanOrEqual(1);
    expect(Math.max(g, b)).toBeLessThan(0.05 * r);
  });

  it('finish a cancelled flash instead of cutting it to a flicker', () => {
    // heldSignal's phase is the shader's: a flash is lit for t·1.5 in [n + 0.45, n + 1)
    expect(vehiclePatch({ value: new Vector2() }, 1).vertex).toContain('step(0.45,fract(lbTime*1.5))');
    expect(heldSignal(0, -1, 0.35)).toBe(-1); // cancelled mid-flash: the flash runs on
    expect(heldSignal(0, -1, 0.7)).toBe(0); // and ends with its phase
    expect(heldSignal(0, 0, 0.35)).toBe(0);
    expect(heldSignal(1, -1, 0.1)).toBe(1);
  });
});
