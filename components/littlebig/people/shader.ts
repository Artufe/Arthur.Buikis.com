// People (B2): the toon patch that poses, animates and colours every person and dog in the vertex
// shader. One program for every people mesh (patch key 'people').
//
// Per instance (aAnim, written every frame): x = row in the look texture (+ 0.9 × near-eye fade),
// y = gait phase (rad, advanced by distance walked, so feet never slide), z = gait amount (0
// standing … 1 walking) + 2 × round(31 × warm lamp light), w = head yaw (rad, + = turn left).
// Per person (the look texture uPpl, RGBA8, 5 texels a row, sRGB): skin|hairStyle, shirt|flags lo,
// legs|flags hi, hair|pose, accessory|bounce. Dogs: fur, patch, collar.
// Which parts a person shows and how each is coloured is the table PT (one ivec4 per part).
// Joints rotate about pivots from figure.ts J; normals turn with them. Poses: walk (gait from aAnim),
// sit (bench), stand (chatting: one hand talks, the head nods), café (a sip now and then), lean (on
// the fountain rim); an umbrella, phone or leash fixes an arm, a shoulder bag pushes the left arm
// out; brows tilt per person; torso width varies per person (arms and legs move out with it).
// The GLSL carries no comments or indentation: it ships as text. PP_COLOR (set on the colour
// material only; three defines DEPTH_PACKING for the fragment stage alone) guards the normal
// rebuild, which the depth program lacks.
// v2 (L1): uPpRide is the look row of the walker whose eyes the camera rides (−1: none): its head,
// face and hair (and the backpack, whose straps would poke up beside the missing neck) are hidden
// in the colour pass only, so its shadow keeps its head.

import type { Texture } from 'three';
import type { ToonPatch } from '../render/toon';
import { J, P, POSE_LEASH, POSE_PHONE, POSE_UMBRELLA } from './figure';

const f = (n: number) => n.toFixed(4);
const ALL = 63;
// Per part: colour (low 3 bits; the high bits are the alternative when a flag in w is set; 0 white,
// 1 skin, 2 shirt, 3 legs, 4 hair, 5 accessory), hair styles it shows for (bit mask), flags it
// needs, flags that switch the colour.
const PT = [
  [2, ALL, 0, 0], // torso
  [19, ALL, 0, 8], // hips: legs, dress → shirt
  [11, ALL, 0, 8], // thigh: legs, dress → skin
  [11, ALL, 0, 40], // shin: legs, dress or shorts → skin
  [0, ALL, 0, 0], // shoe
  [2, ALL, 0, 0], // upper arm
  [10, ALL, 0, 16], // forearm: shirt, short sleeves → skin
  [1, ALL, 0, 0], // hand
  [1, ALL, 0, 0], // head
  [0, ALL, 0, 0], // eye
  [4, ALL, 0, 0], // brow
  [0, ALL, 512, 0], // blush
  [4, 22, 0, 0], // cap: short, bun, hat
  [4, 14, 0, 0], // fringe: short, bun, long
  [4, 4, 0, 0], // bun
  [4, 8, 0, 0], // long
  [5, 16, 0, 0], // hat
  [4, 32, 0, 0], // afro
  [4, 62, 0, 0], // far-LOD hair
  [2, ALL, 8, 0], // skirt
  [5, ALL, 1, 0], // bag
  [5, ALL, 2, 0], // backpack
  [5, ALL, 4, 0], // umbrella
  [0, ALL, 4, 0], // pole
  [0, ALL, 256, 0], // phone
];

