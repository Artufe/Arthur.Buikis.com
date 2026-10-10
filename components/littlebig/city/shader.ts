// The city's toon patch: one program for every static city surface. The reveal pivots on aBase
// (buildings grow up out of their plots, each at its own pace, aGrow) — or, on the ground material
// (uCityGround = 1), every vertex rises out of the plateau on its own delay, so the streets roll in
// as a smooth wave. The fragment side draws the procedural detail from aInfo = (u, v, kind, param):
//   facade   window grids in bay/floor units (u = bays, v = floors; param = style·1024 + seed). The
//            glass is RECESSED: the window is ray-cast into the wall (parallax from the fragment's
//            own tangent frame), so at street level you see the reveals — a lit sill, a shaded
//            lintel soffit, a jamb bright on the sun side and dark on the other — and the glass
//            slides behind them as you move. Shopfronts get mullions and transoms. Windows glow at
//            night (a seeded share, most of the houses, every shop), and stay bright from orbit;
//   sidewalk slab joints; tiles: plaza stone (param 0), warm lot setts (1), market cobbles (2);
//   asphalt speckle; roof gravel (0) or tile courses (1); lawn stripes; leaf (hedges: blotchy
//   foliage); water ripples; glow (night lamps, param = strength, negative = blinking aviation
//   light); clock (a face whose hands show the sun's time at the city: t = 0 is about 4:15 pm).
// Patterns fade to their average colour as they shrink below a few pixels (fwidth), so nothing
// shimmers from orbit.
//
// Night: each lit window is its own room (hash: 60 % warm amber, 25 % soft yellow, 10 % TV-blue,
// 5 % dimmed; brightness 0.6–1, darker toward the ceiling; 12 % a blind over the top, 10 %
// curtains at the sides — pale fabric by day); the lit share drops ×0.8 late at night (uCityLate,
// shops ×0.85). From afar a facade keeps a dim warm wash (×0.75, up to ×1.15 above 150–300 m) —
// the window sparks (pools.ts) carry the lit windows. Water at night is a dark moonlit navy
// (#1c2a5a) with ripples and the odd twinkling moon glint. From high up (110–230 m) the streets
// glow as warm strands: brightest down the carriageway's middle and fading to the curbs (asphalt
// param = half width), soft knots at the junctions (param = −reach, uv from the node), the glow
// showing through the road paint (param 7); the lamp pools take over below.
// The reveals of a recessed window: lintel soffit (looking up), sill (lit from above), jambs (by
// the sun). GLSL strings carry no comments (they ship in the bundle): the notes live here.

import type { ToonPatch } from '../render/toon';
import { DAY_LENGTH, START_HOUR_ANGLE } from '../world/config';

export const CITY_PATCH_KEY = 'city-v2';

const f1 = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/**
 * The shared patch; `ground` selects the ground material's rise-up reveal (a uniform: one program).
 * `late` (shared by every city material): how late in the night it is over the city (0..1), which
 * dims the share of lit windows.
 */
