// Air shaders (B3): the toon-kit patch for planes and balloons (paint, the air's own light, night
// windows, burner glow), the contrail ribbons (evaluated from the routes on the GPU) and the nav
// lights / burner flames (additive points).

import { LB_COMMON_GLSL, type ToonPatch } from '../render/toon';
import { R } from '../world/config';

export const NP = 4;

const R_GLSL = `const float AIR_R = ${R.toFixed(1)};`;

/** Burner bursts: ~1.6 s of flame every 7 s, flickering; phase per balloon. */
const BURST_GLSL = /* glsl */ `
float airBurst(float t, float ph) {
  float s = fract(t / 7.0 + ph);
  return smoothstep(0.0, 0.025, s) * (1.0 - smoothstep(0.17, 0.235, s)) * (0.8 + 0.2 * sin(t * 41.0 + ph * 60.0));
}
`;

/**
 * Time of day for things in the air, as a sun elevation sine `e`, shared by planes, balloons, their
 * lights and the contrails so all four always agree.
 *   - Up here the sun lingers ~10° past the ground's terminator (airLitE), not the geometric 45° a
 *     65 m height gives on this planet, which hung sunlit contrails like searchlights across the
 *     night side.
 *   - Inside the air (uAirEye.y → 0) a thing is never more than one palette step (0.07) darker than
 *     the eye's own (dip-aware) sky, and takes the eye's exactly within 60 m, A3's rule for clouds:
 *     on a 160 m planet a plane 100 m away is ~36° further into the night and hung as a black
 *     cut-out in a blue sky. From orbit each takes its own.
 */
const AIR_SUN_GLSL = /* glsl */ `
uniform vec2 uAirEye;
float airSunE(vec3 p) {
  float e = dot(normalize(p), lbSunDir);
  float far = mix(max(e, uAirEye.x - 0.07), e, uAirEye.y);
  return mix(uAirEye.x, far, max(uAirEye.y, smoothstep(60.0, 200.0, distance(p, cameraPosition))));
}
float airLitE(float e) { return smoothstep(-0.3, -0.1, e); }
float airNightE(float e) { return 1.0 - smoothstep(-0.18, 0.12, e); }
`;

/**
 * Planes and balloons (one toon program). GLSL carries no comments (they would ship); the notes:
 *   - Paint by aPaint.y (geometry.ts): balloon gores A/B with a cream band and an A crown; the
 *     fuselage's window row (navy glass by day, warm at night), livery cheatline, a wrap-around
 *     windscreen visor (a band between two elevations seen from a point inside the nose, so it wraps
 *     across the front: the toy's face; posts split it into panes) and a livery belly stripe (what
 *     identifies the plane from the street); fin and winglets in livery A with logo lights washing
 *     the fin at night; nacelles in livery B; the engine fan (a grey disc, 8 dark twisted blades;
 *     a dark intake with a hub dot read as a car tyre); wings with a livery flash on the underside
 *     root. Patterns are fwidth-antialiased and average out under a couple of pixels.
 *   - Light: the kit lit the fragment by the ground's time of day; up here it is the air's (eA,
 *     airSunE). The kit's fill is swapped for the air's, where down-facing surfaces trade most of
 *     the warm ground bounce (it turned the white underside salmon-brown 60 m up) for a cool sky
 *     fill. Past the air's terminator direct light is removed; short of it, where the kit had put
 *     the sun out (its cut follows the ground), the key light returns through the same toon ramp.
 *   - aGlow ≥ 0: lit by the burner from inside (a steady lantern at night, brighter in a burst);
 *     aGlow < 0: by bursts only (ropes, basket rim, the burner can). aLivB.w = 1 on balloons. From
 *     orbit only a dim steady glow remains (a burst read as a fireball strobing over the city).
 *   - At night: liveries 50 % toward their luminance (amber went mud-brown under the moon), and a
 *     faint moonlit rim so the silhouette separates from the night sky seen from below.
 */
