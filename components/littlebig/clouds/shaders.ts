// Cloud GLSL (A3, v2 S1): toon puffs and the falling-through-the-clouds overlay.

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
uniform vec4 uHole;    // the followed thing (world centre, radius; w = 0 off): puffs in front of it dissolve
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
  if (uHole.w > 0.0) {
    vec3 hd = (vWorld - cameraPosition) / max(cd, 1e-3);
    vec3 oc = uHole.xyz - cameraPosition;
    float ht = dot(oc, hd);
    if (ht > 0.0 && cd < ht + uHole.w * 0.5) {
      float keep = smoothstep(uHole.w * 1.05, uHole.w * 1.7, length(oc - hd * ht));
      if (keep < lbBayer4(gl_FragCoord.xy)) discard;
    }
  }
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
  float under = max((1.0 - smoothstep(-0.35, 0.1, dot(nE, upC))), smoothstep(0.05, 0.45, dot(-V, upC)));
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


// Falling through the clouds (v2, S1). See crossing.ts for the episode it draws.
//
// Cartoon puffs live in log-polar cells around the focus of expansion (the screen point the eye
// flies toward, kept within ~0.3 of the frame): (θ, ln r) is conformal, so a puff there grows with
// its distance from the focus (capped: never a wall-sized arc), and streaming the cells outward in
// ln r is exactly how lumps of cloud grow and rush past as the eye falls through them. Two layers
// (big near puffs over smaller far ones, streaming at different rates) give parallax. With the
// focus off-screen (climbing out of the city looking down and ahead) every on-screen log-polar cell
// is huge: a lateral set takes over, a staggered grid of puff-sized cells streaming across the frame
// from the focus's side, as dense as the dive's (S1f: the climb's hold was 3–4 puffs on a bare sheet).
//
// Each puff is ONE instanced screen-space sprite (crossPuffVert): the instance names a cell slot
// (layer, column, row slot); the vertex shader finds the world cell that slot shows this frame
// (rows scroll with the phase, so a puff keeps its look as it streams from slot to slot), its
// growth from the episode's fronts at its centre (the fill front and the opening hole are made of
// whole puffs growing and shrinking), its size, and its smear: each puff is drawn in its own frame
// (x out from the focus), stretched a little along the motion. Its shape is a cartoon cumulus of one
// of three kinds (a heap: a wide flat-bellied base with three round bumps on its top and a small lobe
// low on one side; a long low bank; a tower in tiers; an egg of one dome read as a balloon). The
// fragment shader draws its five toon domes: lit cap, lavender
// shade, a soft crease, a darker belly edge, and the 3D clouds' ink round the silhouette only (the
// overlay and the real cumulus it grows out of are one art style). A full-screen body
// (crossBodyFrag) fills behind them, its edges scalloped into round inked lumps with a shaded rim,
// and speed streaks (crossStreak*) rush outward over it and the far puffs, under the near ones.
//
// The fronts are measured in ON-SCREEN radius fractions (uRange: nearest screen point → farthest
// corner), so the fill and the opening always play out on screen; flying backward (uDir < 0) they
// are measured from the farthest corner instead (the cloud closes in like an iris and shrinks away
// into the focus of contraction).
//
// Depth: everything draws INSIDE the scene pass, last, over the scene whatever its depth (depth test
// 'always'), back to front (the body, the far puffs, the streaks, the near puffs, inner rows first),
// and writes ONE constant depth just short of the far plane where it is at least half opaque (the
// antialiased fringe below that is discarded; FXAA smooths the edge). So post, which reads depth for
// its ink, fog and night grade, sees one flat far plane: no hidden city inked over the clouds, no
// edge anywhere inside the overlay, the same grade everywhere. The thing the camera follows is then
// drawn again ON TOP (clouds/index.ts): its owner's scene objects re-drawn after the overlay,
// scissored to it, depth-tested against that far plane (so it is self-occluded and pixel-exact, and
// post inks its outline against the far plane like against the sky): no window, no porthole. A far
// subject also gets a POP target ring (crossMark*).
const CROSS_COMMON = /* glsl */ `
uniform float uFill;
uniform float uOpen;
uniform float uContact;
uniform float uDir;
uniform vec2 uRange;
uniform vec2 uFoe;
uniform float uAspect;
uniform vec2 uPhase;
uniform vec2 uLight;
uniform float uFade;
const float TAU = 6.2831853;
vec3 lbH3(vec2 p) {
  vec3 q = fract(p.xyx * vec3(0.1031, 0.103, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}
// Screen radius (height units, from the focus) → on-screen front fraction (from the farthest corner
// when flying backward).
float lbRR(float r) {
  float rr = (r - uRange.x) / max(uRange.y - uRange.x, 0.05);
  return uDir < 0.0 ? 1.0 - rr : rr;
}
// How far the episode has reached at front fraction rr (0 outside the fill or inside the hole).
float lbFront(float rr, float lagFill, float lagOpen, float soft) {
  float a = 1.0 - smoothstep(uFill - lagFill - soft, uFill - lagFill + soft, rr);
  float b = smoothstep(uOpen + lagOpen - soft, uOpen + lagOpen + soft, rr);
  return max(min(a, b), uContact);
}
`;