export function cityPatch(ground: boolean, late: { value: number } = { value: 0 }): ToonPatch {
  return {
    key: CITY_PATCH_KEY,
    uniforms: { uCityGround: { value: ground ? 1 : 0 }, uCityLate: late },
    vertexPars: /* glsl */ `
attribute vec3 aBase;
attribute vec4 aInfo;
attribute float aGrow;
uniform float uCityGround;
varying vec4 vInfo;
`,
    vertex: /* glsl */ `
vInfo = aInfo;
#if defined(LB_REVEAL_INSTANCE) && !defined(LB_REVEAL_FADE)
{
  float lbP2 = clamp((lbRevealClock - aReveal) / max(lbRevealDur * aGrow, 1e-3), 0.0, 1.0);
  vLbReveal = lbP2;
  float lbS = lbSpring(lbP2);
  if (uCityGround > 0.5) {
    transformed = position - normalize(position) * (1.0 - lbS) * 0.7;
  } else {
    vec3 lbUp = normalize(aBase);
    vec3 lbD = position - aBase;
    float lbH = dot(lbD, lbUp);
    vec3 lbLat = lbD - lbUp * lbH;
    transformed = aBase + lbLat * (0.4 + 0.6 * lbS) * min(1.0, lbP2 * 10.0) + lbUp * lbH * lbS;
  }
}
#endif
`,
    fragmentPars: /* glsl */ `
varying vec4 vInfo;
uniform float uCityLate;
float cityHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float cityNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cityHash(i), cityHash(i + vec2(1.0, 0.0)), f.x), mix(cityHash(i + vec2(0.0, 1.0)), cityHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float cityBox(vec2 f, vec4 r, vec2 fw) {
  vec2 a = smoothstep(r.xz - fw, r.xz + fw, f);
  vec2 b = 1.0 - smoothstep(r.yw - fw, r.yw + fw, f);
  return a.x * a.y * b.x * b.y;
}
float cityLine(float x, float w, float fw) {
  return 1.0 - smoothstep(w, w + fw * 1.5, abs(x));
}
`,
    fragment: /* glsl */ `
{
  float kind = floor(vInfo.z + 0.5);
  vec2 uv = vInfo.xy;
  vec3 base = max(diffuseColor.rgb, vec3(0.02));
  vec3 lightIn = outgoingLight / base;
  float nightK = lbNightAt(vLbWorld);
  vec2 fw = fwidth(uv);
  float fwm = max(fw.x, fw.y);
  if (kind > 0.5 && kind < 1.5) {
    float style = floor(vInfo.w / 1024.0 + 0.001);
    float seed = mod(vInfo.w, 1024.0);
    vec2 cell = floor(uv);
    vec2 f = fract(uv);
    vec4 win = vec4(0.26, 0.74, 0.3, 0.8);
    float depth = 0.15;
    if (style > 0.5 && style < 1.5) { win = vec4(0.07, 0.93, 0.12, 0.92); depth = 0.05; }
    else if (style > 1.5 && style < 2.5) { win = vec4(-0.01, 1.01, 0.34, 0.82); depth = 0.09; }
    else if (style > 2.5 && style < 3.5) { win = vec4(0.32, 0.68, 0.3, 0.78); depth = 0.13; }
    else if (style > 3.5 && style < 4.5) { win = vec4(0.06, 0.94, 0.06, 0.8); depth = 0.12; }
    else if (style > 5.5 && style < 6.5) { win = vec4(0.18, 0.82, 0.0, 0.72); depth = 0.3; }
    else if (style > 6.5) { win = vec4(0.3, 0.7, 0.32, 0.76); depth = 0.14; }
    float present = 1.0;
    if (style > 6.5) present = step(cityHash(cell * vec2(2.3, 5.1) + seed * 0.13), 0.42);
    float detail = 1.0 - smoothstep(0.18, 0.4, fwm);
    float cover = (win.y - win.x) * (win.w - win.z) * (style > 6.5 ? 0.42 : 1.0);
    float share = style > 3.5 && style < 4.5 ? 1.0 : style > 2.5 && style < 3.5 ? 0.72 : style > 5.5 && style < 6.5 ? 0.0 : 0.56;
    vec3 warmAvg = vec3(1.0, 0.55, 0.22);
    vec3 glassAvg = vec3(0.12, 0.2, 0.3) * (0.35 + 0.65 * lightIn) * (1.0 - 0.6 * nightK);
    float lateK = 1.0 - 0.2 * uCityLate;
    vec3 avg = mix(outgoingLight, glassAvg, cover * 0.8) + warmAvg * share * cover * nightK * lateK * mix(0.75, 1.15, smoothstep(150.0, 300.0, lbCamAlt));
    if (detail < 0.01) {
      outgoingLight = avg;
    } else {
      vec3 pos = -vViewPosition;
      vec3 dpx = dFdx(pos);
      vec3 dpy = dFdy(pos);
      vec2 dux = dFdx(uv);
      vec2 duy = dFdy(uv);
      float det = dux.x * duy.y - dux.y * duy.x;
      vec2 g = f;
      vec3 Tu = vec3(1.0, 0.0, 0.0);
      if (abs(det) > 1e-14) {
        Tu = (dpx * duy.y - dpy * dux.y) / det;
        vec3 Tv = (dpy * dux.x - dpx * duy.x) / det;
        vec3 N = normal;
        vec3 D = normalize(pos);
        float dn = min(dot(D, N), -0.08);
        vec3 O = D * (depth / -dn) + N * depth;
        g = f + clamp(vec2(dot(O, Tu) / max(dot(Tu, Tu), 1e-6), dot(O, Tv) / max(dot(Tv, Tv), 1e-6)), vec2(-0.6), vec2(0.6));
      }
      float m = cityBox(f, win, fw) * present;
      if (style > 5.5 && style < 6.5) {
        float r = (win.y - win.x) * 0.5;
        vec2 c = vec2(0.5, win.w - r);
        float arc = 1.0 - smoothstep(r - fw.x, r + fw.x, length(f - c));
        m = clamp(cityBox(f, vec4(win.x, win.y, win.z, c.y + 0.03 + 2.0 * fw.y), fw) + arc * step(c.y, f.y), 0.0, 1.0) * present;
      }
      float gm = cityBox(g, win, fw);
      if (style > 5.5 && style < 6.5) {
        float r = (win.y - win.x) * 0.5;
        vec2 c = vec2(0.5, win.w - r);
        float arc = 1.0 - smoothstep(r - fw.x, r + fw.x, length(g - c));
        gm = clamp(cityBox(g, vec4(win.x, win.y, win.z, c.y + 0.03 + 2.0 * fw.y), fw) + arc * step(c.y, g.y), 0.0, 1.0);
      }
      float frame = cityBox(f, win + vec4(-0.05, 0.05, -0.05, 0.04), fw) * present - m;
      float sill = cityBox(f, vec4(win.x - 0.06, win.y + 0.06, win.z - 0.1, win.z - 0.03), fw) * present;
      float shut = 0.0;
      if (style > 2.5 && style < 3.5) shut = cityBox(f, vec4(0.17, 0.3, 0.3, 0.78), fw) + cityBox(f, vec4(0.7, 0.83, 0.3, 0.78), fw);
      float wy = clamp((g.y - win.z) / max(win.w - win.z, 0.01), 0.0, 1.0);
      vec3 glass = vec3(0.06, 0.11, 0.17) + vec3(0.16, 0.26, 0.36) * wy;
      float glint = smoothstep(0.9, 1.0, sin((g.x + g.y * 0.7 + cityHash(cell + seed) * 0.3) * 6.0) * 0.5 + 0.5);
      glass += vec3(0.25, 0.3, 0.32) * glint * 0.35;
      glass *= 1.0 - smoothstep(0.8, 1.0, wy) * 0.5;
      vec3 glassLit = glass * (0.35 + 0.65 * lightIn) * (1.0 - 0.6 * nightK);
      float mull = 0.0;
      if (style > 3.5 && style < 4.5) mull = max(cityLine(g.x - 0.5, 0.018, fw.x), cityLine(wy - 0.74, 0.025, fw.y));
      else if (style > 1.5 && style < 2.5) mull = cityLine(g.x - 0.5, 0.012, fw.x);
      else if (style > 0.5 && style < 1.5) mull = cityLine(g.y - 0.52, 0.02, fw.y) * 0.8;
      else if (style < 0.5 || style > 6.5) mull = cityLine(g.x - 0.5, 0.02, fw.x) * step(0.62, wy) + cityLine(wy - 0.62, 0.025, fw.y);
      float h = cityHash(cell * vec2(1.7, 3.1) + seed * 0.37);
      float hc = cityHash(cell + seed);
      vec3 warm = hc < 0.6 ? mix(vec3(1.0, 0.42, 0.13), vec3(1.0, 0.56, 0.22), hc / 0.6)
        : hc < 0.85 ? vec3(1.0, 0.78, 0.42)
        : hc < 0.95 ? vec3(0.42, 0.6, 1.0) * 0.8
        : vec3(1.0, 0.5, 0.2) * 0.35;
      float inside = (0.6 + 0.4 * cityHash(cell.yx + seed)) * mix(1.0, 0.5, smoothstep(0.3, 1.0, wy));
      float drape = 0.0;
      if (style < 3.5 || style > 6.5) {
        float hb = cityHash(cell * vec2(4.1, 2.7) + seed * 0.71);
        float gx = clamp((g.x - win.x) / max(win.y - win.x, 0.01), 0.0, 1.0);
        if (hb < 0.12) drape = smoothstep(mix(0.4, 0.8, fract(hb * 37.0)) - 0.02, mix(0.4, 0.8, fract(hb * 37.0)), wy);
        else if (hb < 0.22) drape = 1.0 - smoothstep(0.17, 0.2, gx) * (1.0 - smoothstep(0.8, 0.83, gx));
      }
      if (style > 3.5 && style < 4.5) { warm = mix(vec3(1.0, 0.5, 0.2), vec3(1.0, 0.72, 0.4), hc); inside = (0.5 + 0.6 * wy) * (1.0 - 0.4 * smoothstep(0.0, 0.02, 0.2 - wy)); }
      if (style > 5.5 && style < 6.5) glassLit = vec3(0.05, 0.045, 0.07) * (0.6 + 0.4 * lightIn);
      glassLit = mix(glassLit, vec3(0.62, 0.55, 0.46) * (0.3 + 0.45 * lightIn) * (1.0 - 0.75 * nightK), drape);
      float lit = step(h, share * (style > 3.5 && style < 4.5 ? 1.0 - 0.15 * uCityLate : 1.0 - 0.2 * uCityLate));
      vec3 glow = warm * lit * inside * nightK * 1.15 * (1.0 - 0.7 * drape);
      vec3 sunV = normalize((viewMatrix * vec4(lbSunDir, 0.0)).xyz);
      vec3 tU = normalize(Tu);
      float day = 1.0 - nightK;
      float overL = win.x - g.x, overR = g.x - win.y, overT = g.y - win.w, overB = win.z - g.y;
      float o = max(max(overL, overR), max(overT, overB));
      vec3 reveal = outgoingLight * 0.8;
      if (o == overT) reveal = outgoingLight * 0.5;
      else if (o == overB) reveal = outgoingLight * 1.12 + vec3(0.02);
      else {
        vec3 nj = o == overL ? tU : -tU;
        reveal = outgoingLight * (0.58 + 0.5 * max(dot(nj, sunV), 0.0) * day);
      }
      vec3 inner = mix(reveal, glassLit + glow, gm);
      inner = mix(inner, outgoingLight * 1.3 + vec3(0.02), mull * gm);
      vec3 frameC = outgoingLight * 1.32 + vec3(0.02);
      vec3 fac = outgoingLight;
      fac = mix(fac, outgoingLight * 1.22 + vec3(0.03), sill * (1.0 - m));
      fac = mix(fac, frameC, clamp(frame, 0.0, 1.0));
      fac = mix(fac, outgoingLight * 0.55, clamp(shut, 0.0, 1.0));
      fac = mix(fac, inner, m);
      outgoingLight = mix(avg, fac, detail);
    }
  } else if (kind > 1.5 && kind < 2.5) {
    vec2 g = uv / vec2(1.2, 0.9);
    vec2 f = fract(g);
    float j = 1.0 - smoothstep(0.0, 1.5 * max(fwidth(g).x, fwidth(g).y) + 0.03, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
    float tint = cityHash(floor(g)) - 0.5;
    float detail = 1.0 - smoothstep(0.15, 0.45, max(fwidth(g).x, fwidth(g).y));
    outgoingLight *= 1.0 + detail * (tint * 0.07 - j * 0.16);
    outgoingLight += vec3(1.0, 0.5, 0.16) * nightK * smoothstep(110.0, 230.0, lbCamAlt) * 0.025;
  } else if (kind > 2.5 && kind < 3.5) {
    float pk = vInfo.w;
    vec2 g = pk > 0.5 ? uv / vec2(0.9, 0.6) : uv / 1.3;
    if (pk > 1.5) g = uv / 0.45;
    float row = floor(g.y);
    if (pk > 0.5) g.x += mod(row, 2.0) * 0.5;
    vec2 f = fract(g);
    vec2 c = floor(g);
    float fwg = max(fwidth(g).x, fwidth(g).y);
    float j = 1.0 - smoothstep(0.0, 1.5 * fwg + 0.03, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
    float detail = 1.0 - smoothstep(0.12, 0.4, fwg);
    float far = 1.0 - smoothstep(0.02, 0.12, fwg);
    if (pk < 0.5) {
      float chk = mod(c.x + c.y, 2.0);
      float band = step(mod(c.x, 6.0), 0.5) + step(mod(c.y, 6.0), 0.5);
      outgoingLight *= 1.0 + detail * ((cityHash(c) - 0.5) * 0.06 + chk * 0.05 - j * 0.12) - min(band, 1.0) * 0.07 * (detail + far * 0.5);
    } else {
      float mott = cityNoise(uv * 0.35) - 0.5;
      outgoingLight *= 1.0 + detail * ((cityHash(c) - 0.5) * 0.14 - j * 0.2) + mott * 0.08;
    }
  } else if (kind > 3.5 && kind < 4.5) {
    if (vInfo.w > 0.5) {
      vec2 g = vec2(uv.x / 0.45, uv.y / 0.34);
      float row = floor(g.y);
      vec2 f = fract(vec2(g.x + mod(row, 2.0) * 0.5, g.y));
      float fwg = max(fwidth(g).x, fwidth(g).y);
      float detail = 1.0 - smoothstep(0.2, 0.5, fwg);
      float course = smoothstep(0.55, 1.0, f.y);
      float joint = 1.0 - smoothstep(0.0, 0.06 + fwg, min(f.x, 1.0 - f.x));
      outgoingLight *= 1.0 + detail * (0.08 - course * 0.22 - joint * 0.08 + (cityHash(floor(vec2(g.x + mod(row, 2.0) * 0.5, row))) - 0.5) * 0.08);
    } else {
      float detail = 1.0 - smoothstep(0.1, 0.4, fwm);
      if (detail > 0.01) {
        float n = cityNoise(uv * 2.3) * 0.6 + cityHash(floor(uv * 7.0)) * 0.4;
        outgoingLight *= 1.0 + (n - 0.5) * 0.14 * detail;
      }
    }
  } else if (kind > 4.5 && kind < 5.5) {
    float detail = 1.0 - smoothstep(0.08, 0.3, fwm);
    if (detail > 0.01) {
      float n = cityNoise(uv * 1.7) * 0.7 + cityHash(floor(uv * 9.0)) * 0.3;
      outgoingLight *= 1.0 + (n - 0.5) * 0.16 * detail;
    }
    float across = vInfo.w > 0.0 ? abs(uv.y) / vInfo.w : length(uv) / max(-vInfo.w, 1.0);
    float strand = 0.05 + exp(-5.0 * across * across) * (vInfo.w > 0.0 ? 1.0 : 0.85);
    outgoingLight += vec3(1.0, 0.5, 0.16) * nightK * smoothstep(110.0, 230.0, lbCamAlt) * strand * mix(0.2, 0.3, smoothstep(230.0, 400.0, lbCamAlt));
  } else if (kind > 5.5 && kind < 6.5) {
    float s = step(0.5, fract(uv.x / 2.4));
    float n = cityNoise(uv * 1.3);
    float detail = 1.0 - smoothstep(0.25, 0.8, fwm / 2.4);
    outgoingLight *= 1.0 + (s - 0.5) * 0.09 * detail + (n - 0.5) * 0.08;
  } else if (kind > 6.5 && kind < 7.5) {
    float t = lbTime;
    float w1 = sin(uv.x * 1.9 + uv.y * 0.7 + t * 1.3);
    float w2 = sin(uv.x * -0.8 + uv.y * 2.3 + t * 0.9);
    float w = w1 * 0.5 + w2 * 0.5;
    vec3 deep = vec3(0.05, 0.32, 0.55);
    vec3 shallow = vec3(0.2, 0.7, 0.78);
    vec3 water = mix(deep, shallow, 0.45 + 0.25 * w);
    float crest = smoothstep(0.82, 0.98, w);
    vec3 dayW = water * (0.45 + 0.55 * lightIn) + crest * vec3(0.7, 0.8, 0.8) * 0.5;
    vec3 moonW = vec3(0.0116, 0.0232, 0.1022) * (0.75 + 0.35 * w);
    float tw = step(0.93, cityHash(floor(uv * 2.5) + floor(t * 1.7 + cityHash(floor(uv * 2.5)) * 3.0) * 0.37));
    moonW += vec3(0.5, 0.6, 0.85) * crest * tw * 0.35 * (1.0 - smoothstep(0.1, 0.4, fwm));
    outgoingLight = mix(dayW, moonW, nightK);
  } else if (kind > 7.5 && kind < 8.5) {
    float strength = abs(vInfo.w);
    float on = nightK;
    if (vInfo.w < 0.0) on = max(0.35, nightK) * step(0.55, fract(lbTime * 0.8 + vInfo.x));
    outgoingLight = mix(outgoingLight, diffuseColor.rgb * strength, on);
  } else if (kind > 8.5 && kind < 9.5) {
    float r = length(uv);
    float a = atan(uv.x, uv.y);
    float fwr = fwidth(r) + 0.01;
    float rim = smoothstep(0.82 - fwr, 0.82, r);
    float ticks = (1.0 - smoothstep(0.0, 0.05 + fwr, abs(fract(a / 6.2831853 * 12.0 + 0.5) - 0.5) * 0.5)) * step(0.62, r) * step(r, 0.8);
    float hours = 12.0 + (${f1(START_HOUR_ANGLE)} + lbTime * ${f1(360 / DAY_LENGTH)}) / 15.0;
    float hrs = hours / 12.0 * 6.2831853;
    float mins = fract(hours) * 6.2831853;
    vec2 hd = vec2(sin(hrs), cos(hrs));
    vec2 md = vec2(sin(mins), cos(mins));
    float hh = (1.0 - smoothstep(0.045, 0.045 + fwr, abs(dot(uv, vec2(hd.y, -hd.x))))) * step(-0.08, dot(uv, hd)) * step(dot(uv, hd), 0.45);
    float mh = (1.0 - smoothstep(0.03, 0.03 + fwr, abs(dot(uv, vec2(md.y, -md.x))))) * step(-0.08, dot(uv, md)) * step(dot(uv, md), 0.7);
    float hub = 1.0 - smoothstep(0.07, 0.07 + fwr, r);
    float ink = max(max(rim, ticks), max(max(hh, mh), hub));
    vec3 face = mix(vec3(0.97, 0.94, 0.86), vec3(0.15, 0.12, 0.22), ink);
    vec3 lit = face * (0.4 + 0.6 * lightIn);
    outgoingLight = lit + vec3(1.0, 0.8, 0.45) * nightK * 0.9 * (1.0 - ink);
  } else if (kind < 0.5 && abs(vInfo.w - 7.0) < 0.5) {
    outgoingLight += vec3(1.0, 0.5, 0.16) * nightK * smoothstep(110.0, 230.0, lbCamAlt) * mix(0.14, 0.21, smoothstep(230.0, 400.0, lbCamAlt));
  } else if (kind > 9.5 && kind < 10.5) {
    float n = cityNoise(uv * 1.6 + vInfo.w) * 0.55 + cityNoise(uv * 4.1 - vInfo.w) * 0.45;
    float detail = 1.0 - smoothstep(0.3, 1.2, fwm);
    float clumps = smoothstep(0.35, 0.75, n);
    outgoingLight *= mix(1.0, 0.72 + 0.5 * clumps, detail) * mix(0.78, 1.0, smoothstep(0.0, 0.6, uv.y + 0.3));
  }
}
`,
  };
}