const PARS = /* glsl */ `
attribute float aPart;
attribute vec4 aAnim;
uniform sampler2D uPpl;
uniform float uPpRide;
varying float vPpVis;
varying float vPpLit;
const ivec4 PT[${PT.length}] = ivec4[](${PT.map((a) => `ivec4(${a})`).join()});
vec3 ppRx(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c); }
vec3 ppRy(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }
vec3 ppRz(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z); }
vec3 ppLin(vec3 c) { return pow(c, vec3(2.2)); }
float ppHash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
`;
const VERT = /* glsl */ `
vPpVis = 1.0;
vPpLit = 0.0;
#ifdef USE_INSTANCING
{
float rowF = floor(aAnim.x + 0.001);
int row = int(rowF);
vPpVis = 1.0 - (aAnim.x - rowF) / 0.9;
vec4 t0 = texelFetch(uPpl, ivec2(0, row), 0);
vec4 t1 = texelFetch(uPpl, ivec2(1, row), 0);
vec4 t2 = texelFetch(uPpl, ivec2(2, row), 0);
vec4 t3 = texelFetch(uPpl, ivec2(3, row), 0);
vec4 t4 = texelFetch(uPpl, ivec2(4, row), 0);
int part = int(aPart + 0.5);
float ph = aAnim.y;
float litQ = floor(aAnim.z * 0.5);
vPpLit = litQ / 31.0;
float amp = aAnim.z - 2.0 * litQ;
float idle = 1.0 - clamp(amp * 1.5, 0.0, 1.0);
float seed = ppHash(rowF + 0.37);
float tt = lbTime + seed * 61.0;
float s1 = sin(ph);
float c1 = cos(ph);
vec3 p = position;
vec3 n = normal;
vec3 col = vec3(1.0);
bool hide = false;
float side = p.x >= 0.0 ? 1.0 : -1.0;
if (part >= ${P.DOG_BODY}) {
vec3 fur = ppLin(t0.rgb);
col = fur;
if (part == ${P.DOG_LEG}) {
float front = p.z > -0.02 ? 1.0 : -1.0;
float a = amp * 0.75 * s1 * side * front;
vec3 pv = vec3(side * 0.078, 0.3, front * 0.165 - 0.02);
p = pv + ppRx(p - pv, -a);
n = ppRx(n, -a);
} else if (part == ${P.DOG_TAIL}) {
vec3 pv = vec3(0.0, 0.37, -0.27);
float w = sin(lbTime * (11.0 + 5.0 * idle) + seed * 9.0) * (0.35 + 0.35 * idle);
p = pv + ppRy(p - pv, w);
n = ppRy(n, w);
} else if (part != ${P.DOG_BODY}) {
vec3 pv = vec3(0.0, 0.42, 0.18);
if (part == ${P.DOG_EAR}) {
vec3 ev = vec3(side * 0.09, 0.53, 0.25);
float fa = side * (0.25 * amp * s1 * s1 + 0.1 * sin(tt * 2.0));
p = ev + ppRz(p - ev, fa);
n = ppRz(n, fa);
}
float yaw = aAnim.w + idle * 0.5 * sin(tt * 0.4) * sin(tt * 0.17);
float pitch = idle * (0.32 * smoothstep(0.2, 0.9, sin(tt * 0.33))) - amp * 0.05 * c1;
p = pv + ppRx(ppRy(p - pv, yaw), pitch);
n = ppRx(ppRy(n, yaw), pitch);
if (part == ${P.DOG_COLLAR}) col = ppLin(t2.rgb);
else if (part == ${P.DOG_EAR} || part == ${P.DOG_SNOUT}) col = ppLin(t1.rgb);
else if (part == ${P.DOG_DARK}) col = vec3(1.0);
}
p.y += amp * 0.022 * cos(2.0 * ph);
} else {
int hs = int(t0.a * 255.0 + 0.5);
int fl = int(t1.a * 255.0 + 0.5) | (int(t2.a * 255.0 + 0.5) << 8);
int pose = int(t3.a * 255.0 + 0.5);
float bounce = t4.a;
bool kid = (fl & 64) != 0;
bool sitting = pose == 1 || pose == 3;
ivec4 pt = PT[part];
hide = ((pt.y >> hs) & 1) == 0 || (fl & pt.z) != pt.z || (sitting && part == ${P.SKIRT});
#ifdef PP_COLOR
if (abs(rowF - uPpRide) < 0.5 && ((part >= ${P.HEAD} && part <= ${P.HAIRF}) || part == ${P.BACKPACK})) hide = true;
#endif
float hipA = 0.0, kneeA = 0.0, shA = 0.0, elA = 0.0, abd = 0.08;
float bob = 0.0, roll = 0.0, twist = 0.0, lean = 0.0;
float yaw = aAnim.w, pitch = 0.0;
if (!sitting) {
float A = 0.5 * amp;
float b = 0.55 + bounce;
hipA = A * s1 * side;
kneeA = amp * (0.1 + 0.8 * max(0.0, c1 * side));
shA = -0.85 * A * s1 * side;
elA = 0.2 + 0.32 * amp + 0.15 * amp * max(0.0, -s1 * side);
bob = amp * 0.034 * b * cos(2.0 * ph) + idle * 0.005 * sin(tt * 1.9);
roll = amp * 0.05 * b * s1 + idle * 0.022 * sin(tt * 0.5);
twist = amp * 0.15 * s1;
lean = amp * 0.06;
yaw += idle * 0.4 * sin(tt * 0.29) * sin(tt * 0.11 + 1.0);
float g = pow(max(0.0, sin(tt * 0.7)), 2.0);
if (pose == 2 && side == (seed > 0.5 ? 1.0 : -1.0)) {
shA = 0.55 * g;
elA = 0.2 + 1.25 * g + 0.18 * g * sin(tt * 7.0);
abd = 0.08 + 0.2 * g;
}
if (pose == 2) pitch = 0.07 * sin(tt * 2.3) * (0.4 + g);
if (pose == 4) {
lean = 0.42;
shA = 1.05;
elA = 0.35 + 0.1 * sin(tt * 1.3 + side);
abd = 0.2;
pitch = 0.3;
yaw *= 0.5;
}
} else {
hipA = 1.22;
kneeA = 1.18 + (kid ? 0.35 * sin(tt * 3.1 + side * 1.6) : 0.1 * sin(tt * 0.7 + side));
shA = pose == 1 ? 0.35 : 0.7;
elA = pose == 1 ? 0.85 : 1.05;
lean = pose == 1 ? -0.05 : 0.12;
bob = 0.004 * sin(tt * 1.7);
yaw += 0.45 * sin(tt * 0.23) * sin(tt * 0.09 + 2.0);
pitch = 0.06 * sin(tt * 1.3) + (pose == 3 ? 0.08 : 0.0);
if (pose == 3 && side < 0.0) {
float g = smoothstep(0.6, 0.9, sin(tt * 0.45));
shA += 0.2 * g;
elA += 0.75 * g;
}
}
if ((fl & 4) != 0 && side < 0.0) { shA = ${f(POSE_UMBRELLA[0])}; elA = ${f(POSE_UMBRELLA[1])}; abd = 0.0; }
if ((fl & 256) != 0 && side < 0.0) { shA = ${f(POSE_PHONE[0])}; elA = ${f(POSE_PHONE[1])}; abd = 0.0; pitch += 0.42; yaw *= 0.2; }
if ((fl & 128) != 0 && side > 0.0) { shA = ${f(POSE_LEASH[0])} + 0.06 * s1 * amp; elA = ${f(POSE_LEASH[1])}; abd = 0.12; }
if ((fl & 1) != 0 && side > 0.0 && !sitting) abd += 0.14;
if (part == ${P.BROW}) {
vec3 bc = vec3(side * 0.075, ${f(J.headY + 0.05)}, 0.188);
float bt = (ppHash(rowF + 5.1) - 0.45) * 0.8;
p = bc + ppRz(p - bc, side * bt);
p.y += 0.012 * max(0.0, -bt);
}
if (part >= ${P.HEAD} && part <= ${P.HAIRF}) {
vec3 neck = vec3(0.0, ${f(J.neckY)}, 0.0);
if (kid) p = neck + (p - neck) * 1.22;
p = neck + ppRx(ppRy(p - neck, yaw), -pitch);
n = ppRx(ppRy(n, yaw), -pitch);
}
if (part == ${P.FORE} || part == ${P.HAND}) {
vec3 ev = vec3(side * ${f(J.armX)}, ${f(J.elbowY)}, 0.0);
p = ev + ppRx(p - ev, -elA);
n = ppRx(n, -elA);
}
if (part >= ${P.UPPER} && part <= ${P.HAND}) {
vec3 sv = vec3(side * ${f(J.armX)}, ${f(J.shoulderY)}, 0.0);
p = sv + ppRz(ppRx(p - sv, -shA), side * abd);
n = ppRz(ppRx(n, -shA), side * abd);
}
if (part == ${P.SHIN} || part == ${P.SHOE}) {
vec3 kv = vec3(side * ${f(J.legX)}, ${f(J.kneeY)}, 0.0);
p = kv + ppRx(p - kv, kneeA);
n = ppRx(n, kneeA);
}
if (part >= ${P.THIGH} && part <= ${P.SHOE}) {
vec3 hv = vec3(side * ${f(J.legX)}, ${f(J.hipY)}, 0.0);
p = hv + ppRx(p - hv, -hipA);
n = ppRx(n, -hipA);
}
if (part == ${P.TORSO} || (part >= ${P.UPPER} && part <= ${P.HAIRF}) || part >= ${P.BAG}) {
vec3 wv = vec3(0.0, ${f(J.waistY)}, 0.0);
p = wv + ppRx(ppRy(p - wv, twist), -lean);
n = ppRx(ppRy(n, twist), -lean);
}
if (part == ${P.SKIRT}) {
float hem = clamp((0.8 - p.y) / 0.4, 0.0, 1.0);
p.z += hem * amp * 0.035 * s1 * clamp(p.x * 12.0, -1.0, 1.0);
p.xz *= 1.0 + hem * amp * 0.05 * abs(s1);
}
float w = 0.9 + 0.26 * ppHash(rowF + 0.71);
if (part <= ${P.HIPS} || part == ${P.SKIRT} || part == ${P.BAG} || part == ${P.BACKPACK}) p.x *= w;
else if (part >= ${P.UPPER} && part <= ${P.HAND}) p.x += side * ${f(J.armX)} * (w - 1.0);
else if (part >= ${P.UMB}) p.x -= ${f(J.armX)} * (w - 1.0);
else if (part <= ${P.SHOE}) p.x += side * ${f(J.legX)} * (w - 1.0);
p = ppRz(p, roll);
n = ppRz(n, roll);
p.y += bob;
vec3 cs[6] = vec3[](vec3(1.0), ppLin(t0.rgb), ppLin(t1.rgb), ppLin(t2.rgb), ppLin(t3.rgb), ppLin(t4.rgb));
int c = (fl & pt.w) != 0 ? pt.x >> 3 : pt.x & 7;
if (sitting && part == ${P.THIGH} && (fl & 8) != 0) c = 2;
col = cs[c];
}
float lbRevScale = 1.0;
#if (defined(LB_REVEAL_INSTANCE) || defined(LB_REVEAL_OBJECT)) && !defined(LB_REVEAL_FADE)
lbRevScale = lbSpring(vLbReveal);
#endif
transformed = hide ? vec3(0.0) : p * lbRevScale;
#ifdef USE_COLOR
vColor.rgb *= col;
#endif
#if defined(PP_COLOR) && !defined(FLAT_SHADED)
{
vec3 lbN = n;
mat3 lbIm = mat3(instanceMatrix);
lbN /= vec3(dot(lbIm[0], lbIm[0]), dot(lbIm[1], lbIm[1]), dot(lbIm[2], lbIm[2]));
lbN = lbIm * lbN;
transformedNormal = normalMatrix * lbN;
vNormal = normalize(transformedNormal);
}
#endif
}
#endif
`;

// Near-eye dither (aAnim.x's fraction): someone right in front of a street-level eye fades out
// instead of filling the frame; their shadow fades with them. Lamp light: a warm fill on people
// standing in a street lamp's pool at night (the CPU writes how much).
const FRAG_PARS = 'varying float vPpVis;\nvarying float vPpLit;';
const DISCARD = 'if (vPpVis < lbBayer4(gl_FragCoord.xy)) discard;';
const FRAG = `${DISCARD}\noutgoingLight += diffuseColor.rgb * vec3(1.0, 0.68, 0.36) * (0.85 * vPpLit);`;

export function peoplePatch(tex: Texture, ride: { value: number }): ToonPatch {
  return { key: 'people', vertexPars: PARS, vertex: VERT, fragmentPars: FRAG_PARS, fragment: FRAG, depthFragment: DISCARD, uniforms: { uPpl: { value: tex }, uPpRide: ride } };
}