// The body's signed distance to its lumpy fronts at screen uv (front fractions, > 0 inside the
// cloud), shared by the body and the ring (drawn only where the body covers). r, th: polar
// coordinates round the focus (height units); rr: the front fraction there.
const CROSS_BODY_EDGE = /* glsl */ `
float lbBodyEdge(vec2 uv, out float r, out float th, out float rr) {
  vec2 d = (uv - uFoe) * vec2(uAspect, 1.0);
  r = max(length(d), 1e-4);
  rr = lbRR(r);
  th = 0.0;
  float hold = 0.08 + 0.4 * (1.0 - smoothstep(0.25, 0.85, uFill));
  // Well away from both fronts (most of the frame while it is covered) the lumps (≤ 0.14) cannot
  // reach: skip the angle and the hash, the body being a full-screen pass.
  float e0 = min(uFill - hold - rr, rr - uOpen - 0.06);
  if (abs(e0) > 0.16) return e0;
  th = atan(d.y, d.x);
  float range = max(uRange.y - uRange.x, 0.05);
  // Scalloped edges: round lumps of cloud along both fronts (a fixed count per turn, so they grow
  // with the front like the puffs do), sized per lump. The angle is warped (a smooth, monotonic,
  // periodic warp), so the lumps run from ~0.65× to ~2.2× the mean width round the turn, each as
  // tall as it is wide (evenly spaced, the last cloud shrinking into the focus read as a rosette),
  // with a second, finer octave of little lumps riding on them (with the focus far off the frame a
  // big lump is a wide flat arc, and arcs meeting in points read as a mountain range).
  float tw = th + 0.1 * sin(th * 3.0 + 1.3) + 0.05 * sin(th * 5.0 + 4.1);
  float dw = 1.0 + 0.3 * cos(th * 3.0 + 1.3) + 0.25 * cos(th * 5.0 + 4.1);
  float sx = tw / TAU * 17.0;
  float sf = fract(sx) * 2.0 - 1.0;
  float sh = lbH3(vec2(mod(floor(sx), 17.0), 7.0)).x;
  float bump = sqrt(max(0.0, 1.0 - sf * sf)) * (0.45 + 0.55 * sh) * min(0.1, 0.5 * TAU * r / 17.0 / range / dw);
  float sx2 = th / TAU * 53.0 + 0.37;
  float sf2 = fract(sx2) * 2.0 - 1.0;
  float sh2 = lbH3(vec2(mod(floor(sx2), 53.0), 11.0)).y;
  // (Only where the big lumps are wide on screen: round a small hole, 53 little lumps read as a
  // serrated tear.)
  bump += sqrt(max(0.0, 1.0 - sf2 * sf2)) * (0.4 + 0.6 * sh2) * min(0.04, 0.4 * TAU * r / 53.0 / range) * smoothstep(0.12, 0.26, TAU * r / 17.0 / dw);
  // Signed distances to the fill edge and to the hole's edge. (The body holds back while the fill is
  // young: puffs bloom first, the body fills in behind them; a bare scalloped disc at the focus read
  // as a sticker.)
  float eFill = uFill - hold + bump - rr;
  float eOpen = rr - (uOpen + 0.06 - bump);
  return min(eFill, eOpen);
}
`;

