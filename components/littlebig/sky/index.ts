// Sky v0 (F0): the sky dome (space → blue by altitude, dusk glow, cartoon sun disc), stars, the
// atmospheric rim seen from orbit, the sun light with a shadow map fitted to the view, the day
// cycle uniforms and altitude fog. A3 owns this directory next (moon, clouds, terminator colours).

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  Mesh,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { LBContext, System } from '../core/contracts';
import { PALETTE } from '../render/palette';
import { R } from '../world/config';
import { Rng } from '../world/rng';
import { nightFactor, sunDirection } from '../world/sun';

const SKY_TOP = PALETTE.sky.top;
const SKY_HORIZON = PALETTE.sky.horizon;
const SPACE = PALETTE.sky.space;
const NIGHT_TOP = new Color('#0a1233');
const NIGHT_HORIZON = new Color('#26306a');
const DUSK = new Color('#ff9a6b');
const SUN_DISC = new Color('#fff4c9');
const RIM = PALETTE.sky.rim;
const SUN_DAY = new Color('#fff1d6');
const SUN_LOW = new Color('#ffb070');
/** Warm bounce from the ground (pre-scaled; ×π-ish, see the fill note in update). */
const GROUND_FILL = new Color('#d9b48c').multiplyScalar(0.55);
/** Direct-light tint in the terminator band (lbDuskTint): sunset pink. */
const DUSK_TINT = new Color('#ff9c8c');
const WHITE = new Color(1, 1, 1);
/** Angular radius of the sun disc (rad). */
const SUN_RADIUS = 1.9 * (Math.PI / 180);

