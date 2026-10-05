// Clouds (A3): puffy toon cumulus clusters on the cloud layer (36–48 m), drifting slowly around the
// city's axis, with soft shadows on the ground (the toon kit's lbCloudShadow hook) and a brief
// white-out when the camera passes through a puff.
//
//   - Instanced unit spheres in three LODs (puffs.ts: near / far / tiny), whole clusters culled by
//     the horizon and the view frustum: puff centre + radius per instance, the drift as the meshes'
//     rotation. Cotton lobes, flat bases, toon bands, dusk blush, indigo nights (shaders.ts).
//   - Layout (layout.ts): no clouds over the middle of the city, a few small ones over its
//     outskirts, a scatter beyond; plus anchors where the scripted dive crosses the layer and
//     framing the `clouds` shot. Drift is a rotation about the city's own axis, so the coverage
//     over the city never changes with time.
//   - Shadows: an equirectangular coverage map of the layout, looked up through the drift and a
//     sun-direction offset at the focus; strength fades as the sun gets low.
//   - White-out: per frame the eye is tested against the puffs. Inside a puff (≈ its lumpy
//     surface) the veil overlay closes fast; near one (within ~9 m of its surface) the scene fog
//     closes toward the mist colour, so the city fades by depth before the eye goes in and after it
//     comes out, and puff surfaces right at the eye melt into the same mist (no hard sphere edge).
//     Over the city, where no cloud floats, a player diving through the layer crosses a "mist
//     slab" instead: the same veil by altitude alone, only while moving through it.