export const crossPuffVert = /* glsl */ `
${CROSS_COMMON}
uniform float uZ;      // NDC depth of the whole overlay (just short of the far plane)
uniform float uStretch; // the smear along the motion (0 still … ~1 at speed)
uniform float uLat;    // 0 radial (the focus in frame) … 1 lateral (the focus off-screen)
uniform vec2 uFlow;    // lateral: the on-screen flow direction (aspect units, unit), away from the focus
uniform vec2 uPhaseL;  // lateral: the rows' scroll along uFlow (height units; near, far)
uniform vec2 uRes;     // drawing-buffer size (px)
attribute vec4 aCell;  // layer (0 far, 1 near), column, row slot, mode (0 radial, 1 lateral, 2 cap)
varying vec2 vQ;       // dome space: the base dome has radius 1
varying vec4 vB1;      // bumps 1 and 2: centres
varying vec4 vB2;      // bumps 3 and 4: centres
varying vec4 vBR;      // 1 / bump radii
varying vec2 vBW;      // 1 / the base's half-width (1, or wider for a long bank), its top's height scale
varying vec3 vL3;      // the light in this puff's dome space
varying vec2 vL2;      // … and its screen-plane part
varying vec2 vLH;      // the puff's sky direction (unit; the light's, leaning per puff)
varying float vHaze;
varying float vPx;     // the puff's size on screen (px)
void main() {
  bool nearL = aCell.x > 0.5;
  float mode = aCell.w;
  vec2 F = uFoe * vec2(uAspect, 1.0);
  // The radial and lateral sets hand over puff by puff (each shrinks or grows at its own threshold:
  // the count on screen stays even while the focus leaves the frame or comes back).
  float tl = uLat * 1.3 - 0.15;
  vec3 h, h2;
  vec2 d;
  float rad0, wMode, g;
  if (mode < 0.5) {
    // Radial: log-polar cells round the focus (see top).
    float N = nearL ? 6.0 : 11.0;
    float ph = nearL ? uPhase.x : uPhase.y;
    float k = N / TAU;
    float Y = floor((-3.6 - ph) * k) + aCell.z;
    h = lbH3(vec2(aCell.y, Y) + (nearL ? 3.0 : 17.0));
    h2 = lbH3(vec2(Y, aCell.y) + (nearL ? 11.0 : 29.0));
    vec2 ctr = vec2(aCell.y, Y) + 0.25 + 0.5 * h.xy;
    float th = ctr.x / k;
    float rc = exp(ctr.y / k + ph);
    d = vec2(cos(th), sin(th)) * rc;
    // Size: conformal (∝ distance from the focus), varied per puff, floored near the focus and capped
    // toward the edges (a far-off focus once made every on-screen puff a frame-sized arc).
    rad0 = clamp((0.27 + 0.32 * h.z) * rc / k, nearL ? 0.05 : 0.032, nearL ? 0.13 + 0.1 * h2.y : 0.085 + 0.06 * h2.z);
    wMode = smoothstep(tl - 0.15, tl + 0.15, h2.x);
  } else if (mode < 1.5) {
    // Lateral: with the focus off-screen (climbing out of the city looking down and ahead, a bird
    // climbing) every on-screen log-polar cell was huge and the hold showed 3–4 puffs on a bare
    // lavender sheet. Here a staggered grid of puff-sized cells over the frame, in a frame along the
    // flow, rows scrolling with it: the same puffs, as dense as the dive's, streaming across.
    float sp = nearL ? 0.36 : 0.26;
    float ph = nearL ? uPhaseL.x : uPhaseL.y;
    vec2 fl = uFlow;
    vec2 gl = vec2(-fl.y, fl.x);
    vec2 c0 = -F;
    vec2 c1 = vec2(uAspect, 0.0) - F;
    vec2 c2 = vec2(0.0, 1.0) - F;
    vec2 c3 = vec2(uAspect, 1.0) - F;
    float a0 = min(min(dot(c0, fl), dot(c1, fl)), min(dot(c2, fl), dot(c3, fl))) - sp;
    float b0 = min(min(dot(c0, gl), dot(c1, gl)), min(dot(c2, gl), dot(c3, gl))) - sp;
    float Y = floor((a0 - ph) / sp) + aCell.z;
    float X = floor(b0 / sp) + aCell.y;
    h = lbH3(vec2(X, Y) + (nearL ? 5.0 : 23.0));
    h2 = lbH3(vec2(Y, X) + (nearL ? 13.0 : 31.0));
    float along = (Y + 0.2 + 0.6 * h.y) * sp + ph;
    float across = (X + 0.5 * mod(Y, 2.0) + 0.15 + 0.7 * h.x) * sp;
    d = fl * along + gl * across;
    rad0 = nearL ? 0.1 + 0.11 * h2.y : 0.065 + 0.055 * h2.z;
    // (Some cells empty, more of the far ones: gaps where the body and its speed streaks show,
    // wisps, not foam; and the overlay's cost is its overdraw.)
    wMode = (1.0 - smoothstep(tl - 0.15, tl + 0.15, h2.x)) * step(nearL ? 0.22 : 0.55, fract(h.x * 7.13 + h2.z * 3.71));
  } else {
    // Caps: flying backward the cloud closes in from the corners and its last gap (at the screen
    // point nearest the focus) shrank as a small scalloped porthole onto the city for a frame. Three
    // near puffs grow over that point as the fill nears its end.
    vec2 P = clamp(uFoe, vec2(0.0), vec2(1.0)) * vec2(uAspect, 1.0);
    float ang = aCell.y * 2.0944 + 0.6;
    d = P + vec2(cos(ang), sin(ang)) * 0.075 - F;
    h = lbH3(vec2(aCell.y, 3.0) + 41.0);
    h2 = lbH3(vec2(3.0, aCell.y) + 43.0);
    rad0 = 0.12 + 0.05 * h2.y;
    wMode = step(uDir, 0.0);
  }
  float rc = max(length(d), 1e-4);
  vec2 er = d / rc;
  vec2 et = vec2(-er.y, er.x);
  if (mode < 1.5) {
    // Growth from the fronts at the puff's centre (a little stagger per puff for a ragged front);
    // none right at the focus (a dot of popcorn there read as litter on the city). (The hole's front
    // a step outward and tighter than the fill's: puffs leave the hole before the body's lumpy edge
    // does, so none is left floating in it.)
    float thin = nearL ? 0.55 : 0.6;
    float rmin = nearL ? 0.12 : 0.1;
    g = smoothstep(h.z * thin, h.z * thin + 0.35, lbFront(lbRR(rc), 0.0, 0.07, 0.08)) * smoothstep(rmin, rmin * 2.0, rc);
  } else {
    float gFill = smoothstep(0.72, 0.95, uFill / 1.18);
    // (They leave with the puffs round them, not last: a cluster fading alone at the focus read
    // as a ghost.)
    float gOpen = smoothstep(uOpen + 0.07 - 0.08, uOpen + 0.07 + 0.08, lbRR(rc));
    g = max(min(gFill, gOpen), uContact);
  }
  // Each puff grows from nothing with the front and shrinks to nothing in the hole, never a dot left
  // behind.
  float rad = rad0 * (0.4 + 0.6 * g) * smoothstep(0.2, 0.55, g) * wMode;
  // Smeared along the motion: stretched out from the focus (more toward the edges, where the cloud
  // rushes past fastest, and with speed), slimmer across; squashed a little per puff. (Applied below,
  // once the puff's sky direction is known.)
  float sm = uStretch * smoothstep(0.1, 0.75, rc) * (0.55 + 0.6 * h.y);
  // The sky's light (screen space) in the puff's frame (x out from the focus).
  vec2 L = vec2(dot(uLight, er), dot(uLight, et));
  vL3 = normalize(vec3(L * 0.85, 0.42));
  // A cartoon cumulus, laid out in the sky's frame (u across, v toward the sky, leaning a little per
  // puff): a wide base with a flat belly (half-height 0.62 up, 0.5 down; one dome with a round top
  // read as an egg), three round bumps on its top (shoulders and a bigger crown, a scalloped
  // skyline) and a small lobe low on one side; placed and sized per puff, never the same twice.
  float lean = (h2.y - 0.5) * 0.6;
  vec2 lh = normalize(L + vec2(1e-4, 0.0));
  lh = vec2(lh.x * cos(lean) - lh.y * sin(lean), lh.x * sin(lean) + lh.y * cos(lean));
  // (u along lp = lh turned clockwise: the quad (u, v) keeps the screen's winding, not culled.)
  vec2 lp = vec2(lh.y, -lh.x);
  // The smear, a quarter as strong along the puff's own sky axis: above and below the focus the
  // motion runs up and down the cumulus, and stretched that way its flat belly and bumps turned
  // into a tall egg.
  float s = (0.9 + 0.2 * h2.x) * (1.0 + sm * mix(0.25, 1.0, lh.y * lh.y));
  float sg = h.x > 0.5 ? 1.0 : -1.0;
  vec2 u1 = vec2(-0.5 - 0.14 * h.z, 0.26 + 0.12 * h.y);
  vec2 u2 = vec2(0.22 * (h.y - 0.5), 0.4 + 0.14 * h2.z);
  vec2 u3 = vec2(0.48 + 0.16 * h2.x, 0.22 + 0.14 * h.z);
  vec2 u4 = vec2(sg * (0.86 + 0.08 * h2.x), 0.0);
  vec4 br = vec4(0.4 + 0.12 * h2.y, 0.52 + 0.14 * h.x, 0.4 + 0.14 * h2.x, 0.28 + 0.08 * h.z);
  // Three kinds of cumulus, so neighbours never share a silhouette (one template read as a sheet of
  // the same sticker): the heap above (~55 %), a long low bank (~30 %) and a tower in tiers (~15 %).
  float ty = fract(h.x * 7.13 + h2.y * 3.71 + h.z * 1.37);
  float bw = 1.0;
  float bh = 1.0;
  if (ty < 0.3) {
    // A long low bank: the base 45 % wider and a fifth lower, two small crowns between low shoulders.
    bw = 1.45;
    bh = 0.8;
    u1 = vec2(-0.95 - 0.1 * h.z, 0.12 + 0.08 * h.y);
    u2 = vec2(-sg * 0.3 + 0.1 * (h.y - 0.5), 0.3 + 0.1 * h2.z);
    u3 = vec2(0.95 + 0.1 * h2.x, 0.1 + 0.08 * h.z);
    u4 = vec2(sg * 0.38, 0.26 + 0.08 * h.y);
    br = vec4(0.32 + 0.08 * h2.y, 0.44 + 0.08 * h.x, 0.32 + 0.08 * h2.x, 0.4 + 0.06 * h.z);
  } else if (ty > 0.84) {
    // A tower in tiers: the base a little narrower, broad shoulders on it, a crown high on those (a
    // big crown straight on the base read as an egg).
    bw = 0.92;
    u1 = vec2(-0.52 - 0.08 * h.z, 0.38 + 0.08 * h.y);
    u2 = vec2(0.12 * (h.y - 0.5), 0.68 + 0.08 * h2.z);
    u3 = vec2(0.5 + 0.08 * h2.x, 0.36 + 0.08 * h.z);
    br.xyz = vec3(0.42 + 0.08 * h2.y, 0.5 + 0.06 * h.x, 0.42 + 0.08 * h2.x);
  }
  vBW = vec2(1.0 / bw, 1.0 / bh);
  vB1 = vec4(lp * u1.x + lh * u1.y, lp * u2.x + lh * u2.y);
  vB2 = vec4(lp * u3.x + lh * u3.y, lp * u4.x + lh * u4.y);
  vBR = 1.0 / br;
  vL2 = L;
  vLH = lh;
  vHaze = nearL ? 0.0 : 1.0;
  vPx = rad * 1.4 * uRes.y;
  // The sprite: a quad fitted round the base and the four bumps, in the sky's frame: ~30 % fewer
  // fragments than a round sprite, the overlay's cost being its blended overdraw.
  vec4 cu = vec4(u1.x, u2.x, u3.x, u4.x);
  vec4 cv = vec4(u1.y, u2.y, u3.y, u4.y);
  vec4 lo = min(cu - br, vec4(-bw));
  vec4 hi = max(cu + br, vec4(bw));
  vec2 bu = vec2(min(min(lo.x, lo.y), min(lo.z, lo.w)), max(max(hi.x, hi.y), max(hi.z, hi.w)));
  lo = min(cv - br, vec4(-0.5));
  hi = max(cv + br, vec4(0.62));
  vec2 bv = vec2(min(min(lo.x, lo.y), min(lo.z, lo.w)), max(max(hi.x, hi.y), max(hi.z, hi.w)));
  vec2 t01 = position.xy * 0.5 + 0.5;
  vQ = lp * (mix(bu.x, bu.y, t01.x) + position.x * 0.05) + lh * (mix(bv.x, bv.y, t01.y) + position.y * 0.05);
  // (× 1.4: the flat base covers less than the round dome did at the same radius.)
  vec2 o = vQ * 1.4 * rad;
  vec2 c = F + er * (rc + o.x * s) + et * (o.y * inversesqrt(s));
  gl_Position = rad > 1e-4 ? vec4(c.x / uAspect * 2.0 - 1.0, c.y * 2.0 - 1.0, uZ, 1.0) : vec4(3.0, 3.0, 3.0, 1.0);
}`;