export const AIR_PATCH: ToonPatch = {
  key: 'air-v2',
  vertexPars: /* glsl */ `
attribute vec3 aPaint;
attribute float aGlow;
attribute vec4 aLivA;
attribute vec4 aLivB;
varying vec3 vAirPaint;
varying vec3 vAirLocal;
varying vec3 vAirLivA;
varying vec3 vAirLivB;
varying vec3 vAirGlow;
${BURST_GLSL}
`,
  vertex: /* glsl */ `
  vAirPaint = aPaint;
  vAirLocal = position;
  vAirLivA = aLivA.rgb;
  vAirLivB = aLivB.rgb;
  float airB = airBurst(lbTime, aLivA.w);
  vAirGlow = vec3(max(aGlow, 0.0) * 0.3, abs(aGlow) * airB * (aGlow < 0.0 ? 1.0 : 0.55), aLivB.w);
`,
  fragmentPars: /* glsl */ `
varying vec3 vAirPaint;
varying vec3 vAirLocal;
varying vec3 vAirLivA;
varying vec3 vAirLivB;
varying vec3 vAirGlow;
${AIR_SUN_GLSL}
`,
  fragment: /* glsl */ `
  {
    float am = vAirPaint.y;
    float plane = 1.0 - vAirGlow.z;
    vec3 pc = vec3(1.0);
    vec3 em = vec3(0.0);
    float eA = airSunE(vLbWorld);
    float an = airNightE(eA);
    float lit = airLitE(eA);
    vec3 P = vAirLocal;
    if (am > 0.5 && am < 1.5) {
      float gx = vAirPaint.x;
      float w = fwidth(gx) * 0.7;
      float tri = abs(fract(gx) - 0.5) * 2.0;
      pc = mix(vAirLivA, vAirLivB, smoothstep(0.5 - w, 0.5 + w, tri));
      float z = vAirPaint.z;
      float wz = fwidth(z) * 0.7;
      pc = mix(pc, vAirLivA, smoothstep(0.87 - wz, 0.87 + wz, z));
      pc = mix(pc, vec3(1.0, 0.93, 0.8), smoothstep(0.2 - wz, 0.2 + wz, z) - smoothstep(0.255 - wz, 0.255 + wz, z));
    } else if (am > 1.5 && am < 2.5) {
      float y = vAirPaint.x;
      float hc = y * 0.13 + 0.16;
      float z = vAirPaint.z;
      float wy = fwidth(y) * 0.7;
      float row = 1.0 - smoothstep(1.0 - wy, 1.0 + wy, abs(y));
      float wq = z / 0.46;
      float wd = fwidth(wq);
      float dots = mix(1.0 - smoothstep(0.27 - wd, 0.27 + wd, abs(fract(wq) - 0.5)), 0.5, smoothstep(0.25, 0.6, wd));
      float win = row * dots * (1.0 - smoothstep(2.4, 2.6, abs(z + 0.15)));
      float cheat = (1.0 - smoothstep(0.38 - wy, 0.38 + wy, abs(y + 2.25))) * (1.0 - smoothstep(3.0, 3.3, abs(z)));
      vec3 dv = P - vec3(0.0, -0.03, 3.3);
      float se = dv.y / length(dv);
      float az = abs(atan(dv.x, dv.z));
      float wse = fwidth(se) * 0.8 + 1e-4;
      float waz = fwidth(az) * 0.8 + 1e-4;
      float post = max(1.0 - smoothstep(0.05 - waz, 0.05 + waz, az), 1.0 - smoothstep(0.045 - waz, 0.045 + waz, abs(az - 0.72)));
      float screen = smoothstep(0.04 - wse, 0.04 + wse, se) * (1.0 - smoothstep(0.42 - wse, 0.42 + wse, se))
                   * (1.0 - smoothstep(1.95 - waz, 1.95 + waz, az)) * (1.0 - post * 0.85);
      float wh = fwidth(hc) * 0.8 + 1e-4;
      float wx = fwidth(P.x) * 0.8 + 1e-4;
      float belly = (1.0 - smoothstep(0.24 - wx, 0.24 + wx, abs(P.x))) * (1.0 - smoothstep(-0.36 - wh, -0.36 + wh, hc)) * (1.0 - smoothstep(2.7, 3.0, abs(z + 0.3)));
      pc = mix(pc, vAirLivA, max(cheat, belly));
      pc = mix(pc, vec3(0.05, 0.06, 0.16), max(win, screen));
      em += vec3(1.0, 0.7, 0.36) * win * an * 0.9 + vec3(0.25, 0.4, 0.6) * screen * an * 0.25;
    } else if (am > 2.5 && am < 3.5) {
      pc = vAirLivA;
      em += vAirLivA * an * 0.22 * smoothstep(1.2, 2.0, P.y);
    } else if (am > 3.5 && am < 4.5) {
      pc = vAirLivB;
    } else if (am > 4.5 && am < 5.5) {
      vec2 q = vec2(abs(P.x) - 1.95, P.y + 0.9);
      float a = atan(q.y, q.x) * 1.2732395;
      float wa = fwidth(a) * 0.8;
      float blade = 1.0 - smoothstep(0.14 - wa, 0.14 + wa, abs(fract(a + length(q) * 1.6) - 0.5));
      pc = mix(vec3(0.5, 0.52, 0.62), vec3(0.16, 0.17, 0.3), blade * smoothstep(0.1, 0.16, length(q)));
    } else if (am > 5.5) {
      float wx = fwidth(P.x) * 0.8 + 1e-4;
      pc = mix(pc, vAirLivA, vAirPaint.z * (1.0 - smoothstep(1.55 - wx, 1.55 + wx, abs(P.x) + 0.35 * (P.z - 0.3))));
    }

    vec3 N = inverseTransformDirection(normal, viewMatrix);
    vec3 up = normalize(vLbWorld);
    float hemi = dot(N, up) * 0.5 + 0.5;
    float dn = clamp(-dot(N, up), 0.0, 1.0) * mix(0.4, 1.0, plane);
    vec3 A = diffuseColor.rgb;
    vec3 An = mix(A, vec3(dot(A, vec3(0.2126, 0.7152, 0.0722))), 0.3);
    vec3 nightC = lbNightFill * (0.6 + 0.4 * hemi) * BRDF_Lambert(An);
    float ntK = lbNightAt(vLbWorld);
    vec3 kitFill = mix(mix(lbGroundFill, lbSkyFill, hemi) * BRDF_Lambert(A), nightC, ntK) * mix(vec3(1.0), vec3(1.16, 0.88, 1.2), ntK * (1.0 - ntK) * 2.2);
    vec3 dayC = mix(lbGroundFill * (1.0 - 0.85 * dn), lbSkyFill, hemi) * BRDF_Lambert(A) + A * vec3(0.55, 0.62, 0.78) * dn * 1.7;
    vec3 airFill = mix(dayC, nightC + A * vec3(0.03, 0.035, 0.08) * dn, an) * mix(vec3(1.0), vec3(1.16, 0.88, 1.2), an * (1.0 - an) * 2.2);
    outgoingLight += lbFill * (airFill - kitFill);
    outgoingLight -= reflectedLight.directDiffuse * (1.0 - lit);
    #if NUM_DIR_LIGHTS > 0
    {
      float kitSun = smoothstep(-0.14, 0.0, dot(up, lbSunDir));
      vec3 dd = getGradientIrradiance(normal, directionalLights[0].direction) * directionalLights[0].color * BRDF_Lambert(A);
      outgoingLight += dd * max(lit - kitSun, 0.0);
    }
    #endif
    float dist = distance(vLbWorld, cameraPosition);
    float glow = vAirGlow.x * mix(1.0, 0.1, smoothstep(60.0, 160.0, dist)) + vAirGlow.y * (1.0 - smoothstep(60.0, 160.0, dist));
    float fr = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.5);
    pc = mix(pc, vec3(dot(pc, vec3(0.2126, 0.7152, 0.0722))) * 1.15, 0.5 * an);
    outgoingLight = outgoingLight * pc + em + vec3(1.0, 0.5, 0.17) * mix(vec3(1.0), pc, 0.6) * glow * (0.04 + 0.96 * an) * 2.0
                  + vec3(0.2, 0.25, 0.55) * fr * an * 1.1 * plane;
  }
`,
};

