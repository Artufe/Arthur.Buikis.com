// Sky GLSL (A3). The dome, the stars and the planet's haze rim share one air model:
//
//   a = (angle of the ray above the planet's limb) / θ, θ = domeAngle(altitude) (sky/rig.ts)
//
// a = 0 grazes the limb, a = 1 is where the air ends and space begins. From orbit θ is ~3°, so
// the air is a crisp rim hugging the planet; descending, θ grows until the whole sky is air. The
// colour along a runs pale horizon → sky blue → deep blue → space. Day / dusk / night per ray come
// from the sun's elevation at the ray's "air point" (its closest approach to the planet), so the
// limb seen from orbit is lit on one side, dark on the other and pink/purple at the terminator,
// and the street sky follows the sun over the visible horizon.

/** Shared air-model declarations (dome + stars). */
export const AIR_GLSL = /* glsl */ `
uniform vec3 uUp;      // unit up at the eye
uniform float uEyeR;   // eye distance from the planet centre
uniform float uLimb;   // angular radius of the sea-level planet seen from the eye (rad)
uniform float uTheta;  // dome angle (rad)
uniform float uTail;   // reach of the soft outer fade into space (rad, >= uTheta): from orbit it runs past the cloud shell
uniform float uSkyDip; // sin of the (capped) horizon dip: low air stays sunlit a little past local sunset
uniform vec3 uSunDir;
uniform float uAirSpace; // 0 inside the air … 1 in orbit (sky/rig.ts spaceAmount)
// 0 at the limb … 1 where the air's colours end (the crisp profile).
float airA(vec3 v) {
  float nadir = acos(clamp(-dot(v, uUp), -1.0, 1.0));
  return clamp((nadir - uLimb) / uTheta, 0.0, 1.0);
}
// 0 at the limb … 1 where space begins (the soft outer fade).
float airTail(vec3 v) {
  float nadir = acos(clamp(-dot(v, uUp), -1.0, 1.0));
  return clamp((nadir - uLimb) / uTail, 0.0, 1.0);
}
// Sun elevation (sin) where this ray's sky is. Seen from orbit: at the ray's air point (its closest
// approach), so the limb is lit on one side and dark on the other. Inside the air: at the eye,
// over the visible (dipped) horizon, so the whole street sky shares one time of day and the colour
// varies by direction to the sun instead.
float airSun(vec3 v) {
  vec3 eye = uUp * uEyeR;
  float tc = -dot(eye, v);
  vec3 cp = eye + v * max(tc, 0.0);
  return mix(dot(uUp, uSunDir) + uSkyDip, dot(normalize(cp), uSunDir), uAirSpace);
}
`;