// Shading contrast at dusk and night (uTone, from the CPU): the palette's stops sit close together in
// value there and the overlay went to one flat lilac sheet; the belly, rim and seams deepen as the
// lit colour darkens.
const CROSS_TONE = /* glsl */ `
uniform float uTone;
`;

export const crossPuffFrag = /* glsl */ `
uniform float uFade;
uniform vec3 uLit, uShade, uInk;
// Per frame on the CPU (uniform-only work kept off the fragments, the overlay's cost being its
// overdraw): the belly colour and the belly / seam / rim weights deepened by the dusk tone, and the
// body colour the far layer leans to.
uniform vec3 uBellyT, uRimK, uBodyC;
uniform vec2 uKBS;     // belly, seam weights
varying vec2 vQ;
varying vec4 vB1;
varying vec4 vB2;
varying vec4 vBR;
varying vec2 vBW;
varying vec3 vL3;
varying vec2 vL2;
varying vec2 vLH;
varying float vHaze;
varying float vPx;
void main() {
  // Five domes (1 − |q|²): the base and four bumps; the surface is the highest, the crease where the
  // two highest meet. The base is wide and flat: half-height 0.62 toward the sky, 0.5 below (its
  // flat belly); its normal leans with the squash.
  vec2 lp = vec2(-vLH.y, vLH.x);
  float bv = dot(vQ, vLH);
  float bk = bv > 0.0 ? vBW.y / 0.62 : 2.0;
  vec2 q0 = lp * (dot(vQ, lp) * vBW.x) + vLH * (bv * bk);
  vec2 q1 = (vQ - vB1.xy) * vBR.x;
  vec2 q2 = (vQ - vB1.zw) * vBR.y;
  vec2 q3 = (vQ - vB2.xy) * vBR.z;
  vec2 q4 = (vQ - vB2.zw) * vBR.w;
  float d0 = 1.0 - dot(q0, q0);
  float d1 = 1.0 - dot(q1, q1);
  float d2 = 1.0 - dot(q2, q2);
  float d3 = 1.0 - dot(q3, q3);
  float d4 = 1.0 - dot(q4, q4);
  float best = d0;
  float second = -1.0;
  vec2 n2 = q0;
  if (d1 > best) { second = best; best = d1; n2 = q1; } else second = max(second, d1);
  if (d2 > best) { second = best; best = d2; n2 = q2; } else second = max(second, d2);
  if (d3 > best) { second = best; best = d3; n2 = q3; } else second = max(second, d3);
  if (d4 > best) { second = best; best = d4; n2 = q4; } else second = max(second, d4);
  float fw = max(fwidth(best), 1e-4);
  if (best < fw * 0.95) discard;
  vec3 n = vec3(n2 * 0.9, sqrt(best));
  float lam = dot(n, vL3) * inversesqrt(dot(n, n));
  float side = dot(n2, vL2);
  // Two soft toon bands like the 3D puffs' (hard lavender crescents read as another style), a warm
  // rim on the sky side of each dome's edge, a soft crease where a lobe overlaps another on the
  // shaded side, a darker belly edge.
  vec3 col = mix(uShade, mix(uLit, uShade, 0.14 * clamp((0.85 - lam) * 2.0, 0.0, 1.0)), clamp((lam + 0.12) * 4.5, 0.0, 1.0));
  col = mix(col, uBellyT, clamp((-0.44 - lam) * 3.6, 0.0, 1.0) * uKBS.x);
  col += uRimK * (1.0 - clamp(best * 4.0, 0.0, 1.0)) * clamp((side - 0.3) * 1.67, 0.0, 1.0);
  float seam = (1.0 - clamp((best - second) * 20.0, 0.0, 1.0)) * step(0.0, second) * clamp((0.1 - side) * 2.0, 0.0, 1.0);
  col = mix(col, uBellyT, seam * uKBS.y * 0.7);
  col = mix(col, uBellyT * 0.9, (1.0 - clamp(best * 10.0, 0.0, 1.0)) * clamp((-0.2 - side) * 2.0, 0.0, 1.0) * 0.6);
  // The far layer sits a step back (a touch of the body's colour): depth, not mush.
  col = mix(col, uBodyC, 0.22 * vHaze);
  // Ink round the puff's silhouette only (~1.6 px inside its edge), the weight of post's line on the
  // 3D cumulus; lighter on the far layer. (No ink inside a puff: the creases between its lobes are
  // shade, not line; inked they read as bubbles stacked on bubbles.)
  // (A puff only a few pixels across, growing in or shrinking away, is not an ink dot.)
  float ink = (1.0 - clamp((best - fw * 1.5) / (fw * 1.4), 0.0, 1.0)) * (0.72 - 0.34 * vHaze) * smoothstep(4.0, 12.0, vPx);
  col = mix(col, uInk + col * 0.12, ink);
  gl_FragColor = vec4(col, clamp((best - fw * 0.6) / (fw * 0.7), 0.0, 1.0) * uFade * smoothstep(1.5, 5.0, vPx));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const crossBodyVert = /* glsl */ `
