// Cloud GLSL (A3): toon puffs, the white-out veil and its scene blocker.

import { LB_COMMON_GLSL } from '../render/toon';

// The puff's shape, shared by the vertex stage (silhouette) and the fragment stage (an exact
// per-pixel normal and crease, so the toon band edges and the seams between lobes are clean
// curves, not triangle-interpolated zig-zags). A puff is the union of its core sphere and six
// bulge spheres (five round its shoulders, one on top, sized and placed per puff), as a radial
// function of the direction P from the puff's centre: a cauliflower cumulus whose lobes each get
// their own lit cap and terminator. Returns the radius (× the puff's radius) along P.
const PUFF_SHAPE_GLSL = /* glsl */ `
// Trig-free hash (Hoskins' hash11): the shape runs per vertex and, near the eye, per pixel.
float lbHash(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float puffShape(vec3 P, vec3 upP, float seed, float near, out vec3 n, out float crease, out float seam) {
  float ph = seed * 6.2831;
  vec3 ex = normalize(cross(abs(upP.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), upP));
  vec3 ey = cross(upP, ex);
  float best = 1.0;
  float second = 1.0;
  vec3 nB = P;
  vec3 nS = P;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float hA = lbHash(seed * 91.7 + fi * 1.37);
    float hB = lbHash(seed * 37.3 + fi * 2.11);
    float hC = lbHash(seed * 13.9 + fi * 3.73);
    float az = ph + fi * 1.2566 + (hA - 0.5) * 0.7;
    float el = i == 5 ? 1.2 + (hB - 0.5) * 0.5 : 0.05 + 0.55 * hB;
    vec3 bd = upP * sin(el) + (ex * cos(az) + ey * sin(az)) * cos(el);
    float rho = mix(0.4, 0.62, hC) * (i == 5 ? 1.15 : 1.0);
    float lift = mix(0.1, 0.22, fract(hA * 7.3)) + 0.05 * near;
    vec3 C = bd * (1.0 - rho + lift);
    float pc = dot(P, C);
    float disc = pc * pc - dot(C, C) + rho * rho;
    if (disc > 0.0) {
      float t = pc + sqrt(disc);
      if (t > best) {
        second = best;
        nS = nB;
        best = t;
        nB = (P * t - C) / rho;
      } else if (t > second) {
        second = t;
        nS = (P * t - C) / rho;
      }
    }
  }
  // A crease line only where the surface really folds (the two lobes' normals > ~35° apart): shallow
  // seams drew stacked discs, like bubble-wrap, on every cumulus.
  crease = best > 1.0 ? (1.0 - smoothstep(0.0, 0.03, best - second)) * (1.0 - smoothstep(0.76, 0.86, dot(normalize(nB), normalize(nS)))) : 0.0;
  // Wider: is a seam close enough that a triangle here may straddle it?
  seam = best > 1.0 ? 1.0 - smoothstep(0.0, 0.14, best - second) : 0.0;
  // Fine irregularity on top (stronger near the eye: torn cotton silhouettes when flying past).
  vec3 a1 = vec3(5.1, 4.6, 4.9) * P + vec3(ph, 1.7 * ph, 0.6 * ph);
  vec3 s1 = sin(a1), c1 = cos(a1);
  vec3 g1 = vec3(5.1 * c1.x * s1.y * s1.z, 4.6 * s1.x * c1.y * s1.z, 4.9 * s1.x * s1.y * c1.z);
  float k1 = 0.022;
  vec3 gf = k1 * g1;
  float f = k1 * s1.x * s1.y * s1.z;
  if (near > 0.0) {
    float k3 = 0.03 * near;
    vec3 a3 = vec3(9.3, 8.6, 9.9) * P.zxy + vec3(0.7 * ph, 1.3 * ph, -ph);
    vec3 s3 = sin(a3), c3 = cos(a3);
    vec3 g3z = vec3(9.3 * c3.x * s3.y * s3.z, 8.6 * s3.x * c3.y * s3.z, 9.9 * s3.x * s3.y * c3.z);
    gf += k3 * vec3(g3z.y, g3z.z, g3z.x);
    f += k3 * s3.x * s3.y * s3.z;
  }
  n = normalize(normalize(nB) - (gf - dot(gf, P) * P));
  return best + f;
}
`;