import {
  BufferGeometry,
  Color,
  DataTexture,
  Float32BufferAttribute,
  LinearFilter,
  Matrix3,
  Matrix4,
  Mesh,
  Quaternion,
  RedFormat,
  ShaderMaterial,
  SphereGeometry,
  UniformsLib,
  UniformsUtils,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import { LAYER_NO_INK, type LBContext, type System } from '../core/contracts';
import { diveAt, SHOTS } from '../core/shots';
import { CLOUD_MAX, CLOUD_MIN, R } from '../world/config';
import { addScaled3, cross3, dirFromLatLon, dot3, headingVector, normalize3, v3, type Vec3 } from '../world/sphere';
import { moonDirection } from '../world/sun';
import { CITY_AXIS, type CloudAnchor, coverageMap, layoutClouds, SHELL_R } from './layout';
import { airSpace, cloudLift, CLOUD_PAL_BELLY, CLOUD_PAL_E, CLOUD_PAL_LIT, CLOUD_PAL_RIM, CLOUD_PAL_SHADE, mistBlend, mistColor, mix, skyDipSin, smooth, spaceAmount } from '../sky/rig';
import { PuffLod } from './puffs';
import { blockFrag, blockVert, puffFrag, puffVert, veilFrag, veilVert } from './shaders';

const DEG = Math.PI / 180;
const SHADOW_W = 1024;
const SHADOW_H = 512;
/** Reveal: the whole layer pops in over this window (s), cluster by cluster. */
const REVEAL_SPAN = 1.6;
const REVEAL_DUR = 0.9;
/** Fog reach (m from a puff's surface): the scene starts to fade into the mist this far out. */
const FOG_REACH = 5;
/** Mist under (and just beside) a cluster's flat base (m). */
const BASE_MIST = 4;
/** Scene visibility (fog far, m) at full white-out. */
const VEIL_VIS = 9;
/** The mist slab over the city (altitude above sea level, m): ramps in / full / ramps out. */
const SLAB = [31.5, 38.5, 44, 49];
/** Plan radius (m) the mist slab covers (it fades out between these). */
const SLAB_R0 = 72;
const SLAB_R1 = 92;
/**
 * Temporal release (s): leaving a cloud, the overlay thins over ~6 frames and the scene fog opens
 * over ~10 more (overlay first, fog last), so the city is revealed out of the mist, never cut to.
 * Entering is instant (the near plane must never slice a puff open).
 */
const VEIL_RELEASE = 0.2;
const MIST_RELEASE = 0.4;
/** The puffs' own fog far plane is floored at this while the white-out fog is closed (m). */
const PUFF_FOG_MIN = 30;

export function createCloudsSystem(): System {
  let lod: PuffLod | null = null;
  let veil: Mesh | null = null;
  let block: Mesh | null = null;
  let puffMat: ShaderMaterial | null = null;
  let veilMat: ShaderMaterial | null = null;
  let blockMat: ShaderMaterial | null = null;
  let tex: DataTexture | null = null;
  let puffs: Float32Array | null = null;
  /** Per puff: its cluster's flat base altitude (the white-out test squashes like the shader). */
  let puffBase: Float32Array | null = null;
  let puffCount = 0;
  /** Per cluster: axis x, y, z (cloud frame, unit), base footprint radius, base altitude, top altitude. */
  let clusterInfo = new Float32Array(0);
  let clusterCount = 0;
  let drift = { value: 0.25 }; // deg/s (param)
  let shadowK = { value: 0.6 };
  let bump = { value: 0.2 };
  let mask = { value: 0 };
  let ready = false;
  let phase = 0;
  let hasPrev = false;
  let veilS = 0;
  let mistS = 0;
  // The mist slab (interactive descents over the city).
  let slabOn = false;
  let slabIdle = 0;
  let slabK = 0;
  let wasInBand = false;
  let prevAltSea = 0;
  const prevEye = new Vector3();
  const vel = new Vector3();
  const foe = new Vector2(0.5, 0.5);
  const foeT = new Vector2();
  const moonDir = new Vector3();
  const drift3 = new Matrix3();
  const mist = new Color();
  const mistLit = new Color();
  const q = new Quaternion();
  const qInv = new Quaternion();
  const eyeLocal = new Vector3();
  const m4 = new Matrix4();
  const m4b = new Matrix4();
  const driftM = new Matrix4();
  const axis = new Vector3(CITY_AXIS.x, CITY_AXIS.y, CITY_AXIS.z);
  const sunAxis = new Vector3();
  const tmp = new Vector3();
  const fwdL = new Vector3();

  return {
    name: 'clouds',
    stage: 2,
    async init(ctx: LBContext) {
      drift = ctx.params.number('clouds.drift', { label: 'cloud drift (deg/s)', min: 0, max: 3, value: 0.25 });
      shadowK = ctx.params.number('clouds.shadow', { label: 'cloud shadow strength', min: 0, max: 1, value: 0.6 });
      bump = ctx.params.number('clouds.bump', { label: 'cloud bump', min: 0, max: 1, value: 0.2 });
      mask = ctx.params.number('clouds.mask', { label: 'debug: clouds as flat magenta', min: 0, max: 1, value: 0 });

      const layout = layoutClouds({ seed: ctx.world.seed, clusters: 30, anchors: anchors(ctx) });
      puffs = layout.puffs;
      puffCount = layout.count;
      puffBase = new Float32Array(puffCount);
      for (let i = 0; i < puffCount; i++) puffBase[i] = layout.clusters[layout.cluster[i]].base;
      await ctx.yield();

      // Shadow coverage map.
      const cov = coverageMap(layout, SHADOW_W, SHADOW_H);
      tex = ctx.track(new DataTexture(cov, SHADOW_W, SHADOW_H, RedFormat, UnsignedByteType));
      tex.minFilter = LinearFilter;
      tex.magFilter = LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      ctx.uniforms.lbCloudShadow.value = tex;
      await ctx.yield();
      // From here to ctx.compile() no yields: a frame must never draw an uncompiled program.

      // Puffs: indexed UV spheres in three sizes (puffs.ts): smooth for the few near the eye (their
      // cotton lobes need vertices), modest for the mid range, tiny far away. Shading is per
      // fragment, so only silhouettes and lobes depend on the vertex count.
      const hi = ctx.quality === 'high';
      const nearGeo = ctx.track(hi ? new SphereGeometry(1, 44, 26) : new SphereGeometry(1, 28, 17));
      const farGeo = ctx.track(hi ? new SphereGeometry(1, 20, 12) : new SphereGeometry(1, 14, 9));
      const tinyGeo = ctx.track(new SphereGeometry(1, 12, 8));
      for (const g of [nearGeo, farGeo, tinyGeo]) {
        g.deleteAttribute('uv');
        g.deleteAttribute('normal');
      }
      puffMat = ctx.track(
        new ShaderMaterial({
          name: 'clouds',
          vertexShader: puffVert,
          fragmentShader: puffFrag,
          fog: true,
          defines: ctx.reducedMotion ? { LB_REVEAL_FADE: '' } : {},
          uniforms: {
            ...UniformsUtils.clone(UniformsLib.fog),
            ...ctx.uniforms,
            uR: { value: R },
            uRevealDur: { value: REVEAL_DUR },
            uSoft: { value: 1.4 },
            uEyeSun: { value: 0.5 },
            uAirSpace: { value: 1 },
            uBump: { value: bump.value * (hi ? 1 : 0.7) },
            uDrift: { value: drift3 },
            uMoonDir: { value: moonDir },
            uMist: { value: mist },
            uMask: { value: 0 },
            uLift: { value: 1 },
            uFogMin: { value: 0 },
            uExact: { value: hi ? 110 : 60 },
            uPalE: { value: CLOUD_PAL_E },
            uPalLit: { value: CLOUD_PAL_LIT },
            uPalShade: { value: CLOUD_PAL_SHADE },
            uPalBelly: { value: CLOUD_PAL_BELLY },
            uPalRim: { value: CLOUD_PAL_RIM },
          },
        }),
      );
      // Per puff: aInfo (base, top, phase, cluster horizontal radius) and aCluster (cluster centre
      // in the cloud frame at its middle height, cluster vertical half-height): the cluster
      // ellipsoid the rim is measured against.
      const info = new Float32Array(puffCount * 4);
      const clus = new Float32Array(puffCount * 4);
      const p = layout.puffs;
      clusterCount = layout.clusters.length;
      clusterInfo = new Float32Array(clusterCount * 6);
      const spheres = new Float32Array(clusterCount * 4);
      layout.clusters.forEach((c, k) => {
        const mid = c.base + (c.top - c.base) * 0.42;
        const cx = c.dir.x * (R + mid);
        const cy = c.dir.y * (R + mid);
        const cz = c.dir.z * (R + mid);
        let rh = c.radius;
        let rb = 0; // bounding radius around (cx, cy, cz)
        for (let i = c.first; i < c.first + c.count; i++) {
          const dx = p[i * 4] - cx;
          const dy = p[i * 4 + 1] - cy;
          const dz = p[i * 4 + 2] - cz;
          const along = dx * c.dir.x + dy * c.dir.y + dz * c.dir.z;
          const hd = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along));
          rh = Math.max(rh, hd + p[i * 4 + 3] * 0.85);
          rb = Math.max(rb, Math.hypot(dx, dy, dz) + p[i * 4 + 3]);
        }
        const rv = Math.max(3, (c.top - c.base) * 0.55);
        for (let i = c.first; i < c.first + c.count; i++) {
          info[i * 4] = c.base;
          info[i * 4 + 1] = c.top;
          info[i * 4 + 2] = layout.phase[i];
          info[i * 4 + 3] = rh;
          clus[i * 4] = cx;
          clus[i * 4 + 1] = cy;
          clus[i * 4 + 2] = cz;
          clus[i * 4 + 3] = rv;
        }
        clusterInfo[k * 6] = c.dir.x;
        clusterInfo[k * 6 + 1] = c.dir.y;
        clusterInfo[k * 6 + 2] = c.dir.z;
        clusterInfo[k * 6 + 3] = rh * 0.72; // the flat base is narrower than the bulge
        clusterInfo[k * 6 + 4] = c.base;
        clusterInfo[k * 6 + 5] = c.top;
        spheres[k * 4] = cx;
        spheres[k * 4 + 1] = cy;
        spheres[k * 4 + 2] = cz;
        spheres[k * 4 + 3] = rb;
      });
      lod = new PuffLod([nearGeo, farGeo, tinyGeo], puffMat, layout.puffs, { aInfo: info, aCluster: clus }, { spheres, of: layout.cluster }, 64);
      ctx.scene.add(...lod.meshes);

      // White-out veil (one full-screen triangle) and its opaque scene blocker.
      const vgeo = ctx.track(new BufferGeometry());
      vgeo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      veilMat = ctx.track(
        new ShaderMaterial({
          name: 'cloud veil',
          vertexShader: veilVert,
          fragmentShader: veilFrag,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          uniforms: {
            uAmount: { value: 0 },
            uWisp: { value: 0 },
            uLit: { value: mistLit },
            uShade: { value: mist },
            uPhase: { value: 0 },
            uFoe: { value: foe },
            uAspect: { value: 1.6 },
            uTime: ctx.uniforms.lbTime,
          },
        }),
      );
      veil = new Mesh(vgeo, veilMat);
      veil.name = 'cloud veil';
      veil.frustumCulled = false;
      veil.renderOrder = 1000;
      veil.layers.set(LAYER_NO_INK);
      ctx.scene.add(veil);
      blockMat = ctx.track(
        new ShaderMaterial({
          name: 'cloud block',
          vertexShader: blockVert,
          fragmentShader: blockFrag,
          depthTest: false,
          depthWrite: true,
          uniforms: { uColor: { value: mist } },
        }),
      );
      block = new Mesh(vgeo, blockMat);
      block.name = 'cloud block';
      block.frustumCulled = false;
      block.renderOrder = -999.5; // right after the sky dome (-1000), before the stars and the world
      block.layers.set(LAYER_NO_INK);
      ctx.scene.add(block);

      await ctx.compile();
      veil.visible = false;
      block.visible = false;
      // Reveal: clusters pop in one after another (nearest the city first), puffs within a cluster
      // in a quick ripple.
      const start = ctx.reveal.slot(REVEAL_SPAN + REVEAL_DUR);
      const nC = layout.clusters.length;
      const order = layout.clusters.map((c, i) => ({ i, d: -(c.dir.x * axis.x + c.dir.y * axis.y + c.dir.z * axis.z) })).sort((a, b) => a.d - b.d);
      const rank = new Float32Array(nC);
      order.forEach((o, k) => (rank[o.i] = k / Math.max(1, nC - 1)));
      for (let i = 0; i < puffCount; i++) lod.reveal[i] = start + rank[layout.cluster[i]] * REVEAL_SPAN + layout.phase[i] * 0.22;
      lod.refresh();
      ready = true;
    },

    update(ctx: LBContext) {
      if (!ready || !lod || !puffMat || !veilMat || !blockMat || !veil || !block || !puffs || !puffBase) return;
      const v = ctx.view;
      const u = ctx.uniforms;
      const pu = puffMat.uniforms;
      // Drift: a slow rotation about the city's axis.
      q.setFromAxisAngle(axis, drift.value * DEG * ctx.time.render);
      driftM.makeRotationFromQuaternion(q);
      lod.setMatrix(driftM);
      drift3.setFromMatrix4(driftM);
      qInv.copy(q).invert();
      eyeLocal.copy(v.eye).applyQuaternion(qInv);
      lod.update(eyeLocal, ctx.camera, driftM, R);

      // Shadows: ground direction → (toward the sun by the cloud's offset at the focus) → cloud frame.
      // In orbit the focus's sun angle means little (the whole hemisphere is in view): shadows stay
      // on, with a fixed offset so each reads next to its cloud.
      const elev = v.focus.dot(u.lbSunDir.value);
      const night = u.lbNight.value;
      const space = spaceAmount(v.altSea);
      const k = Math.min(0.9, shadowK.value * mix(smooth(0.12, 0.34, elev) * (1 - night), 1.4, space));
      u.lbCloudShadowOn.value = k;
      if (k > 0) {
        const hc = (CLOUD_MIN + CLOUD_MAX) / 2 - Math.max(0, v.ground);
        const offFocus = Math.min(34, hc / Math.max(0.2, Math.tan(Math.asin(Math.min(1, Math.max(0.05, elev))))));
        const off = mix(offFocus, 12, space);
        sunAxis.copy(v.focus).cross(u.lbSunDir.value);
        if (sunAxis.lengthSq() < 1e-8) sunAxis.set(1, 0, 0);
        sunAxis.normalize();
        m4.makeRotationAxis(sunAxis, off / SHELL_R);
        m4b.makeRotationFromQuaternion(qInv).multiply(m4);
        u.lbCloudShadowRot.value.setFromMatrix4(m4b);
      }

      // The eye's (dip-aware) time of day, as the sky computes it, and the mist colour there.
      const eyeSun = elev + skyDipSin(v.ground, v.altTerrain, v.altSea, R) + 0.04;
      pu.uEyeSun.value = eyeSun;
      pu.uAirSpace.value = airSpace(v.altSea);
      pu.uBump.value = bump.value * (ctx.quality === 'high' ? 1 : 0.7);
      pu.uMask.value = mask.value;
      mistColor(eyeSun, mist, mistLit);
      pu.uLift.value = 1 + (cloudLift(eyeSun) - 1) * (1 - pu.uAirSpace.value);
      moonDirection(ctx.time.render, moonDir);

      // Real clouds over the eye's visible horizon and toward the view (the sky fades its painted
      // cumulus by this, so a painted and a 3D cloud never share a frame; turning away from a real
      // cloud brings the painted ones back, smoothly by azimuth).
      const eyeR = eyeLocal.length();
      let inView = 0;
      if (v.altSea < 70) {
        const horizon = Math.asin(Math.min(1, R / eyeR));
        const tangent = Math.sqrt(Math.max(0, eyeR * eyeR - R * R));
        // The view's horizontal direction in the cloud frame, and the horizontal half-FOV.
        const ux = eyeLocal.x / eyeR;
        const uy = eyeLocal.y / eyeR;
        const uz = eyeLocal.z / eyeR;
        fwdL.copy(v.forward).applyQuaternion(qInv);
        const fu = fwdL.x * ux + fwdL.y * uy + fwdL.z * uz;
        fwdL.set(fwdL.x - ux * fu, fwdL.y - uy * fu, fwdL.z - uz * fu);
        const fl = fwdL.length();
        const hfov = Math.atan(Math.tan((ctx.camera.fov * DEG) / 2) * ctx.camera.aspect);
        for (let c = 0; c < clusterCount; c++) {
          const o = c * 6;
          const top = R + clusterInfo[o + 5];
          const px = clusterInfo[o] * top - eyeLocal.x;
          const py = clusterInfo[o + 1] * top - eyeLocal.y;
          const pz = clusterInfo[o + 2] * top - eyeLocal.z;
          const d = Math.hypot(px, py, pz);
          if (d > 260) continue;
          let az = 1;
          if (fl > 1e-4) {
            const pu = px * ux + py * uy + pz * uz;
            const hx = px - ux * pu;
            const hy = py - uy * pu;
            const hz = pz - uz * pu;
            const hl = Math.hypot(hx, hy, hz);
            if (hl > 1e-3) {
              const daz = Math.acos(Math.max(-1, Math.min(1, (hx * fwdL.x + hy * fwdL.y + hz * fwdL.z) / (hl * fl))));
              az = 1 - smooth(hfov + 0.2, hfov + 0.6, daz);
            }
          }
          if (az <= 0) continue;
          const nadir = Math.acos(Math.max(-1, Math.min(1, -(px * eyeLocal.x + py * eyeLocal.y + pz * eyeLocal.z) / (d * eyeR))));
          const above = d < tangent ? 1 : smooth(-0.5 * DEG, 2.5 * DEG, nadir - horizon);
          inView = Math.max(inView, above * az);
          if (inView >= 1) break;
        }
      }
      ctx.services.sky.cloudsInView = inView;

      // White-out. inside: the eye within a puff's (lumpy) surface → the veil overlay. near: within
      // FOG_REACH of a surface, or just under a cluster's flat base → the scene fog closes in.
      let inside = 0;
      let near = 0;
      let under = 0;
      const altSea = v.altSea;
      if (altSea > CLOUD_MIN - BASE_MIST - 2 && altSea < CLOUD_MAX + 14 + FOG_REACH) {
        const eyeH = eyeR - R;
        const nearPlane = ctx.camera.near * 1.3;
        for (let i = 0; i < puffCount; i++) {
          const cx = puffs[i * 4];
          const cy = puffs[i * 4 + 1];
          const cz = puffs[i * 4 + 2];
          const r = puffs[i * 4 + 3];
          const dx = eyeLocal.x - cx;
          const dy = eyeLocal.y - cy;
          const dz = eyeLocal.z - cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > (r + FOG_REACH) * (r + FOG_REACH)) continue;
          if (eyeH < puffBase[i]) continue; // under the flat cut: the base mist below handles it
          // The eye as a ball of the near plane's radius: the veil is closed before the near plane
          // can slice a puff open (no see-through hole, no dither).
          const d = Math.sqrt(d2);
          const a = 1 - smooth(0.92, 1.12, (d - nearPlane) / r);
          if (a > inside) inside = a;
          const f = Math.pow(1 - smooth(r * 0.95, r + FOG_REACH, d), 2);
          if (f > near) near = f;
        }
        for (let c = 0; c < clusterCount; c++) {
          const o = c * 6;
          const base = clusterInfo[o + 4];
          if (eyeH > base + 1 || eyeH < base - BASE_MIST) continue;
          const along = eyeLocal.x * clusterInfo[o] + eyeLocal.y * clusterInfo[o + 1] + eyeLocal.z * clusterInfo[o + 2];
          if (along <= 0) continue; // the far side of the planet
          const hd = Math.sqrt(Math.max(0, eyeR * eyeR - along * along)) * ((R + base) / eyeR);
          // Distance to the base disc (outside it horizontally, below it vertically): one smooth
          // field per cumulus, so leaving through the base thins monotonically.
          const ho = Math.max(0, hd - clusterInfo[o + 3]);
          const vo = Math.max(0, base - eyeH);
          const m = Math.pow(1 - smooth(0, BASE_MIST, Math.sqrt(ho * ho + vo * vo)), 1.3) * (1 - smooth(base, base + 1, eyeH));
          if (m > under) under = m;
        }
      }

      // The mist slab: over the city, while the eye moves through the layer (entered moving, not
      // set there), fading away if it lingers. A teleport (setView, shots) never starts it.
      const jump = !hasPrev || tmp.copy(v.eye).sub(prevEye).lengthSq() > 25 * 25;
      const inBand = altSea > SLAB[0] && altSea < SLAB[3];
      const dAlt = Math.abs(altSea - prevAltSea);
      const dt = Math.max(1e-3, ctx.time.realDt);
      if (jump || !inBand) {
        slabOn = false;
        slabIdle = 0;
      } else {
        if (!wasInBand && dAlt > 0.02) slabOn = true;
        slabIdle = dAlt / dt > 1.5 ? 0 : slabIdle + dt;
        if (slabIdle > 0.7) slabOn = false;
      }
      wasInBand = inBand && !jump;
      prevAltSea = altSea;
      const slabT = slabOn ? 1 : 0;
      slabK = jump ? 0 : slabT > slabK ? Math.min(slabT, slabK + dt / 0.1) : Math.max(slabT, slabK - dt / 0.6);
      const slab = slabK * (1 - smooth(SLAB_R0, SLAB_R1, v.cityDist)) * smooth(SLAB[0], SLAB[1], altSea) * (1 - smooth(SLAB[2], SLAB[3], altSea));

      // Leaving through a flat base the veil thins over a few metres of mist (no cut to clear).
      const amountNow = Math.max(inside, slab, under * 0.85);
      const fogNow = Math.max(near, under, amountNow);
      // Temporal release: in at once, out over a few frames (overlay first, fog last). The sky dome
      // reads the same smoothed values at draw time, so silhouettes fade into the sky with the fog.
      const rel = ctx.time.realDt;
      veilS = jump ? amountNow : Math.max(amountNow, veilS * Math.exp(-rel / VEIL_RELEASE));
      mistS = jump ? fogNow : Math.max(fogNow, veilS, mistS * Math.exp(-rel / MIST_RELEASE));
      if (veilS < 1e-3) veilS = 0;
      if (mistS < 1e-3) mistS = 0;
      const amount = veilS;
      const fogAmt = mistS;
      const vm = veilMat.uniforms;
      vm.uAmount.value = amount;
      veil.visible = amount > 0.002;
      block.visible = amount > 0.985;
      ctx.services.sky.veil = amount;
      ctx.services.sky.mist = fogAmt;

      // Travel: phase (distance flown) and the screen point the eye moves toward.
      if (!jump) {
        vel.copy(v.eye).sub(prevEye);
        const dist = vel.length();
        if (dist > 1e-3) {
          phase += dist * 0.07;
          vel.multiplyScalar(1 / dist);
          if (vel.dot(v.forward) > 0.25) {
            tmp.copy(v.eye).addScaledVector(vel, 10).project(ctx.camera);
            foeT.set(Math.min(1.2, Math.max(-0.2, tmp.x * 0.5 + 0.5)), Math.min(1.2, Math.max(-0.2, tmp.y * 0.5 + 0.5)));
          } else foeT.set(0.5, -0.2);
          foe.lerp(foeT, 0.35);
        }
      }
      prevEye.copy(v.eye);
      hasPrev = true;

      if (amount > 0.002) {
        vm.uPhase.value = phase;
        vm.uAspect.value = ctx.camera.aspect;
        // Wisps only well inside: gone the moment the eye is out (no streaks over a clear city).
        vm.uWisp.value = smooth(0.3, 0.75, amountNow) * smooth(0.5, 0.9, amount);
      }
      pu.uFogMin.value = fogAmt > 0.002 ? PUFF_FOG_MIN : 0;
      if (fogAmt > 0.002) {
        // Fog the scene by depth toward the mist: visibility closes in log-space from the sky's
        // aerial fog to a few metres, so the city fades into the cloud instead of showing crisp
        // through a flat overlay.
        const fog = ctx.services.sky.fog;
        if (fog) {
          fog.color.lerp(mist, mistBlend(fogAmt));
          const far = Math.exp(mix(Math.log(Math.max(VEIL_VIS + 1, fog.far)), Math.log(VEIL_VIS), Math.pow(fogAmt, 1.6)));
          fog.near = Math.min(fog.near, far * mix(0.35, 0.05, smooth(0, 0.6, fogAmt)));
          fog.far = far;
        }
      }
    },

    onTimeJump() {
      // Everything derives from time.render: nothing to rebuild.
    },

    dispose(ctx: LBContext) {
      if (ctx.uniforms.lbCloudShadow.value === tex) {
        ctx.uniforms.lbCloudShadow.value = null;
        ctx.uniforms.lbCloudShadowOn.value = 0;
      }
      ctx.services.sky.veil = 0;
      ctx.services.sky.mist = 0;
      ctx.services.sky.cloudsInView = 0;
      for (const m of lod?.meshes ?? []) m.removeFromParent();
      veil?.removeFromParent();
      block?.removeFromParent();
      lod?.dispose();
      puffMat?.dispose();
      veilMat?.dispose();
      blockMat?.dispose();
      tex?.dispose();
      lod = null;
      veil = block = null;
      puffMat = veilMat = blockMat = null;
      tex = null;
      ready = false;
    },
  };
}

