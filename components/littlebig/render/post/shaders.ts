// GLSL for the post pipeline (render/post/index.ts). Every pass is one full-screen triangle; each
// extra dependent pass costs ~1 ms on a busy GPU whatever its size, so there are at most four:
//
//   scene      ─► HDR colour (half float on high, sRGB8 on low; MSAA only as an opt-in) + depth
//   quarter    colour → ¼ res: the night bloom source (thresholded on warmth by the night factor at
//              each pixel) with hardware mips as the blur pyramid. Only while lit windows can be in
//              view.
//   composite  colour + ink (depth) + tilt-shift (a 13-tap disc of the scene colour, in the blurred
//              bands only) + bloom (¼ mips, bicubic) + sun glow
//              (analytic) → Neutral tone map → grade → sRGB + dither (+ luma in alpha for FXAA)
//   fxaa       (high) edge AA on the finished image, ink lines included
//
// The GLSL carries no comments (they would ship in the bundle): the rationale lives here.

import { LB_COMMON_GLSL } from '../toon';

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// World position of a depth-buffer sample (works with the camera's off-axis lens shift).
const WORLD_POS = /* glsl */ `
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
vec3 lbWorldAt(vec2 uv, float d) {
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return (uCamWorld * vec4(v.xyz / v.w, 1.0)).xyz;
}
`;

// The warmth measure on CHROMA, not raw RGB: white and grey score 0, the window amber
// (1, .55, .22) ≈ 0.86, #FFB84D ≈ 1, anything the moon lights (blue) < 0. Scales with intensity.
const WARM = 'vec3(1.0, 0.25, -1.25)';

/**
 * ¼-res bloom prefilter (GLSL3). Four bilinear taps cover the 4×4 source block. Bloom: each
 * tap is thresholded BEFORE averaging (a 2-px window keeps its energy instead of drowning in its
 * surroundings) and Karis-weighted (a lone spark cannot flicker). The threshold follows the night
 * factor at the pixel, so the daylit city never blooms; by night the measure is warmth (above), so
 * moonlit ground, clouds, white walls and sunlit contrails never bloom however low the threshold.
 * The gain lifts 1-px windows seen from orbit; the per-pixel cap (uCap) then keeps any emitter
 * bigger than a few pixels (a balloon lantern, a lit facade) from blooming into a disc.
 */
export const PREFILTER_FRAG = /* glsl */ `
${LB_COMMON_GLSL}
${WORLD_POS}
layout(location = 0) out highp vec4 oBloom;
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform vec2 uPx;
uniform vec4 uThresh;
uniform float uCap;
in vec2 vUv;
vec3 lbTap(vec2 o) {
  vec3 c = min(max(textureLod(tSrc, vUv + uPx * o, 0.0).rgb, vec3(0.0)), vec3(64.0));
  return c.r + c.g + c.b < 1e3 ? c : vec3(0.0);
}
vec3 lbBright(vec3 c, vec3 wt, float t, float k, inout float kw) {
  float br = max(dot(c, wt), 0.0);
  float soft = clamp(br - t + k, 0.0, 2.0 * k);
  soft = soft * soft / (4.0 * k);
  c *= max(soft, br - t) / max(br, 1e-4);
  float w = 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)));
  kw += w;
  return c * w;
}
void main() {
  vec3 c0 = lbTap(vec2(-1.0, -1.0));
  vec3 c1 = lbTap(vec2(1.0, -1.0));
  vec3 c2 = lbTap(vec2(-1.0, 1.0));
  vec3 c3 = lbTap(vec2(1.0, 1.0));
  float d = texture(tDepth, vUv).x;
  float n = d < 1.0 ? smoothstep(0.15, 0.85, lbNightAt(lbWorldAt(vUv, d))) : 0.0;
  float t = mix(uThresh.x, uThresh.y, n);
  float k = max(uThresh.z * t, 1e-4);
  vec3 wt = mix(vec3(0.2126, 0.7152, 0.0722), ${WARM}, n);
  float kw = 0.0;
  vec3 s = lbBright(c0, wt, t, k, kw) + lbBright(c1, wt, t, k, kw) + lbBright(c2, wt, t, k, kw) + lbBright(c3, wt, t, k, kw);
  s = s / kw * mix(1.0, uThresh.w, n);
  float m = max(s.r, max(s.g, s.b));
  oBloom = vec4(s * min(1.0, uCap / max(m, 1e-4)), 1.0);
}
`;