// Puffs: instanced unit spheres (instanceMatrix = centre + radius, in the cloud frame; modelMatrix
// = the drift rotation). Flat cumulus bases with a rounded pillow edge: anything below the
// cluster's base is eased onto it (an exponential soft clamp, never a knife cut).
// Cotton: each puff's silhouette is broken into rounded lobes by a low-frequency field on the unit
// sphere (a different set per puff), with a third, stronger octave once the puff is within ~25 m,
// so the puffs the camera flies past read as cotton, not marshmallows. The shading normal is the
// lobe field's analytic normal, so the toon bands follow the lobes in smooth curves (banding on a
// fine bump lattice tore the band edges into zig-zags); the fine bumps are only a ±8 % value tweak.
// Two toon bands; belly, shade and lit colours from the cloud palette by the sun's elevation
// (white → cream → peach → mauve → night indigo, never grey); one rim per CLUSTER (fresnel against
// the cluster's ellipsoid), so a cumulus reads as one cloud, not a bunch of balloons.
export const puffVert = /* glsl */ `
${LB_COMMON_GLSL}
${PUFF_SHAPE_GLSL}
#include <common>
#include <fog_pars_vertex>
attribute vec4 aInfo;    // x: base altitude, y: top altitude, z: phase, w: cluster horizontal radius
attribute vec4 aCluster; // xyz: cluster centre (cloud frame, mid-height), w: cluster vertical half-height
attribute float aReveal; // reveal delay (s on lbRevealClock)
uniform float uR;
uniform float uRevealDur;
uniform float uSoft; // base rounding (m)
varying vec3 vWorld;
varying vec3 vLocal;    // cloud-frame position (m): the bump lattice's domain, drifts with the cloud
varying vec3 vCentre;   // puff centre (world)
varying vec3 vClusterC; // cluster centre (world)
varying vec2 vClusterR; // cluster radii: horizontal, vertical
varying float vSquash;  // 0 on the free sphere … 1 on the flat base
varying float vHb;      // height above the cluster's flat base (m)
varying float vRel;     // 0 at the base … 1 at the top of the cluster
varying float vReveal;
varying vec3 vNormalW;  // the shape's normal per vertex (world): used away from seams and far away
varying float vSeam, vCreaseV; // per vertex: seam proximity (0 = none) and the crease amount
varying vec3 vDir;      // unit direction from the puff centre (object space): the shape's domain
varying vec3 vUpP;      // the puff's local up (constant per puff)
varying float vNear, vSeed;
void main() {
  float p = clamp((lbRevealClock - aReveal) / max(uRevealDur, 1e-3), 0.0, 1.0);
  vReveal = p;
  vec3 P = position;
  float ph = aInfo.z * 6.2831;
  vec3 cl = instanceMatrix[3].xyz;
  float rad = length(instanceMatrix[0].xyz);
  // Distance from the eye to this puff's surface: the near octave grows in under ~25 m.
  vec3 eyeL = transpose(mat3(modelMatrix)) * cameraPosition; // the drift is a pure rotation
  float near = 1.0 - smoothstep(12.0, 28.0, distance(eyeL, cl) - rad);
  vec3 upP = normalize(cl);
  vec3 nObj;
  float crease;
  float seam;
  float shapeR = puffShape(P, upP, aInfo.z, near, nObj, crease, seam);
  vSeam = seam;
  vCreaseV = crease;
  vDir = P;
  vNormalW = mat3(modelMatrix) * nObj;
  vUpP = upP;
  vNear = near;
  vSeed = aInfo.z;
  vec3 pos = P * (shapeR + 0.02 * sin(lbTime * 0.4 + ph));
  #ifndef LB_REVEAL_FADE
    pos *= lbSpring(p);
  #endif
  vec4 wl = instanceMatrix * vec4(pos, 1.0);
  vLocal = wl.xyz;
  float r = length(wl.xyz);
  float h = r - uR;
  float t = h - aInfo.x;
  float sq = 0.0;
  if (t < uSoft) {
    // Soft clamp onto the base: t' = s·exp((t − s)/s) meets t' = t with matching slope at t = s and
    // flattens toward the base below: a rounded pillow edge.
    float t2 = uSoft * exp((t - uSoft) / uSoft);
    wl.xyz *= (uR + aInfo.x + t2) / r;
    sq = clamp((uSoft - t) / (uSoft * 1.6), 0.0, 1.0);
    h = aInfo.x + t2;
  }
  vSquash = sq;
  vHb = h - aInfo.x;
  vec4 w = modelMatrix * wl;
  vWorld = w.xyz;
  vCentre = (modelMatrix * vec4(cl, 1.0)).xyz;
  vClusterC = (modelMatrix * vec4(aCluster.xyz, 1.0)).xyz;
  vClusterR = vec2(aInfo.w, aCluster.w);
  vRel = clamp((h - aInfo.x) / max(aInfo.y - aInfo.x, 1.0), 0.0, 1.0);
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

export const puffFrag = /* glsl */ `
${LB_COMMON_GLSL}
${PUFF_SHAPE_GLSL}
#include <common>
#include <fog_pars_fragment>
uniform float uPalE[6];
uniform vec3 uPalLit[6];
uniform vec3 uPalShade[6];
uniform vec3 uPalBelly[6];
uniform vec3 uPalRim[6];
uniform vec3 uMoonDir;
uniform mat3 uDrift;   // cloud frame → world
uniform float uBump;   // fine bump (value) strength
uniform vec3 uMist;    // the colour inside a cloud at the eye: puff surfaces right at the eye melt into it
uniform float uMask;   // debug: 1 = flat magenta (frame-coverage measurements)
uniform float uExact;  // per-pixel shape within this distance (m)
uniform float uLift;   // inside the air at night / dusk: a gain so the cloud body never sits darker than the sky behind it
uniform float uFogMin; // the white-out's fog far plane, floored for the puffs: a puff right ahead keeps its form
// Seen from inside the air, nearby clouds share the eye's (dip-aware) time of day, like the sky;
// clouds far from the eye, and every cloud seen from orbit, use their own.
uniform float uEyeSun, uAirSpace;
varying vec3 vWorld;
varying vec3 vLocal;
varying vec3 vCentre;
varying vec3 vClusterC;
varying vec2 vClusterR;
varying float vSquash;
varying float vHb;
varying float vRel;
varying float vReveal;
varying vec3 vNormalW;
varying vec3 vDir;
varying vec3 vUpP;
varying float vNear, vSeed;
varying float vSeam, vCreaseV;