uniform float uZ;
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, uZ, 1.0);
}`;

export const crossBodyFrag = /* glsl */ `
${CROSS_COMMON}
${CROSS_BODY_EDGE}
${CROSS_TONE}
uniform vec3 uLit, uShade, uBelly, uInk;
varying vec2 vUv;
void main() {
  float r, th, rr;
  float e = lbBodyEdge(vUv, r, th, rr);
  float fe = clamp(fwidth(e), 1e-4, 0.02); // (clamped: e steps where lbBodyEdge skips the lumps)
  float a = max(smoothstep(-fe, fe * 0.5, e), uContact);
  if (a < 0.5) discard;
  float tb = uTone;
  vec3 col = mix(uShade, uLit, 0.6 + 0.16 * vUv.y - 0.1 * smoothstep(0.35, 1.0, rr));
  // A shaded rim inside each lump's edge: the cloud's belly, so the edge reads as a curved mass.
  float rim = (1.0 - smoothstep(0.0, 0.07, e)) * (1.0 - uContact);
  col = mix(col, uBelly * (1.0 - 0.1 * (tb - 1.0)), rim * min(0.9, 0.5 * tb));
  // Ink along the lumpy fronts (where no puff covers them), like the puffs' silhouettes.
  float ink = (1.0 - smoothstep(fe * 1.0, fe * 2.4, e)) * 0.6 * (1.0 - uContact);
  col = mix(col, uInk + col * 0.12, ink);
  gl_FragColor = vec4(col, a * uFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Speed streaks: soft tapered wisps rushing outward from the focus while the eye moves (one
// instanced quad each). Each lives in ln r like the puffs, born near the focus, gone past the
// farthest corner, its length growing with its distance (conformal, capped) and with speed. Drawn
// over the body and the far puffs, UNDER the near ones (mist streaming past between the layers of
// cloud), and only where the body covers (never across the scene in the hole or past the fill front).
export const crossStreakVert = /* glsl */ `
${CROSS_COMMON}
uniform float uStreak;
uniform vec2 uRes;
attribute vec3 aStreak; // angle (rad), phase offset, size (0..1)
varying vec2 vA;        // x: along (0 inner tip … 1 outer tip), y: across (−1 … 1)
varying vec2 vUv;
varying float vAlpha;
void main() {
  float life = fract(aStreak.y + uPhase.x * (0.2 + 0.12 * aStreak.z));
  float r = exp(mix(log(uRange.x + 0.1), log(uRange.y * 1.2), life));
  vec2 er = vec2(cos(aStreak.x), sin(aStreak.x));
  vec2 et = vec2(-er.y, er.x);
  float len = min(r * (0.3 + 0.4 * aStreak.z), 0.36 + 0.22 * aStreak.z) * (0.5 + 0.5 * uStreak);
  float w = (3.4 + 5.0 * aStreak.z) * (0.6 + 0.4 * smoothstep(0.1, 0.7, r)) / uRes.y;
  vec2 c = uFoe * vec2(uAspect, 1.0) + er * (r + (position.x - 0.5) * len) + et * (position.y * w);
  vA = vec2(position.x, position.y);
  vUv = vec2(c.x / uAspect, c.y);
  vAlpha = sin(3.14159 * life) * lbFront(lbRR(r), 0.0, 0.0, 0.08) * uFade * smoothstep(0.0, 0.35, uStreak) * smoothstep(0.08, 0.3, r);
  gl_Position = vAlpha > 0.004 ? vec4(c.x / uAspect * 2.0 - 1.0, c.y * 2.0 - 1.0, 0.0, 1.0) : vec4(3.0, 3.0, 3.0, 1.0);
}`;

export const crossStreakFrag = /* glsl */ `
${CROSS_COMMON}
${CROSS_BODY_EDGE}
uniform vec3 uLit, uShade;
varying vec2 vA;
varying vec2 vUv;
varying float vAlpha;
void main() {
  // A spindle: widest two thirds of the way out, tapering to both tips.
  float x = clamp(vA.x, 0.0, 1.0);
  float taper = pow(sin(3.14159 * pow(x, 0.75)), 0.8);
  float y = abs(vA.y) / max(taper, 1e-3);
  float fw = max(fwidth(vA.y), 1e-4) / max(taper, 1e-3);
  // Feathered across (a wisp, not a hairline: drawn hard over the far puffs it read as a scratch).
  float a = 1.0 - smoothstep(0.3, 1.0 + fw * 0.5, y);
  if (a <= 0.004) discard;
  // Only where the body covers, a little inside its lumpy edge.
  float r, th, rr;
  float e = lbBodyEdge(vUv, r, th, rr);
  float inB = max(smoothstep(0.01, 0.06, e), uContact);
  if (inB <= 0.004) discard;
  // White mist with a soft lavender underside, so it reads on the lit puffs and the shaded body alike.
  vec3 col = mix(uLit * 1.07, uShade * 0.9, smoothstep(0.1, 1.0, -vA.y / max(taper, 1e-3)) * 0.65);
  gl_FragColor = vec4(col, a * vAlpha * (0.35 + 0.6 * x) * inB);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// The POP target ring round a far followed thing (an amber band between two ink lines), only where
// the body covers (never over the scene in the hole). Its mesh also carries the re-draw of the thing
// (clouds/index.ts, onAfterRender): with the ring off (uMark.x = 0) the quad collapses to nothing.
export const crossMarkVert = /* glsl */ `
uniform vec4 uMark;    // x: the ring's opacity, y: its radius (px), z: its amber band (px), w: unused
uniform vec2 uMarkC2;  // the ring's centre (drawing-buffer px)
uniform vec2 uRes;
varying vec2 vUv;
void main() {
  // The full-screen triangle shrunk round the ring's bounding square (or to nothing).
  float ext = uMark.x > 0.0 ? uMark.y + uMark.z + 4.0 : 0.0;
  vec2 p = (uMarkC2 + position.xy * ext) / uRes * 2.0 - 1.0;
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

export const crossMarkFrag = /* glsl */ `
${CROSS_COMMON}
${CROSS_BODY_EDGE}
uniform vec4 uMark;
uniform vec2 uMarkC2;
uniform vec3 uMarkC;
uniform vec3 uInk;
varying vec2 vUv;
void main() {
  float dp = distance(gl_FragCoord.xy, uMarkC2);
  float hw = uMark.z * 0.5;
  float x = abs(dp - uMark.y);
  float ring = 1.0 - smoothstep(hw + 1.1, hw + 2.1, x);
  if (ring <= 0.0) discard;
  float r, th, rr;
  float e = lbBodyEdge(vUv, r, th, rr);
  float fe = clamp(fwidth(e), 1e-4, 0.02); // (clamped: e steps where lbBodyEdge skips the lumps)
  if (max(smoothstep(-fe, fe * 0.5, e), uContact) < 0.5) discard;
  float band = 1.0 - smoothstep(hw - 0.6, hw + 0.6, x);
  gl_FragColor = vec4(mix(uInk, uMarkC, band), ring * uMark.x);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