export const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}`;

/**
 * Painted cumulus on the dome (seen only from inside the air, street … cloud layer): the real cloud
 * layer is out of sight from the street on this tiny planet (no cloud over the city, and the
 * outskirt ones sink below the ~23 m horizon), so a few far toon cumulus fill the sky there.
 * Each is a union of 6 discs in (azimuth · cos el, elevation) with a flat base, toon-lit as
 * spheres from the sun, coloured by the eye's time of day (cloud palette, sky/rig.ts).
 */
const SKY_CUMULUS_GLSL = /* glsl */ `
uniform float uCloudAmt; // 0 off … 1 (faded out above the cloud layer)
uniform vec3 uEast, uNorth; // the eye's horizontal frame
uniform float uCTime;
uniform vec3 uCLit, uCShade, uCBelly, uCRim;
// az (rad), elevation of the base (rad), half-width (rad), seed
const vec4 SKC[7] = vec4[7](
  vec4(0.35, 0.17, 0.13, 0.13),
  vec4(1.35, 0.30, 0.09, 0.71),
  vec4(2.30, 0.12, 0.15, 0.37),
  vec4(3.10, 0.36, 0.08, 0.91),
  vec4(3.95, 0.21, 0.12, 0.55),
  vec4(4.90, 0.10, 0.16, 0.23),
  vec4(5.70, 0.31, 0.10, 0.83)
);
// The cumulus template: crown, shoulders, side lumps, a top lump (x, y, r in half-widths).
const vec3 SKP[6] = vec3[6](
  vec3(0.0, 0.5, 0.5),
  vec3(-0.46, 0.33, 0.36),
  vec3(0.44, 0.36, 0.4),
  vec3(-0.84, 0.17, 0.22),
  vec3(0.84, 0.18, 0.25),
  vec3(0.14, 0.86, 0.3)
);
float skcHash(float n) { return fract(sin(n) * 43758.5453); }
// rgb: colour, a: coverage
vec4 skyCumulus(vec3 v, vec3 sunD) {
  float el = asin(clamp(dot(v, uUp), -1.0, 1.0));
  if (uCloudAmt <= 0.0 || el < 0.04 || el > 0.85) return vec4(0.0);
  float az = atan(dot(v, uEast), dot(v, uNorth));
  vec4 res = vec4(0.0);
  for (int i = 0; i < 7; i++) {
    vec4 c = SKC[i];
    float caz = c.x + uCTime * (0.0035 + 0.0015 * float(i));
    float dAz = mod(az - caz + 3.14159265, 6.2831853) - 3.14159265;
    vec2 p = vec2(dAz * cos(el), el - c.y) / c.z;
    if (abs(p.x) > 1.3 || p.y < -0.1 || p.y > 1.4) continue;
    float sdf = 1e3;
    float best = -1.0;
    vec3 n = vec3(0.0, 0.0, 1.0);
    for (int k = 0; k < 6; k++) {
      float h1 = skcHash(c.w * 91.7 + float(k) * 13.1) - 0.5;
      float h2 = skcHash(c.w * 37.3 + float(k) * 7.9) - 0.5;
      vec3 q = SKP[k];
      float pr = q.z * (1.0 + 0.25 * h2);
      vec2 d = p - vec2(q.x + 0.12 * h1, q.y + 0.1 * h2);
      float dl = length(d);
      sdf = min(sdf, dl - pr);
      float h = pr * pr - dl * dl;
      if (h > 0.0) {
        float hz = sqrt(h) + q.y * 0.6; // the higher lumps sit in front
        if (hz > best) { best = hz; n = vec3(d / pr, sqrt(h) / pr); }
      }
    }
    // One rounded body under the lumps: the lumps only dent its shading, so the cloud reads as one
    // cumulus, not a row of bubbles.
    vec2 qb = (p - vec2(0.0, 0.25)) / vec2(1.1, 0.8);
    vec3 nb = vec3(qb, sqrt(max(0.0, 1.0 - dot(qb, qb))));
    n = normalize(n * 0.22 + nb);
    sdf = max(sdf, 0.02 - p.y); // flat base
    float aa = max(fwidth(sdf), 1e-4);
    float cov = 1.0 - smoothstep(-aa, aa, sdf);
    if (cov <= 0.0) continue;
    // The sun in the cloud's frame: x right, y up, z toward the eye.
    vec3 f = normalize(uNorth * cos(caz) + uEast * sin(caz));
    f = normalize(f * cos(c.y + 0.12 * c.z) + uUp * sin(c.y + 0.12 * c.z));
    vec3 rt = normalize(cross(f, uUp));
    vec3 upL = cross(rt, f);
    vec3 sl = vec3(dot(sunD, rt), dot(sunD, upL), -dot(sunD, f));
    // The puffs' two bands (clouds/shaders.ts), on the same palette at the eye's time of day.
    float w = dot(n, sl) * 0.5 + 0.5;
    float b1 = smoothstep(0.34, 0.4, w);
    float b2 = smoothstep(0.5, 0.56, w);
    vec3 shade = mix(uCBelly, uCShade, smoothstep(0.05, 0.55, p.y));
    vec3 col = mix(shade, mix(shade, uCLit, 0.6), b1);
    col = mix(col, uCLit, b2);
    // A thin warm edge on the sun side only (no sticker outline).
    float edge = 1.0 - smoothstep(0.0, 1.5 * aa, -sdf);
    float sunSide = smoothstep(0.1, 0.6, dot(normalize(vec2(sl.x, sl.y) + 1e-4), normalize(p - vec2(0.0, 0.4))));
    col = mix(col, uCRim, edge * sunSide * 0.5);
    res = vec4(col, cov);
    break; // clouds never overlap (spread in azimuth)
  }
  res.a *= uCloudAmt;
  return res;
}
`;

export const skyFrag = /* glsl */ `
${AIR_GLSL}
${SKY_CUMULUS_GLSL}
uniform float uSpace;
uniform float uWarm;
uniform vec3 uHorizon, uTop, uDeep, uSpaceCol, uNightHorizon, uNightTop, uGold, uPeach, uDuskOrange, uDuskPink, uDuskPurple, uSunCol;
uniform vec3 uBandAxis; // the starfield's milky band (great circle normal)
uniform vec2 uSunPx;   // sun disc centre in drawing-buffer px (gl_FragCoord space)
uniform float uSunRpx; // its radius in px (constant on-screen size: no egg at the frame edge)
uniform float uSunVis; // 0 when the sun is behind the camera
uniform vec2 uMoonPx;
uniform float uMoonRpx;
uniform float uMoonVis;
uniform vec3 uMoonSun; // the sun direction in the moon disc's frame (x right, y up, z toward the eye)
uniform float uVeil;   // 0..1: the sky behind the cloud white-out's mist (clouds/)
uniform vec3 uVeilCol;
varying vec3 vDir;