void cloudPal(float e, out vec3 lit, out vec3 shade, out vec3 belly, out vec3 rim) {
  int i = 0;
  if (e > uPalE[1]) i = 1;
  if (e > uPalE[2]) i = 2;
  if (e > uPalE[3]) i = 3;
  if (e > uPalE[4]) i = 4;
  float t = clamp((e - uPalE[i]) / (uPalE[i + 1] - uPalE[i]), 0.0, 1.0);
  lit = mix(uPalLit[i], uPalLit[i + 1], t);
  shade = mix(uPalShade[i], uPalShade[i + 1], t);
  belly = mix(uPalBelly[i], uPalBelly[i + 1], t);
  rim = mix(uPalRim[i], uPalRim[i + 1], t);
}

// Gradient of two octaves of a smooth sine lattice (cloud frame): soft cauliflower texture.
const mat3 BM = mat3(0.8, 0.6, 0.0, -0.48, 0.64, 0.6, 0.36, -0.48, 0.8);
vec3 bumpGrad(vec3 p) {
  vec3 s = sin(p);
  vec3 c = cos(p);
  vec3 g = vec3(c.x * s.y * s.z, s.x * c.y * s.z, s.x * s.y * c.z);
  vec3 q = BM * p * 2.17 + 1.7;
  s = sin(q);
  c = cos(q);
  g += 0.3 * transpose(BM) * vec3(c.x * s.y * s.z, s.x * c.y * s.z, s.x * s.y * c.z);
  return g;
}