/** Unit direction where the scripted dive's eye crosses `altSea` (m above sea level), and the
 *  travel direction there (unit, tangent). */
function diveCrossing(ctx: LBContext, altSea: number): { at: Vec3; travel: Vec3 } | null {
  const planet = ctx.world.planet;
  let prev = diveAt(ctx, 0);
  let prevDir = dirFromLatLon(prev.lat, prev.lon);
  let prevH = prev.alt + planet.surfaceAt(prevDir);
  for (let i = 1; i <= 400; i++) {
    const cur = diveAt(ctx, i / 400);
    const dir = dirFromLatLon(cur.lat, cur.lon);
    const h = cur.alt + planet.surfaceAt(dir);
    if (prevH >= altSea && h < altSea) {
      const t = (prevH - altSea) / Math.max(1e-6, prevH - h);
      const at = normalize3(v3(), addScaled3(v3(), prevDir, addScaled3(v3(), dir, prevDir, -1), t));
      const d = addScaled3(v3(), dir, prevDir, -1);
      addScaled3(d, d, at, -dot3(d, at));
      return { at, travel: normalize3(d) };
    }
    prev = cur;
    prevDir = dir;
    prevH = h;
  }
  return null;
}

/**
 * Forced clusters: the dive's cloud and two small ones flanking the `clouds` shot.
 *
 * The dive's cloud stands BESIDE the track, on the side away from the city, with a low crown: on
 * the way down it stays at the edge of the frame instead of hiding downtown, and only in the last
 * half second does its wall slide past. A small lobe reaches into the track (two little puffs and a
 * bridge to the body), so the camera cuts through the cloud's edge: a brief white-out with a thin
 * gap between the two puffs, then out beside the wall, under the belly.
 */
