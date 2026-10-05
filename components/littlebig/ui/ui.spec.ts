import { describe, expect, it } from 'vitest';
import { Color, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { PALETTE } from '../render/palette';
import { CITY_LON, DAY_LENGTH, R, START_HOUR_ANGLE, SUN_DECLINATION } from '../world/config';
import { pitchForAlt as cameraPitch } from '../camera/model';
import { dirFromLatLon, headingVector } from '../world/sphere';
import { eveningTimeAt, sunDirection, sunElevation as worldElevation, timeAtHourAngle } from '../world/sun';
import { Declutter, altFade, circleHitsBox, framedFlyTarget, headingTangent, limbClearance, mul4, pitchForAlt, project, screenRadius } from './label-math';
import { activeMode, MODES } from './modes';
import { hourAngle, nextTimeTarget, sunElevation, warpRate } from './sun-time';
import { C, KIND_COLOR, WORLD } from './theme';

const hex = (c: Color) => `#${c.getHexString().toUpperCase()}`;

describe('ui theme mirrors its sources', () => {
  it('palette colours match render/palette.ts', () => {
    expect(C.ink).toBe(hex(PALETTE.ink));
    expect(C.accent).toBe(hex(PALETTE.accent));
    expect(C.cream).toBe(hex(PALETTE.walls[0]));
    expect(C.terracotta).toBe(hex(PALETTE.walls[1]));
    expect(C.teal).toBe(hex(PALETTE.walls[2]));
    expect(C.mustard).toBe(hex(PALETTE.walls[3]));
    expect(C.coral).toBe(hex(PALETTE.walls[4]));
    expect(C.lilac).toBe(hex(PALETTE.walls[5]));
    expect(C.glass).toBe(hex(PALETTE.walls[6]));
    expect(C.roofRed).toBe(hex(PALETTE.roofs[0]));
    expect(C.grass).toBe(hex(PALETTE.ground.grass));
    expect(C.sky).toBe(hex(PALETTE.sky.top));
    expect(C.marking).toBe(hex(PALETTE.road.marking));
    expect(C.snow).toBe(hex(PALETTE.ground.snow));
    expect(C.space).toBe(hex(PALETTE.sky.space));
  });
  it('world constants match world/config.ts', () => {
    expect(WORLD).toEqual({ R, CITY_LON, DAY_LENGTH, START_HOUR_ANGLE, SUN_DECLINATION });
  });
  it('every mode and kind has a colour', () => {
    for (const m of MODES) expect(m.color).toMatch(/^#[0-9A-F]{6}$/);
    for (const c of Object.values(KIND_COLOR)) expect(c).toMatch(/^#[0-9A-F]{6}$/);
  });
});

describe('sun-time', () => {
  it('agrees with world/sun.ts on hour angle and elevation', () => {
    for (const [lat, lon] of [
      [20, 10],
      [-35, 120],
      [55, -80],
    ]) {
      for (let t = 0; t < DAY_LENGTH * 1.5; t += 37) {
        const dir = dirFromLatLon(lat, lon);
        expect(sunElevation(t, lat, lon)).toBeCloseTo(worldElevation(dir, sunDirection(t)), 6);
        // hourAngle(timeAtHourAngle(h)) = h
        const h = ((t * 7) % 340) - 170;
        expect(hourAngle(timeAtHourAngle(h, lon), lon)).toBeCloseTo(h, 6);
      }
    }
  });
  it('aims at the next evening by day and the next morning by night, always ahead', () => {
    for (let t = 0; t < DAY_LENGTH * 2; t += 11) {
      const day = sunElevation(t, 20, 10) > 0;
      const tgt = nextTimeTarget(t, 20, 10);
      expect(tgt.to).toBe(day ? 'evening' : 'morning');
      expect(tgt.t).toBeGreaterThan(t);
      expect(tgt.t - t).toBeLessThanOrEqual(DAY_LENGTH + 2);
      const el = sunElevation(tgt.t, 20, 10);
      expect(el).toBeCloseTo(day ? -5 : 9, 4);
      // Evening is on the setting side (hour angle +), morning on the rising side.
      expect(Math.sign(hourAngle(tgt.t, 10))).toBe(day ? 1 : -1);
    }
  });
  it('the evening target is a little after world/sun.ts sunset', () => {
    const t = nextTimeTarget(0, 20, 10).t;
    expect(t).toBeGreaterThan(eveningTimeAt(20, 10, 0));
  });
  it('warp eases in, cruises, brakes into the target and never drops below 1×', () => {
    expect(warpRate(0, 100, 8)).toBe(1);
    expect(warpRate(0.35, 100, 8)).toBeGreaterThan(2);
    expect(warpRate(2, 100, 8)).toBe(8);
    expect(warpRate(2, 1, 8)).toBeLessThan(3);
    expect(warpRate(2, 0, 8)).toBe(1);
    // Simulate: it arrives, monotonically, in bounded time.
    let t = 0;
    let real = 0;
    const target = 60;
    while (t < target && real < 60) {
      t += warpRate(real, target - t, 8) / 60;
      real += 1 / 60;
    }
    expect(t).toBeGreaterThanOrEqual(target);
    expect(real).toBeLessThan(12);
  });
});

describe('label maths', () => {
  it('projects like three', () => {
    const cam = new PerspectiveCamera(50, 1.6, 0.5, 2000);
    cam.position.set(30, 220, 340);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const pv = new Float64Array(16);
    mul4(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements, pv);
    const ref = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    ref.elements.forEach((v, i) => expect(pv[i]).toBeCloseTo(v, 9));
    const sp = { x: 0, y: 0, w: 0, z: 0 };
    for (const p of [new Vector3(0, 0, 0), new Vector3(50, 120, 60), new Vector3(-80, 10, 150)]) {
      project(pv, p.x, p.y, p.z, 1600, 1000, sp);
      const q = p.clone().project(cam);
      expect(sp.x).toBeCloseTo(((q.x + 1) / 2) * 1600, 6);
      expect(sp.y).toBeCloseTo(((1 - q.y) / 2) * 1000, 6);
      expect(sp.w).toBeGreaterThan(0);
    }
  });
  it('hides what is behind the planet and keeps what is in front', () => {
    const eye = [0, 0, 560];
    // Facing point: visible. Far side: hidden. Near the limb but above it: visible.
    expect(limbClearance(eye[0], eye[1], eye[2], 0, 0, 162, 160)).toBeGreaterThan(0);
    expect(limbClearance(eye[0], eye[1], eye[2], 0, 0, -162, 160)).toBeLessThan(0);
    const limb = (Math.acos(160 / 560) * 180) / Math.PI; // angle from the sub-camera point to the limb
    const a = ((limb - 3) * Math.PI) / 180;
    expect(limbClearance(eye[0], eye[1], eye[2], 0, 162 * Math.sin(a), 162 * Math.cos(a), 160)).toBeGreaterThan(0);
    const b = ((limb + 12) * Math.PI) / 180;
    expect(limbClearance(eye[0], eye[1], eye[2], 0, 162 * Math.sin(b), 162 * Math.cos(b), 160)).toBeLessThan(0);
  });
  it('fades by altitude inside [minAlt, maxAlt]', () => {
    expect(altFade(100, 30, 600)).toBe(1);
    expect(altFade(10, 30, 600)).toBe(0);
    expect(altFade(2000, 30, 600)).toBe(0);
    expect(altFade(28, 30, 600)).toBeGreaterThan(0);
    expect(altFade(28, 30, 600)).toBeLessThan(1);
    expect(altFade(1.7, 0, Infinity)).toBe(1);
  });
  it('declutters by priority, sticks with what was shown, and keeps clear of panels', () => {
    const d = new Declutter(4);
    d.begin();
    const a = d.add(100, 100, 200, 130, 1, false, 0);
    const b = d.add(150, 110, 250, 140, 8, false, 0); // capital, overlapping a
    const c = d.add(400, 100, 500, 130, 1, false, 0);
    d.solve();
    expect([d.shown[a], d.shown[b], d.shown[c]]).toEqual([0, 1, 1]);
    // Same priority: last frame's winner keeps its place.
    d.begin();
    const e = d.add(100, 100, 200, 130, 2, false, -0.5);
    const f = d.add(150, 110, 250, 140, 2, true, 0.5);
    d.solve();
    expect([d.shown[e], d.shown[f]]).toEqual([0, 1]);
    // A reserved panel (the dock) hides what would sit under it.
    d.begin();
    d.reserve(0, 900, 1600, 1000);
    const g = d.add(700, 920, 800, 950, 8, true, 0);
    d.solve();
    expect(d.shown[g]).toBe(0);
  });
});

describe('keeping off the followed thing, framing a fly-to', () => {
  it('circle–box overlap and the screen radius of a sphere', () => {
    expect(circleHitsBox(100, 100, 30, 120, 90, 200, 110)).toBe(true); // box edge inside the circle
    expect(circleHitsBox(100, 100, 30, 125, 125, 200, 200)).toBe(false); // corner just outside (35 px)
    expect(circleHitsBox(100, 100, 5, 0, 0, 300, 300)).toBe(true); // circle inside the box
    const cam = new PerspectiveCamera(40, 1.6, 0.5, 2000);
    // 1 m at 10 m depth, 40° fov, 1000 px tall: 1 / (10 · tan 20°) · 500 px.
    expect(screenRadius(1, 10, cam.projectionMatrix.elements[5], 1000)).toBeCloseTo(500 / (10 * Math.tan((20 * Math.PI) / 180)), 6);
  });
  it('mirrors the camera: its altitude pitch curve and the heading frame', () => {
    for (let a = 1; a < 300; a *= 1.13) expect(pitchForAlt(a)).toBeCloseTo(cameraPitch(a), 12);
    const out = { x: 0, y: 0, z: 0 };
    for (const [lat, lon, h] of [
      [20, 10, 0.3],
      [-50, 140, -2.1],
      [89.99999, 0, 1],
    ]) {
      const up = dirFromLatLon(lat, lon);
      const ref = headingVector(up, h);
      headingTangent(up, h, out);
      expect(out.x).toBeCloseTo(ref.x, 9);
      expect(out.y).toBeCloseTo(ref.y, 9);
      expect(out.z).toBeCloseTo(ref.z, 9);
    }
  });
  it('flies short of a town so it lands in the middle of the view', () => {
    const R = 160;
    const focus = dirFromLatLon(20, 10);
    const town = dirFromLatLon(28, 34);
    for (const heading of [0, 1.2, -2.5]) {
      for (const alt of [42, 70]) {
        const t = framedFlyTarget(focus, heading, town, alt, R, { x: 0, y: 0, z: 0 });
        // The camera arrives above t, its heading carried along the great circle from focus: the
        // view's centre meets the ground alt / tan|pitch| ahead, which must be the town.
        const ax = new Vector3(focus.x, focus.y, focus.z).cross(new Vector3(t.x, t.y, t.z)).normalize();
        const ang = Math.acos(Math.min(1, focus.x * t.x + focus.y * t.y + focus.z * t.z));
        const f = new Vector3().copy(headingVector(focus, heading)).applyAxisAngle(ax, ang);
        const ahead = alt / Math.tan(-pitchForAlt(alt)) / R;
        const hit = new Vector3(t.x, t.y, t.z).multiplyScalar(Math.cos(ahead)).addScaledVector(f, Math.sin(ahead));
        expect(hit.angleTo(new Vector3(town.x, town.y, town.z)) * R).toBeLessThan(2.5);
      }
    }
    // Top-down (the capital's 120 m): straight over it.
    const c = framedFlyTarget(focus, 0.4, town, 120, R, { x: 0, y: 0, z: 0 });
    expect(new Vector3(c.x, c.y, c.z).angleTo(new Vector3(town.x, town.y, town.z))).toBeLessThan(1e-9);
  });
});

describe('modes', () => {
  it('six modes, keys 1–6, and the dock lights the right one', () => {
    expect(MODES.map((m) => m.key).join('')).toBe('123456');
    expect(activeMode('explore', undefined)).toBe('explore');
    expect(activeMode('bird', undefined)).toBe('bird');
    expect(activeMode('ride', 'balloon')).toBe('plane');
    expect(activeMode('ride', 'ferry')).toBe('drive');
    expect(activeMode('ride', 'station')).toBe('space');
    expect(activeMode('ride', 'person')).toBe('people');
  });
  it('every trackable kind belongs to exactly one mode', () => {
    const kinds = ['plane', 'balloon', 'car', 'bus', 'truck', 'train', 'boat', 'ferry', 'person', 'satellite', 'station'] as const;
    for (const k of kinds) expect(MODES.filter((m) => m.kinds.includes(k)).length).toBe(1);
  });
});
