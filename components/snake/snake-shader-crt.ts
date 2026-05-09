// Default PixiJS v8 filter vertex shader. Provided verbatim so the filter compiles
// without depending on any internal default. Source: pixijs.com filter docs.
export const CRT_VERTEX_GLSL = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}
`;

export const CRT_FRAGMENT_GLSL = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uAberration;     // chromatic aberration strength, 0..1
uniform float uGrain;          // grain strength, 0..0.2
uniform float uScanlines;      // scanline strength, 0..0.4
uniform float uVignette;       // vignette strength, 0..1
uniform float uBarrel;         // barrel distortion, 0..0.2

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec2 barrel(vec2 uv, float k) {
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  return uv + c * r2 * k;
}

void main(void) {
  vec2 uv = barrel(vTextureCoord, uBarrel);

  // Chromatic aberration
  float a = uAberration * 0.004;
  float r = texture(uTexture, uv + vec2(a, 0.0)).r;
  float g = texture(uTexture, uv).g;
  float b = texture(uTexture, uv - vec2(a, 0.0)).b;
  float alpha = texture(uTexture, uv).a;
  vec3 col = vec3(r, g, b);

  // Scanlines
  float sl = sin(uv.y * 800.0) * 0.5 + 0.5;
  col *= 1.0 - uScanlines * (1.0 - sl);

  // Grain (animated by uTime)
  float n = hash(uv * 1024.0 + vec2(uTime * 13.0, uTime * 7.0));
  col += (n - 0.5) * uGrain;

  // Vignette
  vec2 vc = uv - 0.5;
  float vd = dot(vc, vc);
  col *= mix(1.0, 1.0 - vd * 2.0, uVignette);

  // Clip to rendered area
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    finalColor = vec4(0.0);
    return;
  }
  finalColor = vec4(col, alpha);
}
`;

export type CrtUniforms = {
  uTime: number;
  uAberration: number;
  uGrain: number;
  uScanlines: number;
  uVignette: number;
  uBarrel: number;
};

export const CRT_DEFAULTS: CrtUniforms = {
  uTime: 0,
  uAberration: 0.6,
  uGrain: 0.06,
  uScanlines: 0.18,
  uVignette: 0.55,
  uBarrel: 0.04,
};

export const CRT_REDUCED_MOTION: CrtUniforms = {
  uTime: 0,
  uAberration: 0.0,
  uGrain: 0.0,
  uScanlines: 0.18,
  uVignette: 0.55,
  uBarrel: 0.04,
};