// ── Contrails ──

/**
 * Contrails: one ribbon per plane, shaped in the vertex stage from routes.ts' formula at past θ
 * (trailPos is the twin of routePos; uniforms per route: uW = weave, weaveK, weavePh, alt; uH =
 * altAmp, altK, altPh, scale; uS = θ now, ω, opacity). Shape and fades:
 *   - Fresh trail (≲ 0.5 s) lies exactly on the flown path; from there to 2.5 s it eases onto the
 *     great circle tangent to the plane's current heading, so the old trail is a straight line
 *     behind the plane, not the curled S-weave (it swings with the heading, ≤ ~7°/s).
 *   - Two engine trails with a soft core that widen a little and merge as they age, and taper again
 *     toward the visible tail (width follows the fades below): a pencil line, never a comet.
 *   - Visible length is capped by age (the old end fades quadratically over the last 40 % of it,
 *     shorter from orbit) and by screen length: anything beyond 12-25 % of the frame width from its
 *     plane fades out (at 150-250 m a 9 s trail swept a third of the frame as a white band).
 *   - A trail fades out as its plane leaves the frame (gone ~10° past the edge) (seen from the rooftops an
 *     off-screen plane's trail read as a lens scratch), and so are segments behind the eye.
 *   - Thinned end-on (two searchlight beams seen from behind), near the eye (a wisp, not a wall)
 *     and beyond the planet's limb (a beam shot up from the surface).
 * Colour: the plane's own time of day (airSunE): white, a peach blush as the sun sets up there, dim
 * moonlit lilac at night, kept under the bloom threshold.
 */