void main() {
  #ifdef LB_REVEAL_FADE
    if (vReveal < lbBayer4(gl_FragCoord.xy)) discard;
  #endif
  float cd = distance(vWorld, cameraPosition);
  if (uMask > 0.5) {
    gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
    return;
  }
  vec3 V = (cameraPosition - vWorld) / max(cd, 1e-3);
  vec3 up = normalize(vWorld);
  // The lobe normal (exact, per pixel), turned down onto the flat base.
  // Exact per pixel within ~110 m (clean band edges and creases); beyond, a puff is small on
  // screen and the per-vertex normal is enough.
  // Only triangles near a lobe seam need it (the interpolated normal jumps there); elsewhere the
  // per-vertex normal of the round lobes is exact enough.
  vec3 n;
  float vCrease = vCreaseV;
  if (cd < uExact && vSeam > 0.002) {
    vec3 nL;
    float seam;
    puffShape(normalize(vDir), normalize(vUpP), vSeed, vNear, nL, vCrease, seam);
    n = normalize(mat3(uDrift) * nL);
  } else n = normalize(vNormalW);
  vec3 n0 = normalize(vWorld - vCentre);
  // The cluster as one blob (its ellipsoid's normal here): with distance the bands follow the
  // puff and the whole cumulus more than each lobe, so a far cloud is lit as one mass instead of
  // a heap of little bubbles; up close the lobes carry it.
  vec3 upC = normalize(vClusterC);
  vec3 dc = vWorld - vClusterC;
  float dv = dot(dc, upC);
  vec3 nE = normalize((dc - upC * dv) / (vClusterR.x * vClusterR.x) + upC * (dv / (vClusterR.y * vClusterR.y)));
  // The lobes carry the shading within ~20 m; by 60 m the cloud is lit as one mass (puff + cluster
  // form), so mid-distance cumulus are cotton, not stacked translucent discs.
  float farK = smoothstep(8.0, 32.0, cd);
  // On the cluster's underside the form takes over almost entirely: seen from below a cumulus is
  // one even belly, not a honeycomb of puff bottoms with lit rims.
  // Likewise when the eye looks up at the cloud: what shows then is every puff's lower half.
  float under = max(smoothstep(0.1, -0.35, dot(nE, upC)), smoothstep(0.05, 0.45, dot(-V, upC)));
  // (The puff's own sphere normal jumps where one puff overlaps another: it fades too, or every
  // overlap draws a disc edge.)
  n = normalize(mix(n, normalize(n0 * mix(0.35, 0.1, farK) + nE), max(mix(0.25, 0.92, farK), 0.9 * under)));
  // The flat base, by height above it (continuous across the cluster's puffs, so seen from below
  // the belly is one face, not an oval per puff).
  float baseK = 1.0 - smoothstep(0.08, 1.3, vHb);
  n = normalize(mix(n, -up, smoothstep(0.2, 0.9, baseK)));

  // Time of day at this cloud.
  float eOwn = dot(normalize(vWorld + up * 6.0), lbSunDir);
  // From orbit, clouds deep in the night (far from the terminator) dim: moonlit cotton, but quieter
  // than the city's lights.
  float deepNight = (1.0 - smoothstep(-0.55, -0.22, eOwn)) * uAirSpace;
  // Inside the air a cloud is never more than a step darker than the eye's own sky (on a 160 m
  // planet a cloud 100 m away is ~36° further into the night: it hung as a navy storm blob in a
  // lilac dusk sky beside a peach one).
  float eFar = mix(max(eOwn, uEyeSun - 0.07), eOwn, uAirSpace);
  // Blended by the CLUSTER's distance (per fragment, each puff's near face and rim fell on
  // different sides of the blend: concentric mauve/cream ovals on every puff).
  float e = mix(uEyeSun, eFar, max(uAirSpace, smoothstep(50.0, 130.0, distance(vClusterC, cameraPosition))));
  vec3 litC, shadeC, bellyC, rimC;
  cloudPal(e, litC, shadeC, bellyC, rimC);
  // Light: the sun by day, the moon by night.
  float moonW = 1.0 - smoothstep(-0.12, -0.03, e);
  vec3 L = normalize(mix(lbSunDir, uMoonDir, moonW));

  // Two toon bands on the lobe normal; the edges widen as the light grazes the cloud (no candy
  // stripes at the terminator). The lit band is wide: from below, the sunlit half reads white.
  float soft = mix(0.02, 0.075, 1.0 - smoothstep(0.02, 0.3, abs(e)));
  float w = dot(n, L) * 0.5 + 0.5;
  float b1 = smoothstep(0.36 - soft, 0.36 + soft, w);
  float b2 = smoothstep(0.52 - soft, 0.52 + soft, w);
  vec3 shade = mix(bellyC, shadeC, smoothstep(0.0, 0.45, vRel));
  // Form inside the shade too: sky-facing lobes lift, the turn toward the light warms a little.
  shade *= 0.9 + 0.14 * (dot(n, up) * 0.5 + 0.5) + 0.05 * smoothstep(0.15, 0.36, w);
  // Inside the lit band a soft falloff keeps the form: lobes read even when the whole side faces
  // the sun.
  vec3 lit = mix(mix(shadeC, litC, 0.82), litC, smoothstep(0.58, 0.85, w));
  vec3 col = mix(shade, mix(shade, lit, 0.62), b1);
  col = mix(col, lit, b2);
  // The flat base: a darker, cooler face, so a side view never reads as a slice.
  // The flat base face, and a gradient into the belly colour over the lowest metres (by height
  // above the base, continuous across puffs): seen from below the puffs' flat discs and the curved
  // sides between them blend into one lavender underside instead of a pattern of ovals.
  float lowK = 1.0 - smoothstep(0.0, 4.5, vHb);
  col = mix(col, bellyC * vec3(0.93, 0.94, 0.99), lowK * lowK * 0.65);
  col = mix(col, bellyC * vec3(0.86, 0.88, 0.98), baseK * 0.45);
  // Lobe creases: a soft toon line of shade between bulges, so a puff reads as cotton up close.
  // Only where a lobe overhangs (its seam on the shaded or downward side): lit cotton stays clean,
  // the undersides of the lobes get a soft shade line.
  float overhang = (1.0 - smoothstep(0.3, 0.6, w)) * 0.7 + (1.0 - smoothstep(-0.3, 0.3, dot(n, up))) * 0.5;
  float crease = smoothstep(0.35, 0.85, vCrease) * min(1.0, overhang) * (1.0 - farK) * (1.0 - vSquash);
  col = mix(col, shade * 0.95, crease * 0.6);
  // Fine cotton texture as a faint value tweak only, fading with distance.
  float bk = uBump * (1.0 - smoothstep(30.0, 90.0, cd)) * (1.0 - vSquash);
  vec3 g = uDrift * bumpGrad(vLocal * 0.62);
  col *= 1.0 - 0.15 * bk * clamp(dot(g - dot(g, n) * n, L), -1.0, 1.0);
  // Backlit puffs glow through their shaded side (looking toward the sun the clouds are silver).
  float through = pow(max(dot(-V, L), 0.0), 4.0) * (1.0 - b2);
  col += rimC * through * 0.22 * (1.0 - moonW);

  // Cluster rim: where this puff's surface is at the edge of the whole cluster's silhouette.
  // By day a soft silver/golden edge; at night only a thin moon-side line (fresnel > 0.8).
  float edgeE = smoothstep(0.4, 0.88, 1.0 - abs(dot(nE, V)));
  float fr = 1.0 - clamp(dot(n0, V), 0.0, 1.0);
  float back = 0.25 + 0.75 * smoothstep(-0.2, 0.75, dot(-V, L));
  float dayRim = fr * fr * edgeE * edgeE * back * 0.45;
  // At night a silver fresnel rim over the whole moon-facing half of the cluster.
  float moonRim = (fr * fr * 0.55 + smoothstep(0.75, 0.92, fr) * 0.35) * smoothstep(-0.25, 0.35, dot(nE, L)) * (0.35 + 0.65 * edgeE);
  col += rimC * mix(dayRim, moonRim, moonW);

  // Right at the eye the surface melts into the mist the veil shows once inside: no hard sphere
  // edge across the white-out.
  // (Only in the last metres: until then the wall keeps its lit cap, bands and rim.)
  col = mix(col, uMist, 1.0 - smoothstep(1.0, 3.0, cd));
  col *= uLift * (1.0 - 0.35 * deepNight);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifdef USE_FOG
    // The scene fog, with its far plane floored: near the white-out the scene fog closes to a few
    // metres so the city fades into the mist, but a puff right ahead must keep its form.
    float fogF = smoothstep(fogNear, max(fogFar, uFogMin), vFogDepth);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogF);
  #endif
}`;

// The white-out: a full-screen overlay while the eye is inside a puff (or the mist slab). The scene
// itself is fogged by depth (the clouds system drives the scene fog toward the mist colour), so
// this adds the fill deep inside, with internal "shells" (soft lighter/darker masses streaming
// outward from the point the eye flies toward, so the inside of a cloud moves past instead of
// being a flat white card), and thin high-contrast wisps.
export const veilVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

export const veilFrag = /* glsl */ `
uniform float uAmount;
uniform float uWisp;
uniform vec3 uLit, uShade; // highlight and mist colours
uniform float uPhase;  // grows with the distance travelled: shells and wisps stream outward
uniform vec2 uFoe;     // screen point the eye is moving toward (uv)
uniform float uAspect;
uniform float uTime;
varying vec2 vUv;
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
void main() {
  vec2 d = (vUv - uFoe) * vec2(uAspect, 1.0);
  float r = length(d);
  vec2 dir = d / max(r, 1e-4);
  float s = log(r + 0.03);
  float ph = uPhase + uTime * 0.05;
  // Shells: big soft masses in (direction, log-radius), scrolling outward: perspective-correct for
  // cloud lumps flowing past the eye.
  // (Direction noise pinches into a pinwheel at the travel point: the shells fade out toward it.)
  float sh = noise3(vec3(dir * 1.6, s * 0.8 - ph * 0.55) + 7.3);
  sh = 0.65 * sh + 0.35 * noise3(vec3(dir * 3.4 + sh, s * 1.5 - ph * 0.9) + 2.2);
  float shell = mix(0.5, smoothstep(0.38, 0.72, sh), smoothstep(0.05, 0.4, r));
  // Wisps: domain-warped streaks, high frequency around the travel point, low along the rays.
  float warp = noise3(vec3(dir * 2.3, s * 0.9 - ph * 0.7) + 4.1);
  float n = noise3(vec3(dir * 5.5 + warp * 0.9, s * 1.2 - ph + warp * 0.6));
  n = 0.62 * n + 0.38 * noise3(vec3(dir * 12.0 + warp, s * 2.2 - ph * 1.7));
  float streak = smoothstep(0.55, 0.82, n) * smoothstep(0.04, 0.32, r);
  // Fill: closes fast once inside; a thin haze before. The shells thin it a little in their gaps
  // (the fogged scene behind is the same mist colour, so nothing reads through but motion).
  // Capped below opaque, the shells modulating it: the mist keeps moving lumps and the cluster's
  // other puffs show through as soft shapes, instead of a flat white card.
  float fill = smoothstep(0.5, 0.92, uAmount) * (0.66 + 0.2 * shell);
  float a = clamp(max(max(fill, uAmount * uAmount * 0.45), streak * uWisp), 0.0, 1.0);
  vec3 col = mix(uShade, uLit, clamp(vUv.y * 0.35 + 0.15 + shell * 0.55 + streak * 0.4 * uWisp, 0.0, 1.0));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Deep inside a cloud (veil ≈ 1) an opaque full-screen triangle at the near plane is drawn right
// after the sky: everything behind it fails the depth test, so the hidden scene costs no shading.
export const blockVert = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, -1.0, 1.0);
}`;

export const blockFrag = /* glsl */ `
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
