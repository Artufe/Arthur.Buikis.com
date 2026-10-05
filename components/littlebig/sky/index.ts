// Sky, light and the day cycle (A3). Owns:
//   - the sky dome (one air model from the street to orbit: see sky/shaders.ts), the cartoon sun
//     disc, the moon and the starfield;
//   - the haze over the planet's limb seen from altitude;
//   - the key light (the sun) with a toon shadow map fitted to the view, the hemisphere fill, rim
//     and dusk-tint uniforms (sky/rig.ts), and the altitude fog;
//   - the shared sunDir / night uniforms every lit thing reads.
// Stage 1: it is part of the first frame, and the first system initialised (its light and fog key
// every lit program).

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  FrontSide,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { LAYER_NO_INK, type LBContext, type System } from '../core/contracts';
import { R } from '../world/config';
import { Rng } from '../world/rng';
import { CITY_DIR, moonDirection, nightFactor, sunDirection } from '../world/sun';
import { airSpace, cloudPalette, computeRig, createRig, domeAngle, FILL, mistBlend, mistColor, mix, SKY, skyDipSin, smooth, spaceAmount, tailAngle } from './rig';
import { hazeFrag, hazeVert, skyFrag, skyVert, starFrag, starVert } from './shaders';

const DEG = Math.PI / 180;
const ORIGIN = new Vector3();
/** Angular radius of the sun disc / moon disc at the centre of the frame (rad). */
const SUN_RADIUS = 1.9 * DEG;
const MOON_RADIUS = 2.5 * DEG;
/** The limb haze shell sits above the tallest terrain so it is in front of every surface. */
const HAZE_R = R + 30;
/** The twilight belt's sunward colour (magenta-pink: over green it must not turn salmon). */
const TWILIGHT_PINK = new Color('#c86ce8');
/**
 * The night occluder: a disc across the planet, perpendicular to the sun, this far (as a fraction
 * of the radius) past the terminator plane. On a 160 m planet a roof or tree crown 5–10 m up keeps
 * the sun until it is 14–20° below its local horizon, so sun-facing facets lit up under a starry
 * sky. The disc casts into the shadow map only (it writes neither colour nor depth), so nothing
 * past it gets direct light: the night side reads as night. (G2: moved from 0.085 to 0.15 R: the
 * toon kit already fades direct sun out by up·sun = −0.14, so the cut now falls where there is no
 * direct light left to cut; at 0.085 it sliced a hard diagonal seam across the city at blue hour.)
 */
const NIGHT_CUT = 0.15;