export const contrailVert = /* glsl */ `
#define NP ${NP}
${LB_COMMON_GLSL}
${R_GLSL}
uniform vec3 uA[NP];
uniform vec3 uB[NP];
uniform vec3 uN[NP];
uniform vec4 uW[NP];
uniform vec4 uH[NP];
uniform vec4 uS[NP];
uniform vec3 uDodge[NP];
uniform float uTrail;
uniform float uViewH;
uniform float uReveal;
varying float vAlpha;
varying float vX;
varying float vSep;
varying float vSig;
varying float vAge;
varying vec3 vWorld;
#include <fog_pars_vertex>
vec3 routeDir(int i, float th) {
  float lam = uW[i].x * sin(uW[i].y * th + uW[i].z);
  return (uA[i] * cos(th) + uB[i] * sin(th)) * cos(lam) + uN[i] * sin(lam);
}
vec3 trailPos(int i, float age, vec3 d0, vec4 g) {
  float th = uS[i].x - uS[i].y * age;
  float ph = g.w * uS[i].y * age;
  vec3 d = mix(routeDir(i, th), d0 * cos(ph) - g.xyz * sin(ph), smoothstep(0.5, 2.5, age));
  return normalize(d) * (AIR_R + uW[i].w + uH[i].x * sin(uH[i].y * th + uH[i].z)) + uDodge[i] * exp(-age * 1.5);
}
void main() {
  int i = gl_InstanceID;
  float u = position.x;
  float side = position.y;
  float age = u * uTrail;
  float sc = uH[i].w;
  vec3 d0 = routeDir(i, uS[i].x);
  vec3 gd = (routeDir(i, uS[i].x + 0.003) - routeDir(i, uS[i].x - 0.003)) / 0.006;
  vec4 g = vec4(normalize(gd), length(gd));
  vec3 c = trailPos(i, age, d0, g);
  vec3 T = normalize(trailPos(i, age - 0.05, d0, g) - c);
  vec3 up = normalize(c);
  vec3 p = c - up * (0.6 * sc);
  vec3 h = trailPos(i, 0.0, d0, g);
  h -= normalize(h) * (0.6 * sc);
  vec3 hv = (viewMatrix * vec4(h, 1.0)).xyz;
  vec4 ch = projectionMatrix * vec4(hv, 1.0);
  vec4 cp = projectionMatrix * viewMatrix * vec4(p, 1.0);
  float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
  float scr = 0.0;
  if (ch.w > 0.05 && cp.w > 0.05) {
    vec2 dd = cp.xy / cp.w - ch.xy / ch.w;
    scr = 1.0 - smoothstep(0.12, 0.25, 0.5 * length(vec2(dd.x, dd.y / aspect)));
  }
  float ex = max(atan(abs(hv.x), -hv.z) - atan(1.0 / projectionMatrix[0][0]), atan(abs(hv.y), -hv.z) - atan(1.0 / projectionMatrix[1][1]));
  float inFrame = 1.0 - smoothstep(0.0, 0.17, ex);
  float orbit = smoothstep(150.0, 320.0, lbCamAlt);
  float L = mix(1.0, 0.55, orbit);
  float fo = clamp((L - u) / (0.4 * L), 0.0, 1.0);
  float vis = fo * fo * scr;
  vec3 toEye = cameraPosition - p;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 1e-3);
  vec3 sv = cross(T, V);
  float sl = length(sv);
  sv = sl > 1e-4 ? sv / sl : normalize(cross(T, up));
  vec3 left = normalize(cross(up, T));
  float sig = (0.11 + 0.24 * smoothstep(0.0, 3.0, age)) * mix(0.35, 1.0, sqrt(vis)) * sc;
  float sep = 1.9 * sc * mix(1.0, 0.35, smoothstep(1.0, 5.0, age)) * abs(dot(sv, left));
  float s = max(sig, 0.9 * dist * 2.0 / (projectionMatrix[1][1] * uViewH));
  float halfW = sep + 2.6 * s;
  vec3 wp = p + sv * side * halfW;
  vX = side * halfW;
  vSep = sep;
  vSig = s;
  vAge = age;
  vWorld = wp;
  float camD = length(cameraPosition);
  float limb = dot(p, cameraPosition / camD) - (AIR_R + 2.0) * (AIR_R + 2.0) / camD;
  vAlpha = smoothstep(0.1, 0.7, age) * vis * inFrame * (sig / s) * smoothstep(0.15, 0.5, sl) * smoothstep(3.0, 14.0, dist)
         * mix(0.15, 1.0, smoothstep(-30.0, 8.0, limb)) * mix(1.0, 0.6, orbit) * uS[i].z * uReveal;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

export const contrailFrag = /* glsl */ `
${LB_COMMON_GLSL}
${AIR_SUN_GLSL}
varying float vAlpha;
varying float vX;
varying float vSep;
varying float vSig;
varying float vAge;
varying vec3 vWorld;
#include <fog_pars_fragment>
void main() {
  float x = abs(vX);
  float a0 = (x - vSep) / vSig;
  float a1 = (x + vSep) / vSig;
  float k = min(1.0, exp(-0.5 * a0 * a0) + exp(-0.5 * a1 * a1)) * vAlpha;
  k *= 0.84 + 0.16 * sin(vAge * 4.7 + vX * 0.6);
  if (k < 0.004) discard;
  float e = airSunE(vWorld);
  float lit = airLitE(e);
  float dusk = smoothstep(-0.28, -0.16, e) * (1.0 - smoothstep(-0.06, 0.22, e));
  vec3 col = mix(vec3(0.94, 0.93, 0.92), vec3(0.96, 0.7, 0.64), dusk * 0.8);
  col = mix(vec3(0.2, 0.22, 0.42), col, lit);
  gl_FragColor = vec4(col, k * mix(0.35, 0.9, lit));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// ── Nav lights and burner flames ──

/**
 * Lights (additive points). aCol = rgb + pattern (0 steady nav, 1 beacon flash, 2 double strobe of
 * ~70 ms flat-topped flashes, 3 burner flame); aMeta = size (m), phase, minimum px. The minimum sizes
 * are for the street (a light 60 m up must read) and halve toward orbit, where a beacon must stay a
 * spark. The burner flame is a tall teardrop, close by only (from orbit a flashing dot read as a
 * strobe over the city).
 */
export const lightsVert = /* glsl */ `
${LB_COMMON_GLSL}
${BURST_GLSL}
${AIR_SUN_GLSL}
attribute vec4 aCol;
attribute vec3 aMeta;
uniform float uViewH;
uniform float uReveal;
varying vec3 vCol;
varying float vI;
varying float vFlame;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float pat = aCol.w;
  float t = lbTime + aMeta.y;
  float night = airNightE(airSunE(position));
  float on;
  vFlame = 0.0;
  if (pat < 0.5) on = night;
  else if (pat < 1.5) on = exp(-pow(fract(t / 1.3) / 0.06, 2.0)) * (0.15 + 0.85 * night);
  else if (pat < 2.5) {
    float s = fract(t / 1.7);
    on = (exp(-pow(s / 0.022, 4.0)) + exp(-pow((s - 0.12) / 0.022, 4.0))) * (0.25 + 0.75 * night);
  } else {
    on = airBurst(lbTime, aMeta.y) * (0.6 + 0.4 * night) * (1.0 - smoothstep(90.0, 170.0, -mv.z));
    vFlame = 1.0;
  }
  vI = on * uReveal;
  vCol = aCol.rgb;
  float px = aMeta.x * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 0.1);
  gl_PointSize = vI > 0.004 ? clamp(px, aMeta.z * mix(1.0, 0.5, smoothstep(120.0, 300.0, lbCamAlt)), 64.0) : 0.0;
}
`;

export const lightsFrag = /* glsl */ `
varying vec3 vCol;
varying float vI;
varying float vFlame;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  if (vFlame > 0.5) {
    float yv = c.y * 0.5 + 0.5;
    c.x /= mix(0.12, 0.62, sqrt(yv));
    c.y = (c.y - 0.45) * 1.1;
  }
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 6.0);
  float halo = exp(-r2 * 3.0) * (1.0 - r2);
  vec3 col = vFlame > 0.5 ? mix(vCol, vec3(1.0, 0.92, 0.6), core) : vCol;
  gl_FragColor = vec4((col * (core * 2.2 + halo * 0.7) + core * 0.6) * vI, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