/**
 * The composite: ink → tilt-shift → night grade → bloom + sun glow → tone map → grade → sRGB.
 *
 * Ink (BRIEF §3) is found on the depth buffer: w = 1/z is affine in screen space on any plane (also
 * with the off-axis lens shift), so its second difference is zero on flat surfaces and spikes at
 * silhouettes and creases. Normalising the slope change by the slopes makes it scale-free: a facet
 * crease on grazing ground stays quiet while a wall meeting the street or any silhouette inks. The
 * sign says which side of an edge a pixel is on (Δ²w < 0: the nearer side); the far side gets uInk.w
 * of the weight (full weight when it is sky: outer contours read bolder), so lines are ~1.5 px.
 *
 * Persistence: the measure is taken on a ±1 and a ±2 px stencil and the line is min(e1, e2). A real
 * silhouette persists two pixels out; a 1-px feature (a dither dot of an LOD or personal-space fade,
 * a hole, a 1-px leash) does not, so dither screens never ink and their neighbours don't either. A
 * pixel that differs from both neighbours the same way (a local spike) is suppressed outright.
 *
 * Clouds: above the town (> 30 m) interior edges between two pieces of geometry need a 3× bigger
 * relative depth step, so overlapping puffs don't crack into patchy hairlines; the outer contour
 * (against the sky) keeps its full weight.
 *
 * Output: sRGB-encoded with ±½ LSB triangular dither; alpha carries the luma for the FXAA pass
 * when uAlphaLuma is set (the canvas gets alpha 1).
 */