function anchors(ctx: LBContext): CloudAnchor[] {
  const out: CloudAnchor[] = [];
  const mid = (CLOUD_MIN + CLOUD_MAX) / 2;
  const rad = R + mid;
  const c0 = diveCrossing(ctx, 43);
  if (c0) {
    const side = normalize3(v3(), cross3(v3(), c0.travel, c0.at));
    const toCity = addScaled3(v3(), CITY_AXIS, c0.at, -1);
    const s = dot3(toCity, side) > 0 ? -1 : 1; // away from the city
    const at = (base: Vec3, lateral: number, along: number) => {
      const d = addScaled3(v3(), base, side, (s * lateral) / rad);
      return normalize3(addScaled3(d, d, c0.travel, along / rad));
    };
    // The body: a modest cumulus well off the track (its nearest lobes ~3 m from it).
    out.push({ dir: at(c0.at, 15, -2), radius: 8, base: CLOUD_MIN + 1, top: CLOUD_MAX - 2 });
    // The cloudlet the camera punches through: a tiny flat-based cumulus of five small puffs whose
    // bulk sits below and outboard of the track, so on the way in it hangs under the skyline, not
    // over it. The eye cuts its inner top corner and leaves through the flat base (~0.15 s inside).
    const puff = (alt: number, lateral: number, along: number, r: number) => {
      const c = diveCrossing(ctx, alt) ?? c0;
      return { dir: at(c.at, lateral, along), alt, r };
    };
    out.push({
      dir: at(c0.at, 2, 0),
      radius: 5,
      base: 40.9,
      bare: true,
      extra: [
        puff(43.3, 0.6, 0, 2.0), // the corner the eye cuts
        puff(42.0, 0.8, 0, 1.8), // and on down through it to the base
        puff(42.8, 3.0, -0.6, 2.3), // the cloudlet's body, outboard
        puff(41.9, 4.6, 1.4, 1.8),
        puff(44.4, 2.6, -1.2, 1.6), // a lump on top
      ],
    });
  }
  // The `clouds` shot hovers at the top of the layer looking steeply down at the city: a cluster
  // just west of the camera's footprint fills the left of the frame, the city shows past it.
  const shot = SHOTS.clouds?.view(ctx);
  if (shot) {
    const up = dirFromLatLon(shot.lat, shot.lon);
    const fwd = headingVector(up, ((shot.heading ?? 0) * Math.PI) / 180);
    const right = cross3(v3(), fwd, up); // fwd × up = right-hand side
    // The shot looks down at ~−70°: a cloud in the layer can only frame its edges. One just left of
    // the footprint, a little behind, walls the left of the frame (with lobes and a shaded belly).
    const d = addScaled3(v3(), up, right, -17 / rad);
    addScaled3(d, d, fwd, -2 / rad);
    out.push({ dir: normalize3(d), radius: 12, base: CLOUD_MIN - 1.5 });
    // A smaller one ahead and to the right, low: peeks into the top-right corner.
    const e = addScaled3(v3(), up, right, 13 / rad);
    addScaled3(e, e, fwd, 15 / rad);
    out.push({ dir: normalize3(e), radius: 7, base: CLOUD_MIN - 2 });
  }
  return out;
}
