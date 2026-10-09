// Space layer GLSL (v2, S1): the bodies (one program for the station and every satellite) and the
// lights (beacons + sunlit glints, one points draw).
//
// Per body the CPU writes seven vec4s into uBody (NB = number of bodies):
//   [0..2] rotation rows (local → world) with the world position in .w;
//   [3]    the sun-tracking axis (local) and the panels' angle about it;
//   [4]    x: sunlit (0 in the planet's shadow … 1), y: reveal start (lbRevealClock s), z: drawn
//          scale (0 = hidden; satellites are drawn SAT_SCALE up), w: the glint's fade (0 when the
//          body is big on screen, its mesh carries it).
//   [5]    xyz: the flight direction (unit, world: the trail runs back along the orbit from it),
//          w: the trail's fade (seen from space, gone once the body is big on screen).
//   [6]    x: the sky haze's weight for this body (1 when tiny, ~0.3 once it is big on screen: a
//          station passing over the street by day keeps its colours, not a washed-out ghost);
//          y: its beacons' gain (from space a boosted little satellite drops them: specks of colour
//          round a 10 px body read as a smear).
// Bodies: custom toon (the shared ramp texture, two-tone fill: earthshine from the planet side,
// deep indigo from space), rim, a hard toon glint on panels, foil and metal; solar cells, foil
// crinkle, warm windows (always a little, bright in shadow / at night), a shaded dish bowl, from the
// material id. Inked by the shader itself (post's depth ink barely reaches up here): curved
// silhouettes from the normal, and every face edge (boxes, panels, bands, rims, sail outlines) from
// the per-face edge coordinates (aEdge). Lights: additive points, no depth write, LAYER_NO_INK;
// the same draw carries each body's dotted trail back along its orbit (seen from space: a little
// satellite reads as a moving thing, not a speck).

import { LB_COMMON_GLSL } from '../render/toon';

const BODY_GLSL = /* glsl */ `
uniform vec4 uBody[NB * 7];
mat3 lbBodyRot(int b) {
  vec4 r0 = uBody[b];
  vec4 r1 = uBody[b + 1];
  vec4 r2 = uBody[b + 2];
  return mat3(r0.x, r1.x, r2.x, r0.y, r1.y, r2.y, r0.z, r1.z, r2.z);
}
vec3 lbBodyPos(int b) {
  return vec3(uBody[b].w, uBody[b + 1].w, uBody[b + 2].w);
}
vec3 lbTurn(vec3 v, vec3 a, float t) {
  float c = cos(t);
  float s = sin(t);
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}
`;