// ── CPU twin of the facade's window layout (pools.ts puts a night spark on every lit window) ──

/** Window rect per facade style (u0, u1, v0, v1 inside a bay × floor cell): keep in sync with the GLSL above. */
const WIN: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.26, 0.74, 0.3, 0.8], // punched
  [0.07, 0.93, 0.12, 0.92], // curtain
  [-0.01, 1.01, 0.34, 0.82], // ribbon
  [0.32, 0.68, 0.3, 0.78], // house
  [0.06, 0.94, 0.06, 0.8], // shop
  [0.26, 0.74, 0.3, 0.8], // plain
  [0.18, 0.82, 0.0, 0.72], // arcade (never lit)
  [0.3, 0.7, 0.32, 0.76], // sparse
];
/** Share of lit windows at night per style (the GLSL `share`). */
const SHARE = [0.56, 0.56, 0.56, 0.72, 1.0, 0.56, 0.0, 0.56];

const f32 = Math.fround;
const fract32 = (x: number) => f32(x - Math.floor(x));
/** a·b + c·d in float32 steps, as the GPU evaluates `cell * vec2(..) + seed * ..`. */
const mad = (a: number, b: number, c: number, d: number) => f32(f32(a * f32(b)) + f32(f32(c) * f32(d)));
/** cityHash() in float32 steps (a GPU may still disagree on the odd window; sparks only show far off). */
export function cityHash32(px: number, py: number): number {
  let x = fract32(f32(f32(px) * f32(123.34)));
  let y = fract32(f32(f32(py) * f32(456.21)));
  const k = f32(45.32);
  const d = f32(f32(x * f32(x + k)) + f32(y * f32(y + k)));
  x = f32(x + d);
  y = f32(y + d);
  return fract32(f32(x * y));
}