const ATM_TOP = 46; // rim shell height above sea level (m)

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}`;

const skyFrag = /* glsl */ `
uniform vec3 uUp;
uniform float uLimb; // angular radius of the planet seen from the eye (rad)
uniform float uEyeR; // eye distance from the planet centre
uniform float uR;
uniform float uSpace;
uniform float uDusk;
uniform vec3 uSunDir;
uniform vec3 uTop, uHorizon, uSpaceCol, uNightTop, uNightHorizon, uDuskCol, uSunCol;
uniform vec2 uSunPx;   // sun disc centre in drawing-buffer px (gl_FragCoord space)
uniform float uSunRpx; // its radius in px (constant angular size at the centre of the frame)
uniform float uSunVis; // 0 when the sun is behind the camera
uniform float uAirH;   // air scale height (m): tall near the ground, thin seen from orbit (a cartoon cheat, see update)
uniform float uAirG;   // path gain of a grazing ray over a vertical one
uniform float uSkyDip; // sin of the (capped) horizon dip at the eye: low air stays sunlit a little past local sunset
varying vec3 vDir;
// Air: density falls off with height; the ray's sky amount comes from the air along IT, not from
// camera altitude alone, so one model holds from the street (every ray in thick air) to orbit
// (only rays skimming the limb), and thinning air keeps its hue: pale horizon → sky blue → deep
// saturated blue → space, never a grey lerp of a pink horizon into navy.
#define AIR_K 4.0
void main() {
  vec3 v = normalize(vDir);
  vec3 eye = uUp * uEyeR;
  float tc = -dot(eye, v);
  vec3 cp = eye + v * max(tc, 0.0);        // the ray's closest point to the planet centre
  float hmin = max(length(cp) - uR, 0.0);  // ... and its height
  float mu = dot(v, uUp);
  float g = tc > 0.0 ? uAirG : min(uAirG, 1.0 / max(mu, 1e-3));
  float air = 1.0 - exp(-AIR_K * exp(-hmin / uAirH) * g);
  float thin = 1.0 - air;

  // Day / night gradient by the angle above the planet's limb (0 = grazing the horizon); thin air
  // takes the zenith colour, and dusk colours belong to the low, thick sky.
  float nadir = acos(clamp(-mu, -1.0, 1.0));
  float above = max(nadir - uLimb, 0.0);
  // (Seen from altitude the limb's thick air leans to sky blue too: no pale backdrop mid-dive.)
  float hz = mix(clamp(above / 1.25, 0.0, 1.0), 1.0, max(smoothstep(0.0, 0.5, thin), 0.55 * smoothstep(0.0, 0.6, uSpace)));
  float duskLow = uDusk * (1.0 - uSpace) * (1.0 - smoothstep(0.0, 0.4, thin));
  vec3 day = mix(mix(uHorizon, uDuskCol, duskLow * 0.5), mix(uTop, vec3(0.22, 0.32, 0.72), duskLow * 0.35), pow(hz, 0.55));
  float sd = dot(v, uSunDir);
  day += uDuskCol * duskLow * pow(max(sd, 0.0), 5.0) * (1.0 - smoothstep(0.0, 0.45, hz)) * 0.9;
  vec3 night = mix(uNightHorizon, uNightTop, pow(hz, 0.7));
  // Night where the ray's air is: the lit or the dark side of the limb.
  float nightRay = 1.0 - smoothstep(-0.35, 0.2, dot(normalize(cp), uSunDir) + uSkyDip);
  vec3 col = mix(day, night, nightRay);
  vec3 deep = mix(vec3(0.03, 0.10, 0.42), uNightTop * 0.85, nightRay); // never brighter than the night zenith
  col = mix(col, deep, smoothstep(0.3, 0.8, thin));
  col = mix(col, uSpaceCol, smoothstep(0.55, 1.0, thin));
  // Cartoon sun: a crisp disc of constant on-screen size (no stretching at the frame edge at wide
  // FOV) and a soft angular halo.
  float dpx = length(gl_FragCoord.xy - uSunPx);
  float disc = (1.0 - smoothstep(uSunRpx - 1.0, uSunRpx + 1.0, dpx)) * uSunVis * step(0.0, sd);
  float halo = pow(max(sd, 0.0), mix(180.0, 1400.0, uSpace)) * 0.55 + pow(max(sd, 0.0), mix(12.0, 300.0, uSpace)) * 0.12;
  col += uSunCol * (disc * 1.6 + halo);
  // Dither: kills 8-bit banding in the long gradients.
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const starVert = /* glsl */ `
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uPx;
varying float vTw;
void main() {
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
  vTw = 0.65 + 0.35 * sin(uTime * (0.7 + aPhase) + aPhase * 40.0);
  gl_PointSize = aSize * uPx;
}`;

const starFrag = /* glsl */ `
uniform float uOpacity;
varying float vTw;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  float a = (1.0 - smoothstep(0.15, 0.5, r)) * uOpacity * vTw;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const atmVert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const atmFrag = /* glsl */ `
uniform vec3 uCam;
uniform vec3 uSunDir;
uniform vec3 uRim;
uniform float uR;
uniform float uTop;
uniform float uStrength;
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld - uCam);
  float tc = -dot(uCam, d);
  vec3 closest = uCam + d * max(tc, 0.0);
  float b = length(closest);
  float t = clamp((b - uR) / (uTop - uR), 0.0, 1.0);
  float glow = pow(1.0 - t, 3.0) * 0.75;
  float lit = smoothstep(-0.3, 0.3, dot(normalize(closest), uSunDir));
  vec3 col = uRim * glow * (0.07 + 0.93 * lit) * uStrength;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createSkySystem(): System {
  const disposables: Array<{ dispose(): void }> = [];
  let sun: DirectionalLight | null = null;
  const sunDir = new Vector3();
  const tmp = new Vector3();
  const lx = new Vector3();
  const ly = new Vector3();
  const center = new Vector3();
  let skyMat: ShaderMaterial | null = null;
  let starMat: ShaderMaterial | null = null;
  let atmMat: ShaderMaterial | null = null;
  let fog: Fog | null = null;
  const fogDay = new Color();
  const fogNight = new Color('#1b2350');
  const sunPos = new Vector3();
  const buf = new Vector2();

  return {
    name: 'sky',
    stage: 1,
    init(ctx: LBContext) {
      // Dome.
      const domeGeo = new SphereGeometry(1, 48, 24);
      skyMat = new ShaderMaterial({
        name: 'sky',
        vertexShader: skyVert,
        fragmentShader: skyFrag,
        side: BackSide,
        depthWrite: false,
        depthTest: false,
        uniforms: {
          uUp: { value: new Vector3(0, 1, 0) },
          uLimb: { value: Math.PI / 2 },
          uEyeR: { value: R + 380 },
          uR: { value: R },
          uSpace: { value: 1 },
          uDusk: { value: 0 },
          uSunPx: { value: new Vector2() },
          uSunRpx: { value: 10 },
          uSunVis: { value: 0 },
          uSkyDip: { value: 0 },
          uAirH: { value: 60 },
          uAirG: { value: 7 },
          uSunDir: ctx.uniforms.lbSunDir,
          uTop: { value: SKY_TOP },
          uHorizon: { value: SKY_HORIZON },
          uSpaceCol: { value: SPACE },
          uNightTop: { value: NIGHT_TOP },
          uNightHorizon: { value: NIGHT_HORIZON },
          uDuskCol: { value: DUSK },
          uSunCol: { value: SUN_DISC },
        },
      });
      const dome = new Mesh(domeGeo, skyMat);
      dome.name = 'sky';
      dome.frustumCulled = false;
      dome.renderOrder = -1000;
      ctx.scene.add(dome);
      disposables.push(domeGeo, skyMat);

      // Stars.
      const rng = Rng.for(ctx.world.seed, 'stars');
      const N = ctx.quality === 'high' ? 1800 : 900;
      const sp = new Float32Array(N * 3);
      const ss = new Float32Array(N);
      const ph = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const u = rng.float() * 2 - 1;
        const a = rng.float() * Math.PI * 2;
        const r = Math.sqrt(1 - u * u);
        sp[i * 3] = r * Math.cos(a);
        sp[i * 3 + 1] = u;
        sp[i * 3 + 2] = r * Math.sin(a);
        const big = rng.float();
        ss[i] = big > 0.985 ? 3.4 : big > 0.9 ? 2.2 : 1.3;
        ph[i] = rng.float();
      }
      const starGeo = new BufferGeometry();
      starGeo.setAttribute('position', new BufferAttribute(sp, 3));
      starGeo.setAttribute('aSize', new BufferAttribute(ss, 1));
      starGeo.setAttribute('aPhase', new BufferAttribute(ph, 1));
      starMat = new ShaderMaterial({
        name: 'stars',
        vertexShader: starVert,
        fragmentShader: starFrag,
        transparent: true,
        depthWrite: false,
        depthTest: true, // drawn at the far plane: anything in front (the planet) hides them
        blending: AdditiveBlending,
        uniforms: { uTime: ctx.uniforms.lbTime, uPx: { value: 1 }, uOpacity: { value: 1 } },
      });
      const stars = new Points(starGeo, starMat);
      stars.name = 'stars';
      stars.frustumCulled = false;
      stars.renderOrder = -999;
      ctx.scene.add(stars);
      disposables.push(starGeo, starMat);

      // Atmospheric rim shell (seen from orbit).
      const atmGeo = new SphereGeometry(R + ATM_TOP, 96, 48);
      atmMat = new ShaderMaterial({
        name: 'atmosphere',
        vertexShader: atmVert,
        fragmentShader: atmFrag,
        side: BackSide,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {
          uCam: { value: new Vector3() },
          uSunDir: ctx.uniforms.lbSunDir,
          uRim: { value: RIM },
          uR: { value: R },
          uTop: { value: R + ATM_TOP },
          uStrength: { value: 1 },
        },
      });
      const atm = new Mesh(atmGeo, atmMat);
      atm.name = 'atmosphere';
      atm.renderOrder = 10;
      ctx.scene.add(atm);
      disposables.push(atmGeo, atmMat);

      // Sun light + view-fitted shadow.
      sun = new DirectionalLight(SUN_DAY, 2.7);
      sun.name = 'sun';
      sun.castShadow = true;
      sun.shadow.mapSize.set(ctx.q.shadowMapSize, ctx.q.shadowMapSize);
      sun.shadow.bias = -0.0005;
      sun.shadow.normalBias = 0.06;
      sun.shadow.radius = 2;
      ctx.scene.add(sun, sun.target);

      fog = new Fog(SKY_HORIZON.clone(), 1e4, 2e4);
      ctx.scene.fog = fog;
      ctx.services.sky = { sun, fog };
    },
    update(ctx: LBContext) {
      const v = ctx.view;
      const u = ctx.uniforms;
      sunDirection(ctx.time.render, sunDir);
      u.lbSunDir.value.copy(sunDir);
      const night = nightFactor(v.focus, sunDir);
      u.lbNight.value = night;
      const elev = v.focus.dot(sunDir); // sin of sun elevation at the focus
      const space = smooth(55, 360, v.altSea);
      // The sky as the EYE sees it: on a 160 m planet the visible horizon dips ~8° at eye height,
      // so the sun still shows (and lights the air) after it has set for the ground underfoot.
      // The sky's night / dusk use the elevation above the visible horizon (dip capped at 9°,
      // faded out toward orbit where the limb model takes over); surfaces keep lbNightAt.
      const dip = Math.acos(Math.min(1, (R + v.ground) / (R + v.ground + Math.max(0, v.altTerrain))));
      const skyDip = Math.sin(Math.min(dip, 9 * (Math.PI / 180))) * (1 - space);
      const elevSky = elev + skyDip;
      const nx = Math.min(1, Math.max(0, (elevSky + 0.18) / 0.3));
      const nightSky = 1 - nx * nx * (3 - 2 * nx);
      // dusk: the narrow sunset band (sky glow, fog); warm: the wide golden-hour window, so the
      // late-afternoon start (sun ~28° over the city) already reads golden.
      const dusk = Math.max(0, 1 - Math.abs(elevSky - 0.05) / 0.35) * (1 - nightSky);
      const warm = (1 - smooth(0.1, 0.85, elev)) * (1 - night);

      // Sun colour: golden in the afternoon, never orange across the whole lit hemisphere; the
      // terminator's sunset colour is per fragment (lbDuskTint × lbDuskAt in the toon kit).
      if (sun) {
        sun.color.copy(SUN_DAY).lerp(SUN_LOW, Math.min(1, warm * 0.55 + dusk * 0.25));
        sun.intensity = 2.7;
        u.lbSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
        fitShadow(ctx);
      }
      u.lbDuskTint.value.copy(WHITE).lerp(DUSK_TINT, 0.85);
      // Fill: sky-tinted by day, warmer in golden light.
      // (×π-ish: three's indirect diffuse is irradiance · albedo / π)
      u.lbSkyFill.value.copy(SKY_TOP).lerp(DUSK, warm * 0.2 + dusk * 0.2).multiplyScalar(1.05);
      u.lbGroundFill.value.copy(GROUND_FILL);

      if (skyMat) {
        const su = skyMat.uniforms;
        (su.uUp.value as Vector3).copy(v.focus);
        const r = R + Math.max(0.01, v.altSea);
        su.uLimb.value = Math.asin(Math.min(1, R / r));
        su.uEyeR.value = r;
        su.uSpace.value = space;
        su.uDusk.value = dusk;
        su.uSkyDip.value = skyDip;
        // A cartoon cheat with no seam inside a frame: the air is tall seen from the street (a blue
        // sky overhead up to the clouds) and thins with altitude to a slim limb glow from orbit.
        su.uAirH.value = mix(60, 7, space);
        su.uAirG.value = mix(7, 2, space);
        // Sun disc in screen space.
        const cam = ctx.camera;
        ctx.renderer.getDrawingBufferSize(buf);
        sunPos.copy(sunDir).multiplyScalar(cam.far * 0.5).add(cam.position).project(cam);
        const front = sunDir.dot(v.forward) > 0 && Math.abs(sunPos.z) <= 1;
        (su.uSunPx.value as Vector2).set((sunPos.x * 0.5 + 0.5) * buf.x, (sunPos.y * 0.5 + 0.5) * buf.y);
        su.uSunRpx.value = (Math.tan(SUN_RADIUS) / Math.tan((cam.fov * Math.PI) / 360)) * (buf.y / 2);
        su.uSunVis.value = front ? 1 : 0;
      }
      if (starMat) {
        starMat.uniforms.uOpacity.value = Math.min(1, space * 0.9 + nightSky * 0.9) * (1 - 0.85 * (1 - nightSky) * (1 - space));
        starMat.uniforms.uPx.value = ctx.renderer.getPixelRatio();
      }
      if (atmMat) {
        (atmMat.uniforms.uCam.value as Vector3).copy(v.eye);
        atmMat.uniforms.uStrength.value = smooth(180, 380, v.altSea) * 0.6; // a thin bright edge on the sky's limb glow, only against dark space
      }
      if (fog) {
        fogDay.copy(SKY_HORIZON).lerp(DUSK, dusk * 0.4);
        fog.color.copy(fogDay).lerp(fogNight, nightSky);
        fog.near = mix(55, 6000, space);
        fog.far = mix(330, 12000, space);
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      sun?.shadow.map?.dispose();
      sun?.dispose();
      sun = null;
    },
  };

  /** Fit the sun's orthographic shadow camera to what the camera sees, snapped to texels. */
  function fitShadow(ctx: LBContext) {
    if (!sun) return;
    const v = ctx.view;
    const alt = Math.max(1, v.alt);
    // Extent: tight at street level, the whole visible cap in orbit. Quantised to limit shimmer.
    const raw = Math.min(R * 1.35, Math.max(24, alt * 1.5 + 18));
    const ext = Math.pow(1.12, Math.ceil(Math.log(raw) / Math.log(1.12)));
    // Centre: the ground under the camera, pushed along the view where the camera looks ahead.
    const ahead = Math.max(0, Math.cos(-v.pitch)) * Math.min(ext * 0.6, v.horizon * 0.5);
    tmp.copy(v.forward).addScaledVector(v.focus, -v.forward.dot(v.focus));
    if (tmp.lengthSq() > 1e-8) tmp.normalize();
    center.copy(v.focus).multiplyScalar(R + v.ground).addScaledVector(tmp, ahead);
    // Light-space basis and texel snap.
    lx.set(0, 1, 0).cross(sunDir);
    if (lx.lengthSq() < 1e-6) lx.set(1, 0, 0);
    lx.normalize();
    ly.copy(sunDir).cross(lx).normalize();
    const texel = (2 * ext) / sun.shadow.mapSize.x;
    const px = Math.round(center.dot(lx) / texel) * texel;
    const py = Math.round(center.dot(ly) / texel) * texel;
    const pz = center.dot(sunDir);
    center.copy(lx).multiplyScalar(px).addScaledVector(ly, py).addScaledVector(sunDir, pz);
    const depth = ext + 120;
    sun.position.copy(center).addScaledVector(sunDir, depth);
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    if (cam.right !== ext || cam.far !== depth * 2) {
      cam.left = -ext;
      cam.right = ext;
      cam.top = ext;
      cam.bottom = -ext;
      cam.near = 1;
      cam.far = depth * 2;
      cam.updateProjectionMatrix();
    }
    sun.shadow.normalBias = 0.02 + texel * 1.2;
  }
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