export const COMPOSITE_FRAG = /* glsl */ `
#include <packing>
${LB_COMMON_GLSL}
${WORLD_POS}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tBloom;
uniform vec2 uPx;
uniform float uInkPx;
uniform float uNear;
uniform float uFar;
uniform vec4 uInk;
uniform vec2 uInkEdge;
uniform vec3 uInkColor;
uniform vec2 uFogRange;
uniform vec4 uTilt;
uniform float uBloom;
uniform vec4 uBloomW;
uniform vec4 uSun;
uniform float uSunLow;
uniform float uExposure;
uniform vec4 uGrade;
uniform vec3 uShadowTint;
uniform vec3 uNightDim;
uniform float uAlphaLuma;
uniform int uDebug;
varying vec2 vUv;

float lbW(float d) {
  return -1.0 / perspectiveDepthToViewZ(min(d, 1.0), uNear, uFar);
}
float lbD(vec2 uv) {
  return texture2D(tDepth, uv).x;
}

vec3 lbNeutral(vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}

vec3 lbCubic(sampler2D t, vec2 uv, int lod) {
  vec2 ts = vec2(textureSize(t, lod));
  vec2 st = uv * ts - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / ts;
  vec2 h1 = (i + 1.5 + w3 / g1) / ts;
  float l = float(lod);
  return g0.y * (g0.x * textureLod(t, vec2(h0.x, h0.y), l).rgb + g1.x * textureLod(t, vec2(h1.x, h0.y), l).rgb)
       + g1.y * (g0.x * textureLod(t, vec2(h0.x, h1.y), l).rgb + g1.x * textureLod(t, vec2(h1.x, h1.y), l).rgb);
}

float lbEdge(float wl, float wc, float wr, float k, out float sgn) {
  float gl = wc - wl;
  float gr = wr - wc;
  float d2 = gr - gl;
  sgn = d2;
  float spike = gl * gr < 0.0 ? min(abs(gl), abs(gr)) / max(max(abs(gl), abs(gr)), 1e-9) : 0.0;
  return abs(d2) / (abs(gl) + abs(gr) + k * wc) * (1.0 - smoothstep(0.25, 0.6, spike));
}
float lbAxis(float d2l, float dl, float dc, float dr, float d2r, float k, float far, out float wn) {
  float w2l = lbW(d2l), wl = lbW(dl), wc = lbW(dc), wr = lbW(dr), w2r = lbW(d2r);
  wn = max(wc, max(wl, wr));
  float s1, s2;
  float e = min(lbEdge(wl, wc, wr, k, s1), lbEdge(w2l, wc, w2r, k, s2));
  return smoothstep(uInkEdge.x, uInkEdge.y, e) * (s1 < 0.0 ? 1.0 : far);
}

void main() {
  vec2 uv = vUv;
  vec3 col = textureLod(tColor, uv, 0.0).rgb;
  float nanPx = 0.0;
  if (!(col.r + col.g + col.b < 1e3)) {
    nanPx = 1.0;
    col = textureLod(tColor, uv + vec2(uPx.x, 0.0), 0.0).rgb;
    if (!(col.r + col.g + col.b < 1e3)) col = textureLod(tColor, uv - vec2(uPx.x, 0.0), 0.0).rgb;
    if (!(col.r + col.g + col.b < 1e3)) col = textureLod(tColor, uv + vec2(0.0, uPx.y), 0.0).rgb;
    if (!(col.r + col.g + col.b < 1e3)) col = vec3(0.0);
  }
  col = min(max(col, vec3(0.0)), vec3(64.0));
  float depth = lbD(uv);
  vec3 wp = depth < 1.0 ? lbWorldAt(uv, depth) : vec3(0.0);
  float hgt = depth < 1.0 ? length(wp) - uNightDim.y : 1e4;

  float ink = 0.0;
  if (uInk.x > 0.0) {
    vec2 o = uPx * uInkPx;
    float dl = lbD(uv - vec2(o.x, 0.0)), dr = lbD(uv + vec2(o.x, 0.0));
    float dd = lbD(uv - vec2(0.0, o.y)), du = lbD(uv + vec2(0.0, o.y));
    float d2l = lbD(uv - vec2(2.0 * o.x, 0.0)), d2r = lbD(uv + vec2(2.0 * o.x, 0.0));
    float d2d = lbD(uv - vec2(0.0, 2.0 * o.y)), d2u = lbD(uv + vec2(0.0, 2.0 * o.y));
    bool sky = depth >= 1.0;
    bool anySky = sky || max(max(dl, dr), max(dd, du)) >= 1.0;
    float k = uInk.z * (!anySky && hgt > 30.0 ? 3.0 : 1.0);
    float far = sky ? 1.0 : uInk.w;
    float wx, wy;
    float ix = lbAxis(d2l, dl, depth, dr, d2r, k, far, wx);
    float iy = lbAxis(d2d, dd, depth, du, d2u, k, far, wy);
    float zn = 1.0 / max(wx, wy);
    float r = zn / uInk.y;
    ink = max(ix, iy) * uInk.x / (1.0 + r * r) * (1.0 - smoothstep(uFogRange.x, uFogRange.y, zn));
  }

  float tilt = 0.0;
  if (uTilt.x > 0.001) {
    tilt = smoothstep(uTilt.z, uTilt.z + 0.3, abs(uv.y - uTilt.y)) * uTilt.x;
    if (tilt > 0.002) {
      float r = (exp2(tilt * uTilt.w) - 1.0) * 2.4 * uInkPx;
      vec3 b = col;
      float n = 1.0;
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 2.39996;
        vec3 c = textureLod(tColor, uv + vec2(cos(a), sin(a)) * (r * sqrt((float(i) + 0.5) / 12.0)) * uPx, 0.0).rgb;
        if (c.r + c.g + c.b < 1e3) {
          b += min(max(c, vec3(0.0)), vec3(64.0));
          n += 1.0;
        }
      }
      col = b / n;
      ink *= 1.0 - smoothstep(0.0, 0.3, tilt);
    }
  }

  if (uNightDim.x < 0.999 && depth < 1.0) {
    float n = smoothstep(0.2, 0.9, lbNightAt(wp)) * (1.0 - smoothstep(26.0, 36.0, hgt));
    float warm = smoothstep(0.03, 0.3, dot(col, ${WARM}));
    col *= mix(1.0, mix(uNightDim.x, 1.0, warm), n);
  }

  col = mix(col, uInkColor + col * 0.12, ink);

  vec3 bloom = vec3(0.0);
  if (uBloom > 0.0) {
    float w = 1.0;
    for (int i = 0; i < 6; i++) {
      if (float(i) >= uBloomW.y) break;
      vec3 b = lbCubic(tBloom, uv, i);
      float g = float(i) >= uBloomW.y - 2.0 ? 1.0 + uBloomW.w * smoothstep(0.45, 0.65, dot(b, ${WARM}) / max(max(b.r, b.g), 1e-4)) : 1.0;
      bloom += b * w * g;
      w *= uBloomW.x;
    }
    bloom *= uBloom;
    bloom /= 1.0 + max(bloom.r, max(bloom.g, bloom.b)) / uBloomW.z;
    col += bloom;
  }

  if (uSun.z > 0.0) {
    float vis = 0.0;
    for (int i = 0; i < 5; i++) {
      vec2 so = i == 0 ? vec2(0.0) : vec2(i == 1 ? 1.0 : i == 2 ? -1.0 : 0.0, i == 3 ? 1.0 : i == 4 ? -1.0 : 0.0);
      vis += 0.2 * step(1.0, lbD(uSun.xy + so * vec2(0.006 / uSun.w, 0.006)));
    }
    vec2 q = (uv - uSun.xy) * vec2(uSun.w, 1.0);
    float r2 = dot(q, q);
    vec3 sc = textureLod(tColor, uSun.xy, 0.0).rgb;
    sc = sc / max(max(sc.r, max(sc.g, sc.b)), 1e-3);
    float g = uSun.z * vis * (1.0 + 3.0 * uSunLow);
    float onSky = depth < 1.0 ? 0.3 : 1.0;
    col *= 1.0 + g * onSky * (exp(-r2 * 900.0) * 2.5 + exp(-r2 * 60.0) * 0.3);
    col += g * onSky * (vec3(1.0, 0.86, 0.62) * exp(-r2 * 1400.0) * 0.5 + sc * (exp(-r2 * 60.0) * 0.12 + exp(-r2 * 6.0) * 0.05));
    col *= mix(vec3(1.0), vec3(1.1, 0.98, 0.86), uSunLow * vis * uSun.z * (1.0 - smoothstep(0.0, uSun.y + 0.1, uv.y)) * 0.7);
  }

  if (uDebug == 1) col = vec3(1.0 - ink);
  else if (uDebug == 2) col = bloom;
  else if (uDebug == 3) col = vec3(nanPx);

  vec3 c = uDebug == 0 ? lbNeutral(col * uExposure) : col;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = max(mix(vec3(l), c, 1.0 + uGrade.x * (1.0 - sat)), 0.0);
  c += uShadowTint * uGrade.z * (1.0 - smoothstep(0.0, 0.35, l));
  c *= mix(vec3(1.0), vec3(1.03, 1.0, 0.96), uGrade.w * smoothstep(0.4, 1.0, l));
  vec2 vq = (uv - 0.5) * vec2(uSun.w, 1.0);
  c *= 1.0 - uGrade.y * smoothstep(0.35, 1.05, length(vq));
  vec3 s = sRGBTransferOETF(vec4(clamp(c, 0.0, 1.0), 1.0)).rgb;
  vec2 fc = gl_FragCoord.xy;
  float n1 = fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
  float n2 = fract(52.9829189 * fract(dot(fc + 17.0, vec2(0.06711056, 0.00583715))));
  s += (n1 + n2 - 1.0) / 255.0;
  gl_FragColor = vec4(s, uAlphaLuma > 0.5 ? dot(s, vec3(0.299, 0.587, 0.114)) : 1.0);
}
`;