export const bodyVert = /* glsl */ `
${LB_COMMON_GLSL}
${BODY_GLSL}
uniform float uRevealDur;
attribute vec3 aCol;
attribute vec2 aUv;
attribute float aMat;
attribute float aBody;
attribute vec3 aEdge;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;
varying vec3 vLocal;
varying vec2 vUv;
varying vec3 vEdge;
varying float vMat;
varying float vLit;
varying float vHazeK;
varying float vReveal;
void main() {
  int b = int(aBody + 0.5) * 7;
  vec3 p = position;
  vec3 n = normal;
  float m = aMat;
  vec4 ax = uBody[b + 3];
  if (m > 15.5) {
    p = lbTurn(p, ax.xyz, ax.w);
    n = lbTurn(n, ax.xyz, ax.w);
    m -= 16.0;
  }
  vec4 ex = uBody[b + 4];
  float rp = clamp((lbRevealClock - ex.y) / max(uRevealDur, 1e-3), 0.0, 1.0);
  vReveal = rp;
  #ifndef LB_REVEAL_FADE
    p *= lbSpring(rp);
  #endif
  p *= ex.z;
  mat3 R = lbBodyRot(b);
  vec3 w = R * p + lbBodyPos(b);
  vW = w;
  vN = R * n;
  vLocal = position;
  vCol = aCol;
  vUv = aUv;
  vMat = m;
  vLit = ex.x;
  vEdge = aEdge;
  vHazeK = uBody[b + 6].x;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

export const bodyFrag = /* glsl */ `
${LB_COMMON_GLSL}
uniform sampler2D uRamp;
uniform vec3 uSun;
uniform vec3 uSpaceFill;
uniform vec3 uEarthFill;
uniform vec3 uWindow;
uniform vec4 uHaze;
uniform vec3 uShadowFill;
uniform vec3 uSkyFill;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;
varying vec3 vLocal;
varying vec2 vUv;
varying vec3 vEdge;
varying float vMat;
varying float vLit;
varying float vHazeK;
varying float vReveal;
float lbN3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 o = vec2(1.0, 0.0);
  float a = fract(sin(dot(i, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float b = fract(sin(dot(i + o.xyy, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float c = fract(sin(dot(i + o.yxy, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float d = fract(sin(dot(i + o.xxy, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float e = fract(sin(dot(i + o.yyx, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float g = fract(sin(dot(i + o.xyx, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float h = fract(sin(dot(i + o.yxx, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float k = fract(sin(dot(i + o.xxx, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
void main() {
  #ifdef LB_REVEAL_FADE
    if (vReveal < lbBayer4(gl_FragCoord.xy)) discard;
  #endif
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  vec3 up = normalize(vW);
  vec3 L = lbSunDir;
  float nl = dot(N, L);
  vec3 base = vCol;
  int m = int(vMat + 0.5);
  float specW = 0.0;
  vec3 emis = vec3(0.0);
  if (m == 1) {
    vec2 g = vUv / vec2(0.42, 0.5);
    vec2 f = abs(fract(g) - 0.5);
    vec2 fw = fwidth(g);
    float far = smoothstep(0.25, 0.6, max(fw.x, fw.y));
    float line = max(smoothstep(0.5 - fw.x * 1.5 - 0.06, 0.5 - 0.06 + fw.x * 0.5, f.x), smoothstep(0.5 - fw.y * 1.5 - 0.06, 0.5 - 0.06 + fw.y * 0.5, f.y));
    base = mix(base, min(base * 1.6 + 0.16, vec3(1.0)), 0.62 * (line * (1.0 - far) + 0.18 * far));
    base *= 0.92 + 0.16 * step(0.5, fract(floor(g.x) * 0.5 + floor(g.y) * 0.5));
    specW = 1.1;
  } else if (m == 2) {
    float c = lbN3(vLocal * 5.5) * 0.65 + lbN3(vLocal * 13.0) * 0.35;
    base *= 0.8 + 0.42 * c;
    specW = 0.9 * step(0.55, c);
  } else if (m == 3) {
    emis = uWindow * (0.35 + 0.9 * (1.0 - vLit * (1.0 - lbNightAt(vW))));
  } else if (m == 4) {
    specW = 1.3;
    emis = base * (0.14 + 0.16 * pow(1.0 - abs(dot(N, V)), 2.0));
  } else if (m == 5) {
    float s = pow(1.0 - abs(dot(N, V)), 2.0);
    base = mix(base, base.gbr * 0.6 + vec3(0.25, 0.2, 0.35), s * 0.45);
    specW = 0.7;
    emis = base * uSun * vLit * 0.32 * (1.0 - smoothstep(-0.4, 0.0, nl));
  } else if (m == 6) {
    specW = 1.0;
  } else if (m == 7) {
    // A dish: the bowl darkens toward its centre, with a thin ring and a bright lip, so it reads as
    // a bowl, not a flat white ellipse.
    float pv = vUv.y;
    base *= mix(0.68, 1.0, smoothstep(0.05, 0.8, pv));
    float fr = max(fwidth(pv), 1e-4);
    base *= 1.0 - 0.22 * (1.0 - smoothstep(fr * 0.8, fr * 1.8, abs(pv - 0.52)));
    base = mix(base, min(base * 1.15 + 0.06, vec3(1.0)), smoothstep(0.86, 0.95, pv));
    specW = 1.0;
  }
  float ramp = texture2D(uRamp, vec2(nl * 0.5 + 0.5, 0.5)).r;
  float lit = vLit;
  vec3 H = normalize(L + V);
  float sp = smoothstep(0.86, 0.9, pow(max(dot(N, H), 0.0), 24.0)) * specW;
  float hemi = dot(N, up) * 0.5 + 0.5;
  float earth = smoothstep(-0.25, 0.45, dot(up, L));
  vec3 fill = mix(uEarthFill * (0.3 + 0.7 * earth), uSpaceFill, hemi);
  // In the planet's shadow a flat cartoon fill keeps each part's colour (it went to a navy blob).
  fill = max(fill, uShadowFill * (1.0 - lit));
  // Seen from inside the air by day, the underside (all the street sees) is lit by the bright day
  // below: a soft warm fill, so the hull reads cream, not a blue-grey ghost in the blue sky.
  fill += uSkyFill * (1.0 - hemi);
  vec3 col = base * (uSun * ramp * lit + fill);
  col += uSun * sp * lit * 0.55;
  float nv = dot(N, V);
  float fr = pow(1.0 - clamp(nv, 0.0, 1.0), 3.0);
  // Rim: a cool edge light, stronger in shadow, so a dark body still has a shape against space.
  col += lbRimColor * fr * (0.3 * (0.35 + 0.65 * lit) + 0.5 * (1.0 - lit)) * (0.4 + 0.6 * base);
  col += emis;
  // Ink on the curved silhouettes (modules, tanks, dishes): a line ~1.5 px wide where the surface
  // turns away, in screen space (fwidth), so it holds at any distance. Flat faces have no normal
  // gradient and get none (post inks their outlines from depth). Post's own ink skips most of the
  // station: up here its crease damping is tripled for the clouds, and dark on dark space vanishes.
  float fwn = max(fwidth(nv), 1e-4);
  float ink = (1.0 - smoothstep(fwn * 1.2, fwn * 2.4, abs(nv))) * smoothstep(0.004, 0.02, fwn);
  // And every face edge (box edges, panel borders, band and cap rims, a dish's lip, a sail's
  // outline): ~1.2 px inside each face's border, so a shared edge carries a ~2 px line and a
  // silhouette edge ~1 px, like post's ink below. A face narrower than ~7 px across drops that
  // direction (a far body or a panel's thin side would go solid), except a dish's lip (flag 6),
  // which is a thin strip by design: it goes solid, a dark rim.
  if (vEdge.z > 0.5) {
    vec2 fwE = max(fwidth(vEdge.xy), vec2(1e-5));
    vec2 dE = min(vEdge.xy, 1.0 - vEdge.xy) / fwE;
    vec2 on = vec2(mod(vEdge.z, 2.0) > 0.5 ? 1.0 : 0.0, vEdge.z > 1.5 ? 1.0 : 0.0) * (vEdge.z > 5.5 ? vec2(1.0) : smoothstep(vec2(5.0), vec2(9.0), 1.0 / fwE));
    vec2 l = (1.0 - smoothstep(vec2(0.55), vec2(1.45), dE)) * on;
    ink = max(ink, max(l.x, l.y));
  }
  col = mix(col, lbInk, ink * 0.85);
  col = mix(col, uHaze.rgb, uHaze.a * vHazeK);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const lightVert = /* glsl */ `
${LB_COMMON_GLSL}
${BODY_GLSL}
uniform float uRevealDur;
uniform float uViewH;
uniform float uDark;
uniform float uTrail;
uniform float uTrailLen;
attribute float aBody;
attribute vec3 aCol;
attribute vec3 aMeta;
varying vec3 vC;
varying float vI;
varying float vGlint;
void main() {
  int b = int(aBody + 0.5) * 7;
  vec4 ex = uBody[b + 4];
  float rp = clamp((lbRevealClock - ex.y) / max(uRevealDur, 1e-3), 0.0, 1.0);
  float k = aMeta.x;
  vec3 w;
  vec4 tv = uBody[b + 5];
  if (k > 3.5) {
    // A trail dot: aMeta.y of the way back along the orbit (a circle about the planet's centre).
    vec3 bp = lbBodyPos(b);
    float r = length(bp);
    float a = -(0.06 + aMeta.y) * uTrailLen / r;
    w = bp * cos(a) + tv.xyz * (r * sin(a));
  } else {
    w = lbBodyRot(b) * (position * ex.z) + lbBodyPos(b);
    // A beacon is pulled a little toward the eye, so the hull it sits on never buries it.
    if (k < 2.5) w += normalize(cameraPosition - w) * (1.0 * ex.z);
  }
  vec4 mv = viewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mv;
  float t = lbTime + aMeta.y;
  float on;
  vGlint = 0.0;
  // Sharp on/off blinks, each well inside a second so any second of footage shows one: nav lights
  // on 55 % of a 1 s beat (red and green half a beat apart: they alternate), a 0.14 s strobe every
  // 0.9 s, a double strobe every 1.1 s.
  if (k < 0.5) {
    float s = fract(t);
    on = smoothstep(0.0, 0.03, s) * (1.0 - smoothstep(0.55, 0.58, s));
  } else if (k < 1.5) {
    float s = fract(t / 0.9);
    on = smoothstep(0.0, 0.02, s) * (1.0 - smoothstep(0.13, 0.155, s));
  } else if (k < 2.5) {
    float s = fract(t / 1.1);
    on = smoothstep(0.0, 0.015, s) * (1.0 - smoothstep(0.07, 0.09, s)) + smoothstep(0.2, 0.215, s) * (1.0 - smoothstep(0.27, 0.29, s));
  } else if (k < 3.5) {
    on = ex.x * ex.w * uDark;
    vGlint = 1.0;
  } else {
    on = tv.w * uTrail * pow(1.0 - aMeta.y, 1.2) * (0.45 + 0.55 * ex.x) * 1.1;
    vGlint = 1.0;
  }
  on *= step(0.001, ex.z) * rp;
  vI = k < 2.5 ? on * mix(0.5, 1.25, uDark) * uBody[b + 6].y : on;
  vC = aCol;
  float px = aMeta.z * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 0.1);
  // A beacon is never under ~12 px (a 4–5 px coloured core and its halo): it must read from the
  // street at night, against a sunlit hull.
  float lo = k < 2.5 ? 12.0 : k < 3.5 ? 2.2 : 2.6;
  float hi = k < 2.5 ? 20.0 : k < 3.5 ? 5.0 : 4.2;
  gl_PointSize = vI > 0.004 ? clamp(px, lo, hi) : 0.0;
}`;

export const lightFrag = /* glsl */ `
varying vec3 vC;
varying float vI;
varying float vGlint;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 7.0);
  float halo = exp(-r2 * 2.5) * (1.0 - r2);
  float cross = vGlint > 0.5 ? 0.0 : max(exp(-abs(c.x) * 18.0) * exp(-c.y * c.y * 3.0), exp(-abs(c.y) * 18.0) * exp(-c.x * c.x * 3.0)) * 0.5;
  // Beacons: a saturated core (not so hot that the tone map bleaches it white) and a soft halo of
  // their own, not left to the bloom; glints and trail dots stay white-hot specks.
  vec3 c3 = vGlint > 0.5 ? vC * (core * 2.0 + halo * 0.6 + cross) + core * 0.5 : vC * (core * 2.3 + halo * 1.6 + cross) + core * 0.24;
  gl_FragColor = vec4(c3 * vI, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