export function createSkySystem(): System {
  const disposables: Array<{ dispose(): void }> = [];
  let sun: DirectionalLight | null = null;
  let skyMat: ShaderMaterial | null = null;
  let starMat: ShaderMaterial | null = null;
  let hazeMat: ShaderMaterial | null = null;
  let haze: Mesh | null = null;
  let fog: Fog | null = null;
  const rig = createRig();
  const sunDir = new Vector3();
  const cityDir = new Vector3(CITY_DIR.x, CITY_DIR.y, CITY_DIR.z);
  const moonDir = new Vector3();
  const tmp = new Vector3();
  const lx = new Vector3();
  const ly = new Vector3();
  const center = new Vector3();
  const proj = new Vector3();
  const camRight = new Vector3();
  const camUp = new Vector3();
  const camBack = new Vector3();
  const buf = new Vector2();
  const east = new Vector3();
  const north = new Vector3();
  const cLit = new Color();
  const cShade = new Color();
  const cBelly = new Color();
  const cRim = new Color();
  let fillSky = { value: FILL.sky };
  let fillBounce = { value: FILL.bounce };
  let keyI = { value: FILL.key };
  let moonI = { value: FILL.moon };
  let occluder: Mesh | null = null;

  // Air-model uniforms shared by the dome and the stars (one object each, referenced twice).
  const air = {
    uUp: { value: new Vector3(0, 1, 0) },
    uEyeR: { value: R + 380 },
    uLimb: { value: Math.PI / 2 },
    uTheta: { value: 3 * DEG },
    uTail: { value: 3 * DEG },
    uSkyDip: { value: 0 },
    uSunDir: { value: sunDir },
    uAirSpace: { value: 1 },
  };

  return {
    name: 'sky',
    stage: 1,
    init(ctx: LBContext) {
      air.uSunDir = ctx.uniforms.lbSunDir;
      fillSky = ctx.params.number('sky.fill', { label: 'sky fill (×π)', min: 0, max: 6, value: FILL.sky });
      fillBounce = ctx.params.number('sky.bounce', { label: 'ground bounce (×π)', min: 0, max: 4, value: FILL.bounce });
      keyI = ctx.params.number('sky.key', { label: 'sun intensity', min: 0, max: 6, value: FILL.key });
      moonI = ctx.params.number('sky.moon', { label: 'moonlight fill (×π)', min: 0, max: 3, value: FILL.moon });

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
          ...air,
          uSpace: { value: 1 },
          uWarm: { value: 0 },
          uHorizon: { value: SKY.horizon },
          uTop: { value: SKY.top },
          uDeep: { value: SKY.deep },
          uSpaceCol: { value: SKY.space },
          uNightHorizon: { value: SKY.nightHorizon },
          uNightTop: { value: SKY.nightTop },
          uGold: { value: SKY.gold },
          uPeach: { value: SKY.peach },
          uBandAxis: { value: new Vector3(0.42, 0.78, -0.46).normalize() },
          uCloudAmt: { value: 0 },
          uCirrus: { value: 0 },
          uEast: { value: east },
          uNorth: { value: north },
          uCTime: { value: 0 },
          uCLit: { value: cLit },
          uCShade: { value: cShade },
          uCBelly: { value: cBelly },
          uCRim: { value: cRim },
          uDuskOrange: { value: SKY.duskOrange },
          uDuskPink: { value: SKY.duskPink },
          uDuskPurple: { value: SKY.duskPurple },
          uSunCol: { value: rig.disc },
          uSunPx: { value: new Vector2() },
          uSunRpx: { value: 10 },
          uSunVis: { value: 0 },
          uMoonPx: { value: new Vector2() },
          uMoonRpx: { value: 12 },
          uMoonVis: { value: 0 },
          uMoonSun: { value: new Vector3(1, 0, 0) },
          uVeil: { value: 0 },
          uVeilCol: { value: new Color(1, 1, 1) },
        },
      });
      const dome = new Mesh(domeGeo, skyMat);
      dome.name = 'sky';
      dome.frustumCulled = false;
      dome.renderOrder = -1000;
      dome.onBeforeRender = () => {
        const sky = ctx.services.sky;
        if (skyMat) skyMat.uniforms.uVeil.value = mistBlend(Math.max(sky.veil ?? 0, sky.mist ?? 0));
      };
      dome.layers.set(LAYER_NO_INK);
      ctx.scene.add(dome);
      disposables.push(domeGeo, skyMat);

      // Stars: cartoon-sized (2.5-6 px), a third of them crowded into a milky band, a few big
      // 4-point sparkles that twinkle, a few tinted.
      const rng = Rng.for(ctx.world.seed, 'stars');
      const N = ctx.quality === 'high' ? 2200 : 1100;
      const band = new Vector3(0.42, 0.78, -0.46).normalize();
      const bx = new Vector3(1, 0, 0).cross(band).normalize();
      const by = band.clone().cross(bx);
      const sp = new Float32Array(N * 3);
      const ss = new Float32Array(N);
      const ph = new Float32Array(N);
      const tint = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        if (rng.float() < 0.38) {
          // In the band: a great circle, scattered ±~9° across it.
          const a = rng.float() * Math.PI * 2;
          const off = (rng.float() + rng.float() + rng.float() - 1.5) * 0.18;
          tmp.copy(bx).multiplyScalar(Math.cos(a)).addScaledVector(by, Math.sin(a)).addScaledVector(band, off).normalize();
        } else {
          const u = rng.float() * 2 - 1;
          const a = rng.float() * Math.PI * 2;
          const r = Math.sqrt(1 - u * u);
          tmp.set(r * Math.cos(a), u, r * Math.sin(a));
        }
        sp[i * 3] = tmp.x;
        sp[i * 3 + 1] = tmp.y;
        sp[i * 3 + 2] = tmp.z;
        const big = rng.float();
        ss[i] = big > 0.975 ? 11 + rng.float() * 4 : big > 0.85 ? 3.6 + rng.float() * 1.2 : 2.3 + rng.float() * 0.8;
        ph[i] = rng.float();
        const k = rng.float();
        const [tr, tg, tb] = k > 0.93 ? [1, 0.86, 0.66] : k > 0.85 ? [0.72, 0.8, 1] : [0.9, 0.93, 1];
        tint[i * 3] = tr;
        tint[i * 3 + 1] = tg;
        tint[i * 3 + 2] = tb;
      }
      const starGeo = new BufferGeometry();
      starGeo.setAttribute('position', new BufferAttribute(sp, 3));
      starGeo.setAttribute('aSize', new BufferAttribute(ss, 1));
      starGeo.setAttribute('aPhase', new BufferAttribute(ph, 1));
      starGeo.setAttribute('aTint', new BufferAttribute(tint, 3));
      starMat = new ShaderMaterial({
        name: 'stars',
        vertexShader: starVert,
        fragmentShader: starFrag,
        transparent: true,
        depthWrite: false,
        depthTest: true, // drawn at the far plane: anything in front (the planet) hides them
        blending: AdditiveBlending,
        uniforms: { ...air, uTime: ctx.uniforms.lbTime, uPx: { value: 1 }, uOpacity: { value: 1 } },
      });
      const stars = new Points(starGeo, starMat);
      stars.name = 'stars';
      stars.frustumCulled = false;
      stars.renderOrder = -999;
      stars.layers.set(LAYER_NO_INK);
      ctx.scene.add(stars);
      disposables.push(starGeo, starMat);

      // Limb haze over the planet disc (seen from altitude only).
      const hazeGeo = new IcosahedronGeometry(HAZE_R, 5);
      hazeMat = new ShaderMaterial({
        name: 'limb haze',
        vertexShader: hazeVert,
        fragmentShader: hazeFrag,
        side: FrontSide,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {
          uCam: { value: new Vector3() },
          uSunDir: ctx.uniforms.lbSunDir,
          uRim: { value: SKY.top },
          uDusk: { value: TWILIGHT_PINK },
          uR: { value: R },
          uStrength: { value: 0 },
          uPurple: { value: SKY.duskPurple },
          uTwilight: { value: 0 },
        },
      });
      haze = new Mesh(hazeGeo, hazeMat);
      haze.name = 'limb haze';
      haze.renderOrder = 10;
      haze.layers.set(LAYER_NO_INK);
      ctx.scene.add(haze);
      disposables.push(hazeGeo, hazeMat);

      // The sun light + view-fitted toon shadow.
      sun = new DirectionalLight(0xffffff, 2.7);
      sun.name = 'sun';
      sun.castShadow = true;
      sun.shadow.mapSize.set(ctx.q.shadowMapSize, ctx.q.shadowMapSize);
      sun.shadow.bias = -0.0005;
      sun.shadow.normalBias = 0.06;
      sun.shadow.radius = 2;
      ctx.scene.add(sun, sun.target);

      // The night occluder (see NIGHT_CUT): shadow pass only. Double-sided so the shadow pass
      // (which draws a front-sided material's back faces) sees it from either side.
      const occGeo = new CircleGeometry(R + 95, 48);
      const occMat = new MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: DoubleSide });
      occMat.name = 'night occluder';
      occluder = new Mesh(occGeo, occMat);
      occluder.name = 'night occluder';
      occluder.castShadow = true;
      occluder.receiveShadow = false;
      occluder.frustumCulled = false;
      occluder.renderOrder = 2000;
      occluder.matrixAutoUpdate = false;
      occluder.layers.set(LAYER_NO_INK);
      ctx.scene.add(occluder);
      disposables.push(occGeo, occMat);

      fog = new Fog(SKY.horizon.clone(), 1e4, 2e4);
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
      const elev = v.focus.dot(sunDir); // sin of the sun's elevation at the focus
      const space = spaceAmount(v.altSea);
      // The sky as the EYE sees it: on a 160 m planet the visible horizon dips ~8° at eye height,
      // so the sun still lights the air after it has set underfoot (dip capped at 9°, faded out
      // toward orbit where the per-ray limb model takes over). Surfaces keep lbNightAt.
      const skyDip = skyDipSin(v.ground, v.altTerrain, v.altSea, R);
      // Golden hour follows the CITY's clock near the city: the plateau spans ~30° of sun angle, so
      // the street viewpoint (40 m west of the centre) has the sun ~14° higher than the centre.
      // Within ~0.9 rad of the city the light is as golden as the centre's late afternoon.
      const nearCity = 1 - smooth(0.6, 1.1, Math.acos(Math.max(-1, Math.min(1, v.focus.dot(cityDir)))));
      const elevCity = cityDir.dot(sunDir);
      FILL.sky = fillSky.value;
      FILL.bounce = fillBounce.value;
      FILL.key = keyI.value;
      FILL.moon = moonI.value;
      computeRig(elev, elev + skyDip, night, rig, space, mix(elev, Math.min(elev, elevCity), nearCity));

      if (sun) {
        sun.color.copy(rig.sun);
        sun.intensity = rig.sunIntensity;
        u.lbSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
        fitShadow(ctx);
      }
      u.lbSkyFill.value.copy(rig.skyFill);
      u.lbGroundFill.value.copy(rig.groundFill);
      u.lbNightFill.value.copy(rig.nightFill);
      u.lbRimColor.value.copy(rig.rim);
      u.lbDuskTint.value.copy(rig.duskTint);

      // Air model.
      const r = R + Math.max(0.01, v.altSea);
      air.uUp.value.copy(v.eye).normalize();
      air.uEyeR.value = r;
      air.uLimb.value = Math.asin(Math.min(1, R / r));
      air.uTheta.value = domeAngle(v.altSea);
      air.uTail.value = tailAngle(v.altSea, R);
      air.uSkyDip.value = skyDip;
      air.uAirSpace.value = airSpace(v.altSea);

      const cam = ctx.camera;
      ctx.renderer.getDrawingBufferSize(buf);
      const halfH = buf.y / 2;
      const tanHalf = Math.tan((cam.fov * DEG) / 2);
      if (skyMat) {
        const su = skyMat.uniforms;
        su.uSpace.value = space;
        su.uWarm.value = rig.warm;
        // The clouds' white-out: the sky sinks into the same mist as the fogged scene. Read at draw
        // time (the clouds update after the sky), from the same smoothed amount as the scene fog.
        mistColor(elev + skyDip + 0.04, su.uVeilCol.value as Color);
        // Painted far cumulus: seen from the street up to the cloud layer, gone above it, and
        // faded out while any real cloud stands over the visible horizon (the clouds system
        // reports it: a painted cloud never shares the frame with a 3D one).
        const camt = (1 - smooth(32, 56, v.altSea)) * (1 - (ctx.services.sky.cloudsInView ?? 0));
        su.uCloudAmt.value = camt;
        const cir = 1 - smooth(32, 56, v.altSea);
        su.uCirrus.value = cir;
        if (camt > 0 || cir > 0) {
          // The eye's horizontal frame (north = toward the pole, projected).
          north.set(0, 1, 0).addScaledVector(air.uUp.value, -air.uUp.value.y);
          if (north.lengthSq() < 1e-6) north.set(0, 0, 1).addScaledVector(air.uUp.value, -air.uUp.value.z);
          north.normalize();
          east.copy(north).cross(air.uUp.value).normalize();
          su.uCTime.value = ctx.time.render;
          cloudPalette(elev + skyDip + 0.04, cLit, cShade, cBelly, cRim);
        }
        // Sun and moon discs in screen space (constant pixel radius).
        placeDisc(cam, sunDir, v.forward, su.uSunPx.value as Vector2, su.uSunVis);
        su.uSunRpx.value = (Math.tan(SUN_RADIUS) / tanHalf) * halfH;
        moonDirection(ctx.time.render, moonDir);
        placeDisc(cam, moonDir, v.forward, su.uMoonPx.value as Vector2, su.uMoonVis);
        su.uMoonRpx.value = (Math.tan(MOON_RADIUS) / tanHalf) * halfH;
        // The sun in the moon disc's frame: x = camera right, y = camera up, z = toward the eye.
        camRight.setFromMatrixColumn(cam.matrixWorld, 0);
        camUp.setFromMatrixColumn(cam.matrixWorld, 1);
        camBack.setFromMatrixColumn(cam.matrixWorld, 2);
        (su.uMoonSun.value as Vector3).set(sunDir.dot(camRight), sunDir.dot(camUp), sunDir.dot(camBack)).normalize();
      }
      if (starMat) {
        starMat.uniforms.uOpacity.value = 1;
        starMat.uniforms.uPx.value = ctx.renderer.getPixelRatio();
      }
      if (hazeMat && haze) {
        (hazeMat.uniforms.uCam.value as Vector3).copy(v.eye);
        const k = smooth(150, 360, v.altSea);
        hazeMat.uniforms.uStrength.value = 0.24 * k; // (G2: was 0.4: a white inner ring, planet in a glass bubble)
        hazeMat.uniforms.uTwilight.value = 0.045 * k;
        haze.visible = k > 0.001 && v.altSea > HAZE_R - R + 1;
      }
      if (fog) {
        fog.color.copy(rig.fog);
        // Aerial perspective near the ground; none from orbit.
        fog.near = mix(60, 6000, space);
        fog.far = mix(340, 12000, space);
      }
    },

    dispose() {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      occluder?.removeFromParent();
      occluder = null;
      sun?.shadow.map?.dispose();
      sun?.dispose();
      sun = null;
      skyMat = starMat = hazeMat = null;
      haze = null;
    },
  };

  /** Project a sky direction to drawing-buffer px; vis = 0 when it is behind the camera. */
  function placeDisc(cam: LBContext['camera'], dir: Vector3, forward: Vector3, outPx: Vector2, vis: { value: unknown }) {
    proj.copy(dir).multiplyScalar(cam.far * 0.5).add(cam.position).project(cam);
    const front = dir.dot(forward) > 0 && Math.abs(proj.z) <= 1;
    outPx.set((proj.x * 0.5 + 0.5) * buf.x, (proj.y * 0.5 + 0.5) * buf.y);
    vis.value = front ? 1 : 0;
  }

  /** Fit the sun's orthographic shadow camera to what the camera sees, snapped to texels. */
  function fitShadow(ctx: LBContext) {
    if (!sun) return;
    const v = ctx.view;
    const alt = Math.max(1, v.alt);
    // Extent: tight at street level, the whole visible cap in orbit. Quantised to limit shimmer.
    // (≥ 36 m at street level: towers peeking over the ~23 m horizon still get shadows on them.)
    const raw = Math.min(R * 1.35, Math.max(36, alt * 1.5 + 18));
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
    // Depth range: from above every caster down to the lowest receiver the eye can see (the visible
    // cap round the focus, plus a margin for towers peeking over the horizon), measured along the
    // sun. The planet's far hemisphere, whose back faces otherwise filled the whole map every frame
    // (three draws a front-sided material's back faces into the shadow map), falls past the far
    // plane: the pass then only rasterises what can actually shadow something in view.
    const gammaC = Math.acos(Math.max(-1, Math.min(1, pz / (R + Math.max(0, v.ground)))));
    const thetaV = Math.acos(Math.min(1, R / (R + Math.max(1, v.altSea)))) + 0.3;
    const pLmin = R * Math.cos(Math.min(Math.PI, gammaC + thetaV)) - 12;
    // The night occluder (see NIGHT_CUT) only matters once the visible cap reaches past it.
    const needOcc = pLmin < -NIGHT_CUT * R;
    const lo = Math.floor((needOcc ? Math.min(pLmin, -NIGHT_CUT * R - 6) : pLmin) / 4) * 4;
    const top = R + 95; // above the planes (B3) too
    const depth = top - pz;
    sun.position.copy(center).addScaledVector(sunDir, depth);
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    const far = top - lo;
    if (cam.right !== ext || cam.far !== far) {
      cam.left = -ext;
      cam.right = ext;
      cam.top = ext;
      cam.bottom = -ext;
      cam.near = 1;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    sun.shadow.normalBias = 0.02 + texel * 1.2;
    // PCF radius in texels: three's PCF rotates its taps per pixel (interleaved gradient noise),
    // which shows as a stipple across a wide penumbra at street level. One texel there (~3.5 cm, a
    // crisp toon edge, smoothed by the hardware 2×2 compare); wider from altitude, where a texel
    // spans more of a pixel.
    sun.shadow.radius = mix(1, 2, smooth(20, 120, alt));

    // Night occluder: centred on the planet's axis toward the sun, NIGHT_CUT·R past the terminator
    // plane, facing the sun. Only drawn when the night side reaches into the fitted shadow box.
    if (occluder) {
      occluder.visible = needOcc;
      if (occluder.visible) {
        tmp.copy(sunDir).multiplyScalar(-NIGHT_CUT * R);
        occluder.matrix.lookAt(sunDir, ORIGIN, ly);
        occluder.matrix.setPosition(tmp);
        occluder.matrixWorld.copy(occluder.matrix);
      }
    }
  }
}