/** A lit window's light (linear rgb × brightness), as the facade shader picks it from its hashes. */
export interface WindowLight {
  r: number;
  g: number;
  b: number;
  /** Its lit hash over the style's share (0..1): late at night windows above 1 − 0.2·late go dark. */
  lit: number;
}

const _wl: WindowLight = { r: 0, g: 0, b: 0, lit: 0 };

/** The GLSL `warm` pick by hc (keep in sync). */
function windowColour(hc: number, out: WindowLight): void {
  if (hc < 0.6) {
    const t = hc / 0.6;
    out.r = 1;
    out.g = 0.42 + 0.14 * t;
    out.b = 0.13 + 0.09 * t;
  } else if (hc < 0.85) {
    out.r = 1;
    out.g = 0.78;
    out.b = 0.42;
  } else if (hc < 0.95) {
    out.r = 0.34;
    out.g = 0.48;
    out.b = 0.8;
  } else {
    out.r = 0.35;
    out.g = 0.175;
    out.b = 0.07;
  }
}

/**
 * Visit every window of the recorded facade quads (Geo.facades, 24 numbers each) that the facade
 * shader lights at night: its centre on the wall (world), the wall's unit normal, the bay width and
 * floor height (m), the window's width (m) and its light (reused object: copy what you keep).
 */