/**
 * FXAA (Lottes' console variant: four diagonal luma taps give the edge direction, two or four taps
 * along it blend the pixel; early-out on low contrast). It runs on the finished, sRGB-encoded image
 * so the ink lines are smoothed with the colour edges they sit on. Luma comes from alpha.
 */
export const FXAA_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uPx;
varying vec2 vUv;
void main() {
  vec4 m = texture2D(tSrc, vUv);
  float nw = texture2D(tSrc, vUv + vec2(-0.5, -0.5) * uPx).a;
  float ne = texture2D(tSrc, vUv + vec2(0.5, -0.5) * uPx).a;
  float sw = texture2D(tSrc, vUv + vec2(-0.5, 0.5) * uPx).a;
  float se = texture2D(tSrc, vUv + vec2(0.5, 0.5) * uPx).a;
  float lo = min(m.a, min(min(nw, ne), min(sw, se)));
  float hi = max(m.a, max(max(nw, ne), max(sw, se)));
  if (hi - lo < max(0.04, hi * 0.12)) {
    gl_FragColor = vec4(m.rgb, 1.0);
    return;
  }
  vec2 dir = vec2(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  float red = max((nw + ne + sw + se) * 0.03125, 0.0078125);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), -8.0, 8.0) * uPx;
  vec3 a = 0.5 * (texture2D(tSrc, vUv - dir * 0.1667).rgb + texture2D(tSrc, vUv + dir * 0.1667).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tSrc, vUv - dir * 0.5).rgb + texture2D(tSrc, vUv + dir * 0.5).rgb);
  float lb = dot(b, vec3(0.299, 0.587, 0.114));
  gl_FragColor = vec4(lb < lo || lb > hi ? a : b, 1.0);
}
`;
