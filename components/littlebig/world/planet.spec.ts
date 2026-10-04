import { describe, expect, it } from 'vitest';
import { CITY_LAT, CITY_LON, OCEAN_FLOOR, PEAK, PLATEAU_BLEND, PLATEAU_HEIGHT, PLATEAU_RADIUS, R } from './config';
import { icosphere } from './icosphere';
import { Biome, createPlanet, getPlanet } from './planet';
import { chartToDir, createChart, dirFromLatLon, v3 } from './sphere';
import { nightFactor, sunDirection, sunElevation, timeAtHourAngle } from './sun';

describe('planet', () => {
  const planet = getPlanet();
  const ico = icosphere(5);
  const heights = new Float64Array(ico.vertexCount);
  const d = v3();
  for (let i = 0; i < ico.vertexCount; i++) {
    d.x = ico.positions[i * 3];
    d.y = ico.positions[i * 3 + 1];
    d.z = ico.positions[i * 3 + 2];
    heights[i] = planet.heightAt(d);
  }

  it('is deterministic for a seed', () => {
    const other = createPlanet(planet.seed);
    const p = dirFromLatLon(-12, 77);
    expect(other.heightAt(p)).toBe(planet.heightAt(p));
    expect(createPlanet(planet.seed + 1).heightAt(p)).not.toBe(planet.heightAt(p));
  });

  it('stays in range and has oceans, land, mountains and snow', () => {
    let land = 0;
    let max = -Infinity;
    let min = Infinity;
    for (const h of heights) {
      if (h > 0) land++;
      max = Math.max(max, h);
      min = Math.min(min, h);
    }
    expect(min).toBeGreaterThanOrEqual(OCEAN_FLOOR);
    expect(max).toBeLessThanOrEqual(PEAK);
    const frac = land / heights.length;
    expect(frac).toBeGreaterThan(0.2);
    expect(frac).toBeLessThan(0.6);
    expect(max).toBeGreaterThan(18); // snowcapped peaks exist
    expect(min).toBeLessThan(-8); // deep water exists
  });

  it('has a flat city plateau with a smooth (cliff-free) edge', () => {
    const chart = createChart(CITY_LAT, CITY_LON, R + PLATEAU_HEIGHT);
    // Flat inside the cap.
    for (let i = 0; i < 400; i++) {
      const a = i * 2.399;
      const r = Math.sqrt(i / 400) * PLATEAU_RADIUS * (R + PLATEAU_HEIGHT) * 0.999;
      expect(Math.abs(planet.heightAt(chartToDir(chart, Math.cos(a) * r, Math.sin(a) * r)) - PLATEAU_HEIGHT)).toBeLessThanOrEqual(0.05);
    }
    // Across the blend ring, along 64 rays: land, and no slope steeper than ~35°.
    const step = 0.5;
    const r0 = PLATEAU_RADIUS * (R + PLATEAU_HEIGHT);
    const r1 = (PLATEAU_RADIUS + PLATEAU_BLEND) * (R + PLATEAU_HEIGHT) + 4;
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      let prev = planet.heightAt(chartToDir(chart, Math.cos(a) * r0, Math.sin(a) * r0));
      for (let r = r0 + step; r <= r1; r += step) {
        const h = planet.heightAt(chartToDir(chart, Math.cos(a) * r, Math.sin(a) * r));
        expect(Math.abs(h - prev) / step).toBeLessThan(0.7);
        prev = h;
      }
    }
    expect(planet.biomeAt(planet.cityDir)).toBe(Biome.City);
    expect(planet.plateauWeight(planet.cityDir)).toBe(1);
  });

  it('has the sea within sight of the plateau edge', () => {
    const chart = createChart(CITY_LAT, CITY_LON, R + PLATEAU_HEIGHT);
    let found = false;
    for (let k = 0; k < 64 && !found; k++) {
      const a = (k / 64) * Math.PI * 2;
      for (let r = 92; r < 150; r += 2) {
        if (planet.heightAt(chartToDir(chart, Math.cos(a) * r, Math.sin(a) * r)) < 0) found = true;
      }
    }
    expect(found).toBe(true);
  });
});

describe('sun', () => {
  it('starts in late-afternoon light over the city and sets later', () => {
    const city = dirFromLatLon(CITY_LAT, CITY_LON);
    const e0 = sunElevation(city, sunDirection(0));
    expect(e0).toBeGreaterThan(15);
    expect(e0).toBeLessThan(35);
    expect(sunElevation(city, sunDirection(10))).toBeLessThan(e0); // descending
    expect(Math.abs(sunElevation(city, sunDirection(timeAtHourAngle(93.5))))).toBeLessThan(3);
    expect(nightFactor(city, sunDirection(timeAtHourAngle(180)))).toBe(1);
    expect(nightFactor(city, sunDirection(0))).toBe(0);
  });
});