export function facadeWindows(
  q: ArrayLike<number>,
  fn: (x: number, y: number, z: number, nx: number, ny: number, nz: number, bay: number, floor: number, winW: number, light: WindowLight) => void,
): void {
  for (let o = 0; o + 24 <= q.length; o += 24) {
    const param = q[o + 18];
    const style = Math.floor(param / 1024 + 0.001);
    const seed = param - style * 1024;
    const share = SHARE[style] ?? 0;
    if (share <= 0) continue;
    const win = WIN[style] ?? WIN[0];
    const ua = q[o + 9], va = q[o + 10], ub = q[o + 11], vb = q[o + 12], uc = q[o + 13], vc = q[o + 14];
    const du1 = ub - ua, dv1 = vb - va, du2 = uc - ua, dv2 = vc - va;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-9) continue;
    const e1x = q[o + 3] - q[o], e1y = q[o + 4] - q[o + 1], e1z = q[o + 5] - q[o + 2];
    const e2x = q[o + 6] - q[o], e2y = q[o + 7] - q[o + 1], e2z = q[o + 8] - q[o + 2];
    // P(u, v) = P0 + A (u − ua) + B (v − va)
    const ax = (e1x * dv2 - e2x * dv1) / det, ay = (e1y * dv2 - e2y * dv1) / det, az = (e1z * dv2 - e2z * dv1) / det;
    const bx = (e2x * du1 - e1x * du2) / det, by = (e2y * du1 - e1y * du2) / det, bz = (e2z * du1 - e1z * du2) / det;
    const bay = Math.hypot(ax, ay, az);
    const floor = Math.hypot(bx, by, bz);
    const u0 = q[o + 19], u1 = q[o + 20], v0 = q[o + 21], v1 = q[o + 22];
    const cu = (win[0] + win[1]) / 2;
    const cv = (win[2] + win[3]) / 2;
    for (let i = Math.ceil(u0 - 1e-4); i + 1 <= u1 + 1e-4; i++) {
      for (let k = Math.max(0, Math.ceil(v0 - 1e-4)); k + 1 <= v1 + 1e-4; k++) {
        if (style === 7 && cityHash32(mad(i, 2.3, seed, 0.13), mad(k, 5.1, seed, 0.13)) > 0.42) continue;
        const h = cityHash32(mad(i, 1.7, seed, 0.37), mad(k, 3.1, seed, 0.37));
        if (h > share) continue;
        const hc = cityHash32(f32(i + seed), f32(k + seed));
        let kb = 0.6 + 0.4 * cityHash32(f32(k + seed), f32(i + seed));
        if (style === 4) {
          _wl.r = 1;
          _wl.g = 0.5 + 0.22 * hc;
          _wl.b = 0.2 + 0.2 * hc;
          kb = 0.85;
        } else {
          windowColour(hc, _wl);
          if (style < 4 || style > 6) {
            // a blind or curtains cover part of it
            if (cityHash32(mad(i, 4.1, seed, 0.71), mad(k, 2.7, seed, 0.71)) < 0.22) kb *= 0.72;
          }
        }
        _wl.r *= kb;
        _wl.g *= kb;
        _wl.b *= kb;
        _wl.lit = h / share;
        const du = i + cu - ua;
        const dv = k + cv - va;
        fn(q[o] + ax * du + bx * dv, q[o + 1] + ay * du + by * dv, q[o + 2] + az * du + bz * dv, q[o + 15], q[o + 16], q[o + 17], bay, floor, (win[1] - win[0]) * bay, _wl);
      }
    }
  }
}