float sat(float x) { return clamp(x, 0.0, 1.0); }

void main() {
  vec3 v = normalize(vDir);
  float a = airA(v);
  float at = mix(a, airTail(v), uSpace);
  float sunAt = airSun(v);
  float night = 1.0 - smoothstep(-0.26, 0.05, sunAt);
  float dusk = smoothstep(-0.3, -0.02, sunAt) * (1.0 - smoothstep(0.02, 0.3, sunAt));
  float sd = dot(v, uSunDir);
  float sdn = sd * 0.5 + 0.5;
  float low = 1.0 - smoothstep(0.0, 0.3, a);
  float sunEye = dot(uUp, uSunDir) + uSkyDip; // sun elevation (sin) over the visible horizon

  // Day: pale horizon → sky blue → deep blue aloft. Seen from orbit the profile tightens: a crisp
  // pale inner edge on the limb, then blue, then a long soft fade into space (on the tail).
  vec3 day = mix(uHorizon, uTop, pow(smoothstep(0.0, mix(0.36, 0.14, uSpace), a), 0.7));
  day = mix(day, uDeep, smoothstep(mix(0.42, 0.16, uSpace), mix(0.88, 0.55, uSpace), a));
  // Golden hour (inside the air): a luminous gold band on the horizon that swells under the sun,
  // a warm wash over the lower sky, and a wide peach glow around a low sun. Gold is mixed only into
  // the pale band; over the blue the glow is ADDED (blue + peach = a warm luminous blue, never grey).
  float gw = uWarm * (1.0 - night) * (1.0 - uSpace);
  vec3 hv = v - uUp * dot(v, uUp);
  vec3 hs = uSunDir - uUp * dot(uSunDir, uUp);
  float sh = dot(hv, hs) * inversesqrt(max(dot(hv, hv) * dot(hs, hs), 1e-8)) * 0.5 + 0.5; // 1 under the sun
  float lowSun = 1.0 - smoothstep(0.3, 0.6, sunEye);
  float bw = mix(0.1, mix(0.12, 0.34, lowSun), pow(sh, 4.0));
  float band = 1.0 - smoothstep(0.0, bw, a);
  day = mix(day, day * vec3(1.06, 0.98, 0.88) + vec3(0.07, 0.035, 0.0), gw * (1.0 - smoothstep(0.0, 0.55, a)));
  day = mix(day, uGold, gw * band * (0.35 + 0.65 * sh * sh) * 0.88);
  float sdp = max(sd, 0.0);
  float lobe = pow(sdp, 10.0);
  day += mix(uPeach, uGold, smoothstep(0.2, 0.8, lobe)) * lobe * gw * lowSun * 0.32;
  day = mix(day, uGold, pow(sdp, 60.0) * gw * lowSun * 0.6);
  // Dusk: orange at the sun, pink beside it, purple opposite (the belt of Venus); purple aloft.
  vec3 duskLow = mix(uDuskPurple, uDuskPink, smoothstep(0.05, 0.6, sdn));
  duskLow = mix(duskLow, uDuskOrange, smoothstep(0.7, 1.0, sdn));
  day = mix(day, duskLow, dusk * low * 0.92);
  day = mix(day, mix(uDeep, uDuskPurple, 0.45), dusk * (1.0 - low) * 0.35 * (1.0 - smoothstep(0.6, 1.0, a)));
  // Night: indigo horizon → navy; seen from orbit the dark limb is only a faint indigo line.
  vec3 nightC = mix(uNightHorizon, uNightTop, pow(smoothstep(0.0, 0.5, a), 0.7));
  nightC = mix(nightC, mix(uSpaceCol, uNightHorizon, 0.5 * (1.0 - smoothstep(0.0, 0.3, a))), uSpace * 0.92);
  vec3 col = mix(day, nightC, night);
  // Space beyond the air: a deep blue with a faint milky band.
  float mw = dot(v, uBandAxis);
  vec3 spaceC = uSpaceCol * (1.0 + 0.6 * exp(-mw * mw * 40.0) + 0.1 * (1.0 - abs(mw)));
  col = mix(col, spaceC, pow(smoothstep(mix(0.7, 0.25, uSpace), 1.0, at), mix(1.0, 0.75, uSpace)));

  // Painted far cumulus (inside the air only).
  if (uCloudAmt > 0.0) {
    vec4 cu = skyCumulus(v, uSunDir);
    col = mix(col, cu.rgb, cu.a);
  }

  // Cartoon sun: a crisp disc coloured by its elevation (sky/rig.ts discColor), MIXED in so it
  // never clips to white, and a soft angular halo (tight in space, wide and warm in the air).
  float dpx = length(gl_FragCoord.xy - uSunPx);
  float disc = (1.0 - smoothstep(uSunRpx - 1.0, uSunRpx + 1.0, dpx)) * uSunVis * step(0.0, sd);
  float halo = pow(sdp, mix(260.0, 2400.0, uSpace)) * 0.45 + pow(sdp, mix(40.0, 400.0, uSpace)) * mix(0.08, 0.05, uSpace);
  col += uSunCol * halo * (1.0 - 0.6 * night);
  col = mix(col, uSunCol * 1.08, disc);

  // Cartoon moon: a disc of constant size, toon-lit by the sun (its phase), with a few craters.
  if (uMoonVis > 0.0) {
    vec2 mp = (gl_FragCoord.xy - uMoonPx) / uMoonRpx;
    float r2 = dot(mp, mp);
    if (r2 < 1.21) {
      float edge = 1.0 - smoothstep(1.0 - 1.5 / uMoonRpx, 1.0 + 1.5 / uMoonRpx, sqrt(r2));
      vec3 n = vec3(mp, sqrt(max(0.0, 1.0 - r2)));
      float lit = smoothstep(-0.02, 0.12, dot(n, uMoonSun));
      float cr = 0.0;
      // Craters scattered off-axis (no pair side by side at one height: that read as a face).
      cr += 1.0 - smoothstep(0.17, 0.2, length(mp - vec2(-0.36, 0.06)));
      cr += 1.0 - smoothstep(0.08, 0.11, length(mp - vec2(0.18, 0.52)));
      cr += 1.0 - smoothstep(0.12, 0.15, length(mp - vec2(0.38, -0.2)));
      cr += 1.0 - smoothstep(0.05, 0.08, length(mp - vec2(-0.08, -0.55)));
      cr += 1.0 - smoothstep(0.04, 0.065, length(mp - vec2(-0.5, 0.48)));
      vec3 moonLit = mix(vec3(0.96, 0.94, 0.84), vec3(0.78, 0.76, 0.86), sat(cr));
      vec3 moonDark = col * 0.55 + vec3(0.02, 0.025, 0.06);
      // By day the lit part is a pale ghost over the blue; at night / in space it glows.
      float glow = mix(0.45, 1.0, max(night, uSpace));
      vec3 m = mix(moonDark, mix(col, moonLit, glow), lit);
      col = mix(col, m, edge * uMoonVis);
      // A faint glow ring around it at night.
      col += vec3(0.5, 0.55, 0.8) * 0.06 * night * uMoonVis * (1.0 - smoothstep(1.0, 1.1, sqrt(r2))) * (1.0 - edge);
    }
  }
  // Inside / under a cloud the sky is behind the same mist as the fogged scene.
  col = mix(col, uVeilCol, uVeil);
  // Dither: kills 8-bit banding in the long gradients.
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const starVert = /* glsl */ `
${AIR_GLSL}
attribute float aSize;
attribute float aPhase;
attribute vec3 aTint;
uniform float uTime;
uniform float uPx;
uniform float uOpacity;
varying float vA;
varying vec3 vTint;
varying float vSpark;
void main() {
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
  vec3 v = normalize(position);
  float a = airTail(v);
  float night = 1.0 - smoothstep(-0.26, 0.05, airSun(v));
  // Hidden by daylit air, faint through night air near the horizon, full in space.
  // (At night the fade-in near the horizon is in angle, not in a: the dome spans ~190° there.)
  float aboveDeg = airA(v) * uTheta * 57.2958;
  float vis = mix(smoothstep(0.7, 1.0, a), max(smoothstep(1.0, 14.0, aboveDeg), smoothstep(0.7, 1.0, a)), night);
  // Sparkles (the biggest stars) twinkle in size and brightness; the rest shimmer gently.
  vSpark = step(5.0, aSize);
  float tw = 0.7 + 0.3 * sin(uTime * (0.9 + aPhase) + aPhase * 40.0);
  float tws = 0.55 + 0.45 * sin(uTime * (1.6 + aPhase) + aPhase * 17.0);
  vA = vis * mix(tw, tws, vSpark) * uOpacity;
  vTint = aTint;
  gl_PointSize = aSize * uPx * mix(1.0, 0.8 + 0.4 * tws, vSpark);
}`;

export const starFrag = /* glsl */ `
varying float vA;
varying vec3 vTint;
varying float vSpark;
void main() {
  if (vA < 0.01) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  // A soft round star; the sparkles add a 4-point cross.
  float core = 1.0 - smoothstep(mix(0.14, 0.06, vSpark), mix(0.5, 0.2, vSpark), r);
  float arms = (1.0 - smoothstep(0.0, 0.05, abs(c.x))) * (1.0 - smoothstep(0.05, 0.5, abs(c.y)));
  arms = max(arms, (1.0 - smoothstep(0.0, 0.05, abs(c.y))) * (1.0 - smoothstep(0.05, 0.5, abs(c.x))));
  float a = max(core, arms * vSpark) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vTint * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// The haze over the planet's own limb (seen from altitude): a front-faced shell just above the
// surface whose additive glow grows toward the planet's silhouette, so the disc's edge sinks into
// the rim of air instead of being cut out against it. Lit side blue, terminator pink, night none.
export const hazeVert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const hazeFrag = /* glsl */ `
uniform vec3 uCam;
uniform vec3 uSunDir;
uniform vec3 uRim, uDusk, uPurple;
uniform float uR;
uniform float uStrength;
uniform float uTwilight;
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld - uCam);
  float tc = -dot(uCam, d);
  vec3 cp = uCam + d * tc;
  float b2 = dot(cp, cp);
  float b = sqrt(b2) / uR; // < 1: the ray meets the planet; 1 at its silhouette
  if (b >= 1.0 || tc < 0.0) discard;
  // Where the ray meets the sea-level sphere (close enough to the terrain for a glow).
  vec3 hit = uCam + d * (tc - sqrt(max(uR * uR - b2, 0.0)));
  vec3 n = normalize(hit);
  float s = dot(n, uSunDir);
  // Limb haze: thin air seen edge-on, lit side blue, terminator pink.
  // (Faded out just inside the sea-level limb: land and trees standing above sea level at the
  // silhouette get no haze, so there must be no haze edge there either.)
  float glow = pow(b, 12.0) * (1.0 - smoothstep(0.93, 0.995, b));
  float lit = smoothstep(-0.18, 0.25, s);
  float duskL = smoothstep(-0.22, 0.0, s) * (1.0 - smoothstep(0.02, 0.32, s));
  vec3 col = mix(uRim, uDusk, duskL * 0.85) * glow * lit * uStrength;
  // Twilight belt across the disc: the air over the terminator glows pink on the sunward side
  // and purple toward the night, so the day/night edge reads colourful from orbit (surfaces alone
  // can only darken there).
  // Faded toward the limb (it is a wash over the ground, not more air) and a little desaturated,
  // so islands in it read as dusk-lit land, not pink stains.
  float belt = smoothstep(-0.17, -0.06, s) * (1.0 - smoothstep(-0.03, 0.07, s)) * (1.0 - smoothstep(0.55, 0.95, b));
  vec3 bc = mix(uPurple, uDusk, smoothstep(-0.14, 0.04, s));
  bc = mix(bc, vec3(dot(bc, vec3(0.3, 0.59, 0.11))), 0.3);
  col += bc * belt * uTwilight;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
