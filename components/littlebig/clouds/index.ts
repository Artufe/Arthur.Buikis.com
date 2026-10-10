// Clouds (A3, v2 S1): puffy toon cumulus clusters on the cloud layer (36–48 m), drifting slowly
// around the city's axis, with soft shadows on the ground (the toon kit's lbCloudShadow hook), and
// the falling-through-the-clouds overlay whenever the eye crosses the layer or a puff.
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
//   - Mist: per frame the eye is tested against the puffs. Near one (within ~5 m of its surface)
//     the scene fog closes toward the mist colour, so the city fades by depth before the eye goes
//     in and after it comes out, and puff surfaces right at the eye melt into the same mist.
//   - Falling through the clouds (v2): really crossing the layer (anywhere: zoom, dive, a ride, the
//     bird; a zoom that stops inside it does not count) or flying into a puff (anticipated ~0.2 s
//     ahead, so the overlay blooms out of the real cloud the eye is about to enter instead of
//     replacing it in one frame) starts an episode (crossing.ts): inked cartoon puffs stream outward
//     from the point the eye flies toward, fill the frame, hold (~0.3 s at least half covered) and
//     part again from the middle, on screen wherever the eye flies (flying backward, the other way
//     round: in from the corners, away into the focus) (shaders.ts: a scalloped body, speed streaks
//     and one instanced sprite per puff, in log-polar cells round the focus or, with the focus
//     off-screen, a lateral grid streaming across). Inside a puff the same overlay holds as the
//     white-out. It is ONE overlay (the v1 veil is gone), drawn last in the scene pass over
//     everything at one far depth; the followed thing (camera subject / ridden Trackable) is then
//     drawn again on top of it (its owner's objects re-drawn, scissored to it: pixel-exact, no window, no porthole; found by
//     subject.ts), with a POP target ring when its body is a few pixels; the puffs in front of it
//     dissolve and the white-out fog is pushed past it. Reduced motion: the body alone fades,
//     rate-limited both ways, through teleports too (never a flash, never a cut).

import {
  type BufferAttribute,
  BufferGeometry,
  Camera,
  Color,
  DataTexture,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  LinearFilter,
  Matrix3,
  Matrix4,
  Mesh,
  type Object3D,
  Quaternion,
  RedFormat,
  ShaderMaterial,
  SphereGeometry,
  UniformsLib,
  UniformsUtils,
  UnsignedByteType,
  AlwaysDepth,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { PALETTE } from '../render/palette';
import { LAYER_NO_INK, type LBContext, type System, type Trackable, type TrackPose } from '../core/contracts';
import { CLOUD_MAX, CLOUD_MIN, R } from '../world/config';
import { addScaled3, cross3, dirFromLatLon, dot3, headingVector, normalize3, v3, type Vec3 } from '../world/sphere';
import { moonDirection } from '../world/sun';
import { cloudsShotView, DIVE_CROSS_T, diveCrossing } from './dive-anchors';
import { CITY_AXIS, type CloudAnchor, coverageMapSteps, layoutClouds, SHELL_R } from './layout';
import { airSpace, cloudLift, CLOUD_PAL_BELLY, CLOUD_PAL_E, CLOUD_PAL_LIT, CLOUD_PAL_RIM, CLOUD_PAL_SHADE, cloudPalette, mistBlend, mistColor, mix, skyDipSin, smooth, spaceAmount } from '../sky/rig';
import { PuffLod } from './puffs';
import { crossBodyFrag, crossBodyVert, crossMarkFrag, crossMarkVert, crossPuffFrag, crossPuffVert, crossStreakFrag, crossStreakVert, puffFrag, puffVert } from './shaders';
import { SubjectObjects } from './subject';
import { createCrossing, CROSS_TIMING, CROSS_TIMING_RM, forceCrossing, frontRange, isTeleport, resetCrossing, RM_CAP, rmFadeStep, Stage, stepCrossing } from './crossing';
import { hyp3 } from '../world/hyp';

const DEG = Math.PI / 180;
/** Default drift (deg/s) about the city's axis. */
const CLOUD_DRIFT = 0.25;
const SHADOW_W = 1024;
const SHADOW_H = 512;
/** Reveal: the whole layer pops in over this window (s), cluster by cluster. */
const REVEAL_SPAN = 1.6;
const REVEAL_DUR = 0.9;
/** Fog reach (m from a puff's surface): the scene starts to fade into the mist this far out. */
const FOG_REACH = 5;
/** Mist under (and just beside) a cluster's flat base (m). */
const BASE_MIST = 4;
/**
 * Scene visibility (fog far, m) at full white-out: far enough that the cluster's other puffs still
 * read as soft shapes through the mist while passing through one (at 9 m the pass was a flat
 * lavender card that read as a glitch at tile size).
 */
const VEIL_VIS = 16;
/**
 * The falling-through-the-clouds episode fires on a real CROSSING of the layer (altitude above sea
 * level, m): the eye inside the band (or jumping over it in a frame), moving vertically faster than
 * CROSS_VZ (m/s), and headed out of its FAR side: its altitude predicted CROSS_LEAD s ahead (in log
 * space, which is how the zoom spring moves; CROSS_LEAD_FLY s, linear, for the bird and rides) lies
 * beyond the band. A zoom that stops inside the layer
 * to look at the clouds never fires it. Each direction re-arms once the eye is back on the side it
 * started from (above the layer's middle and climbing, or out of the top; and the mirror image), so
 * a bird porpoising in the layer fires at most once.
 */
const CROSS_BAND = [CLOUD_MIN - 2, CLOUD_MAX + 2];
const CROSS_MID = (CLOUD_MIN + CLOUD_MAX) / 2;
const CROSS_VZ = 1.2;
const CROSS_LEAD = 0.3;
const CROSS_LEAD_FLY = 0.8;
/** The eye this far (m) outside the band ends the hold early (a fast zoom shows the city rising). */
const CROSS_CLEAR = 6;
/**
 * Riding something that is off-screen when the crossing fires and cannot be re-drawn on top of the
 * overlay (no objects found): the episode waits up to this long (s) for it to come into frame, so
 * it is not lost behind the clouds; if it never shows, the crossing passes without one (contact
 * with a real puff still whites out). A subject that is re-drawn never waits.
 */
const CROSS_WAIT = 0.4;
/**
 * During an episode the clouds keep streaming at least this fast (m/s): the hold never freezes, the
 * lumps visibly rush outward past the edges (at 8 the held frame read as a still wall of circles).
 */
const STREAM_MIN = 14;
/** The puffs' smear along the motion: at rest, and added at full speed (shaders.ts uStretch). */
const STRETCH = [0.05, 0.2];
/** Speed streaks over the puffs (shaders.ts crossStreak*): count (high, low tier). */
const STREAKS = [44, 24];
/** Contact (the eye inside a puff, 0..1) rising past this starts an episode too. */
const CONTACT_TRIGGER = 0.3;
/**
 * Contact release (s): leaving a cloud the contact floor thins over ~4 frames and the scene fog
 * opens over ~10 more (overlay first, fog last). Entering is instant (the near plane must never
 * slice a puff open).
 */
const VEIL_RELEASE = 0.12;
const MIST_RELEASE = 0.4;
/** Stream rates (ln-radius per metre flown): the near puffs rush past, the far ones lag (parallax). */
const STREAM_NEAR = 1 / 7;
const STREAM_FAR = 1 / 17;
/** Overlay puff sprites: cell columns × row slots per layer (far, near); see shaders.ts. */
const SPRITES = [
  { cols: 11, rows: 11 },
  { cols: 6, rows: 7 },
];
/**
 * The lateral set (shaders.ts crossPuffVert, the focus off-screen): grid columns × rows per layer
 * (far, near), enough to cover the frame's diagonal at their cell size (0.26, 0.36 of the height)
 * with a cell of margin; the closing caps (backward, the last gap) are three more near puffs.
 */
const LATERAL = [
  { cols: 10, rows: 10 },
  { cols: 8, rows: 8 },
];
const CAPS = 3;
/**
 * The lateral set takes over as the focus leaves the frame: from LAT_OUT[0] to LAT_OUT[1] outside it
 * (height units), eased over LAT_EASE s.
 */
const LAT_OUT = [0.02, 0.2];
const LAT_EASE = 0.08;
/**
 * The overlay's one depth (NDC): just short of the far plane (4 steps of a 24-bit buffer), so post
 * sees one flat far surface over the whole overlay (no ink inside it, no night grade by a fake
 * height) and the followed thing re-drawn over it is inked against it like against the sky.
 */
const Z_FAR = 1 - 5e-7;
/** The re-draw's scissor round the followed thing: its projected bounding circle × this, + px. */
const CLIP_K = 1.15;
const CLIP_PX = 6;
/**
 * A far subject (its body's radius under MARK_PX[1] px, fading in from MARK_PX[0]: an on/off
 * decision, a pale half-faded ring looked washed out) gets a POP target ring round it while covered:
 * amber between ink lines, MARK_MIN to MARK_MAX px from its centre (a subject that cannot be re-drawn
 * once got a 260 px ring, sized by its bounding radius with no cap).
 */
const MARK_PX = [12, 10];
const MARK_MIN = 11;
const MARK_MAX = 40;
/** The scan for the objects drawing a subject that declares none: instance or mesh centre within this of its pose (m, + radius × 0.8). */
const SCAN_REACH = 1.8;
/** …in instanced meshes up to this many instances (ground cover and forests are never it). */
const SCAN_MAX_INSTANCES = 3000;
/**
 * Flying into a puff is seen coming this far ahead (× the fill time), at closing speeds above
 * ANT_SPEED (m/s): the episode starts before contact, so the puffs bloom out of the cloud the eye is
 * about to enter (it is ahead, at the focus of expansion) and the frame is covered as it goes in.
 */
const ANT_LEAD = 0.85;
const ANT_SPEED = 2;
/** The puffs' own fog far plane is floored at this while the white-out fog is closed (m). */
const PUFF_FOG_MIN = 30;

export function createCloudsSystem(): System {
  let lod: PuffLod | null = null;
  // The overlay's draws: body, far puffs, speed streaks, near puffs; then the ring round the followed
  // thing, whose onAfterRender re-draws that thing on top (redrawSubject, below).
  let crossBody: Mesh | null = null;
  let crossPuffs: Mesh | null = null;
  let crossPuffsFar: Mesh | null = null;
  let crossStreaks: Mesh | null = null;
  let crossMark: Mesh | null = null;
  let puffMat: ShaderMaterial | null = null;
  let bodyMat: ShaderMaterial | null = null;
  const crossMeshes: Mesh[] = [];
  // The followed thing's own scene objects (contract `Trackable.objects`, else found by a scan at
  // its pose), re-drawn over the overlay; the scissor round it (drawing-buffer px; z < 0: none).
  const subjects = new SubjectObjects();
  const subjObjs = subjects.objects;
  // Per instanced mesh drawing a subject: a one-instance stand-in sharing its geometry's buffers and
  // its material, into which the subject's instance is copied each frame, so that instance alone is
  // re-drawn (null: cannot be done, e.g. interleaved instance data; the whole mesh is drawn, scissored).
  const proxies = new Map<InstancedMesh, { mesh: InstancedMesh; pairs: Array<[BufferAttribute, BufferAttribute]> } | null>();
  let subjBody = 0;
  let redraw = false;
  const scissor = new Vector4(0, 0, -1, 0);
  const scissorRT = new Vector4();
  const mark = new Vector4();
  const markC = new Vector2();
  let rmS = 0;
  let tex: DataTexture | null = null;
  let puffs: Float32Array | null = null;
  /** Per puff: its cluster's flat base altitude (the white-out test squashes like the shader). */
  let puffBase: Float32Array | null = null;
  let puffCount = 0;
  /** Per cluster: axis x, y, z (cloud frame, unit), base footprint radius, base altitude, top altitude. */
  let clusterInfo = new Float32Array(0);
  let clusterCount = 0;
  let drift = { value: CLOUD_DRIFT }; // deg/s (param)
  let shadowK = { value: 0.6 };
  let bump = { value: 0.2 };
  let mask = { value: 0 };
  let tIn = { value: CROSS_TIMING.tIn };
  let tHold = { value: CROSS_TIMING.hold };
  let tOut = { value: CROSS_TIMING.tOut };
  let force = { value: 0 };
  let forceLat = { value: 0 };
  let crossParts = { value: 3 };
  const timing = { ...CROSS_TIMING };
  let ready = false;
  let hasPrev = false;
  let veilS = 0;
  let mistS = 0;
  // The episode (crossing.ts) and what fires it.
  const ep = createCrossing();
  let armedDown = false;
  let armedUp = false;
  let wait = 0;
  let waitDir = 0;
  let prevAltSea = 0;
  let prevContact = 0;
  let lastSign = 1;
  const range = new Vector2(0, 1);
  const dbSize = new Vector2();
  const step3 = new Vector3();
  const ndc = new Vector3();
  const phase = new Vector2();
  const phaseL = new Vector2();
  const flow = new Vector2(0, 1);
  let latS = 0;
  let wasShown = false;
  let streak = 0;
  const prevEye = new Vector3();
  const vel = new Vector3();
  const velV = new Vector3();
  const foe = new Vector2(0.5, 0.35);
  const foeT = new Vector2(0.5, 0.35);
  /** The followed thing for the puffs' tunnel (world centre, radius; w = 0 off). */
  const holeW = new Vector4();
  const light = new Vector2(0, 1);
  const light3 = new Vector3(0, 0.8, 0.55);
  const bellyT = new Color();
  const rimK = new Color();
  const bodyC = new Color();
  const kbs = new Vector2(0.62, 0.55);
  const subj = new Vector3();
  const subjV = new Vector3();
  const subjPose: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
  const moonDir = new Vector3();
  const drift3 = new Matrix3();
  const mist = new Color();
  const mistLit = new Color();
  const palLit = new Color();
  const palShade = new Color();
  const palBelly = new Color();
  const palRim = new Color();
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

  /** The followed thing's centre into `subj`; returns its radius (0 = none). */
  const subject = (ctx: LBContext): number => {
    const cam = ctx.services.camera;
    const r = cam.subject?.(subj) ?? 0;
    if (r > 0) return r;
    const id = ctx.view.ride;
    if (!id) return 0;
    const t = ctx.services.track.get(id);
    if (!t || !t.pose(ctx, subjPose)) return 0;
    subj.copy(subjPose.pos);
    return t.radius;
  };

  const standIns = new Set<Mesh>();
  const scanOpts = { reach: SCAN_REACH, maxInstances: SCAN_MAX_INSTANCES, skip: (m: Mesh) => crossMeshes.includes(m) || standIns.has(m) || (lod?.meshes.includes(m as InstancedMesh) ?? false) };

  /**
   * The scene objects that draw the followed thing into subjObjs (subject.ts): its Trackable's
   * `objects` or the camera's `subjectObjects()` (the bird), else a scan for the mesh at its pose,
   * retried by frames (every frame while `urgent`) until found.
   */
  const resolveObjects = (ctx: LBContext, sr: number, urgent: boolean) => {
    const id = ctx.view.ride;
    const key = id ?? (ctx.view.mode === 'bird' ? 'bird' : '');
    const t: Trackable | undefined = id ? ctx.services.track.get(id) : undefined;
    const declared = t?.objects?.length ? t.objects : !id ? ctx.services.camera.subjectObjects?.() : undefined;
    subjBody = t?.bodyRadius ?? sr;
    subjects.update(ctx.scene, key, declared, subj, sr, urgent, scanOpts);
    if (process.env.NODE_ENV !== 'production') (ctx.debug as unknown as { cloudsSubject?: unknown }).cloudsSubject = subjects.debug();
  };

  /**
   * The stand-in for an instanced mesh (built once, on its first re-draw): a one-instance copy that
   * shares its geometry's buffers and its material (so its program), kept in the scene at a count of
   * 0, so three uploads what is copied into it in the frame's projection and draws nothing then; the
   * re-draw draws it with a count of 1. (renderBufferDirect alone uploads nothing.)
   */
  const proxyFor = (ctx: LBContext, src: InstancedMesh) => {
    let p = proxies.get(src);
    if (p !== undefined) return p;
    p = null;
    const g = src.geometry;
    const geo = new BufferGeometry();
    const pairs: Array<[BufferAttribute, BufferAttribute]> = [];
    let ok = true;
    for (const name in g.attributes) {
      const at = g.attributes[name] as BufferAttribute & { isInterleavedBufferAttribute?: boolean; isInstancedBufferAttribute?: boolean; meshPerAttribute?: number };
      if (at.isInterleavedBufferAttribute) {
        ok = false;
        break;
      }
      if (at.isInstancedBufferAttribute) {
        const Arr = at.array.constructor as new (n: number) => Float32Array;
        const dst = new InstancedBufferAttribute(new Arr(at.itemSize), at.itemSize, at.normalized, at.meshPerAttribute);
        geo.setAttribute(name, dst);
        pairs.push([at, dst]);
      } else geo.setAttribute(name, at);
    }
    if (ok) {
      if (g.index) geo.setIndex(g.index);
      for (const gr of g.groups) geo.addGroup(gr.start, gr.count, gr.materialIndex);
      geo.setDrawRange(g.drawRange.start, g.drawRange.count);
      const mesh = new InstancedMesh(geo, src.material, 1);
      if (src.instanceColor) {
        mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(src.instanceColor.itemSize), src.instanceColor.itemSize);
        pairs.push([src.instanceColor, mesh.instanceColor]);
      }
      pairs.push([src.instanceMatrix, mesh.instanceMatrix]);
      // (The object flags three keys programs by match the owner's: no new program.)
      mesh.receiveShadow = src.receiveShadow;
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.mask = src.layers.mask;
      mesh.count = 0;
      mesh.visible = false;
      mesh.name = `${src.name} (re-drawn over the clouds)`;
      ctx.scene.add(mesh);
      standIns.add(mesh);
      p = { mesh, pairs };
    } else geo.dispose();
    proxies.set(src, p);
    return p;
  };

  /**
   * Right before the scene is projected (scene.onBeforeRender: after every system's update, so the
   * owners' instances are this frame's, and before three uploads buffers): find the subject's
   * instance in each instanced object and copy it into that object's stand-in.
   */
  let subjR = 0;
  const beforeRender = (ctx: LBContext) => {
    for (const p of proxies.values()) if (p) p.mesh.visible = false;
    if (!redraw) return;
    subjects.locate(subj, subjR, SCAN_REACH);
    for (let k = 0; k < subjObjs.length; k++) {
      const src = subjObjs[k] as InstancedMesh;
      const i = subjects.instance[k] ?? -1;
      if (!src.isInstancedMesh || i < 0 || !src.visible) continue;
      const p = proxyFor(ctx, src);
      if (!p) continue;
      for (const [from, to] of p.pairs) {
        const n = from.itemSize;
        const fa = from.array;
        const ta = to.array as Float32Array;
        for (let c = 0; c < n; c++) ta[c] = fa[i * n + c];
        to.needsUpdate = true;
      }
      p.mesh.matrixWorld.copy(src.matrixWorld);
      p.mesh.visible = true;
    }
  };
  let sceneHookPrev: Object3D['onBeforeRender'] | null = null;
  let sceneHook: Object3D['onBeforeRender'] | null = null;

  /**
   * Draw the followed thing's objects again, now (the ring mesh's onAfterRender: after the overlay,
   * inside the scene pass), scissored to its projected bounding circle: depth-tested against the
   * overlay's far plane, so it lands on top of it, self-occluded. An instanced owner mesh is drawn
   * through its stand-in, holding the subject's instance alone (other cars in the square stay under
   * the clouds). As three's own renderObject does it, minus the after-hook.
   */
  const redrawSubject = (ctx: LBContext, camera: Camera) => {
    if (!redraw || !subjObjs.length) return;
    const r = ctx.renderer;
    const rt = r.getRenderTarget();
    const scissorWas = rt ? rt.scissorTest : r.getScissorTest();
    const clip = scissor.z > 0 && !scissorWas;
    // Unfogged: over the overlay the aerial fog that hides a far plane against the sky made it a
    // pale ghost (three refreshes a material's fog uniforms from scene.fog when it switches to it).
    const fog = ctx.services.sky.fog;
    const fogNear = fog?.near ?? 0;
    const fogFar = fog?.far ?? 0;
    if (fog) {
      fog.near = 1e7;
      fog.far = 2e7;
    }
    if (clip) {
      // (Drawing-buffer px; a render target of another size, scaled.)
      const k = rt ? rt.width / Math.max(1, dbSize.x) : 1;
      r.state.scissor(scissorRT.set(Math.floor(scissor.x * k), Math.floor(scissor.y * k), Math.ceil(scissor.z * k), Math.ceil(scissor.w * k)));
      r.state.setScissorTest(true);
    }
    for (let k = 0; k < subjObjs.length; k++) {
      const src = subjObjs[k] as Mesh;
      if (!src.visible) continue;
      let m: Mesh = src;
      if ((src as InstancedMesh).isInstancedMesh) {
        // Its instance alone, from the stand-in (none in reach this frame: not drawn; no stand-in
        // possible: the whole mesh, scissored).
        if ((subjects.instance[k] ?? -1) < 0) continue;
        const p = proxies.get(src as InstancedMesh);
        if (p) {
          if (!p.mesh.visible) continue;
          p.mesh.count = 1;
          m = p.mesh;
        }
      }
      src.onBeforeRender(r, ctx.scene, camera, src.geometry, src.material as never, null as never);
      m.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, m.matrixWorld);
      m.normalMatrix.getNormalMatrix(m.modelViewMatrix);
      const geo = m.geometry;
      if (Array.isArray(m.material)) {
        for (const grp of geo.groups) {
          const mt = m.material[grp.materialIndex ?? 0];
          if (mt?.visible) r.renderBufferDirect(camera, ctx.scene, geo, mt, m, grp);
        }
      } else if (m.material.visible) r.renderBufferDirect(camera, ctx.scene, geo, m.material, m, null as never);
      if (m !== src) (m as InstancedMesh).count = 0;
    }
    if (clip) r.state.setScissorTest(false);
    if (fog) {
      fog.near = fogNear;
      fog.far = fogFar;
    }
  };

  return {
    name: 'clouds',
    stage: 2,
    async init(ctx: LBContext) {
      drift = ctx.params.number('clouds.drift', { label: 'cloud drift (deg/s)', min: 0, max: 3, value: CLOUD_DRIFT });
      shadowK = ctx.params.number('clouds.shadow', { label: 'cloud shadow strength', min: 0, max: 1, value: 0.6 });
      bump = ctx.params.number('clouds.bump', { label: 'cloud bump', min: 0, max: 1, value: 0.2 });
      mask = ctx.params.number('clouds.mask', { label: 'debug: clouds as flat magenta', min: 0, max: 1, value: 0 });
      tIn = ctx.params.number('clouds.crossIn', { label: 'cloud crossing: ease in (s)', min: 0.02, max: 1, value: CROSS_TIMING.tIn });
      tHold = ctx.params.number('clouds.crossHold', { label: 'cloud crossing: hold (s)', min: 0, max: 2, value: CROSS_TIMING.hold });
      tOut = ctx.params.number('clouds.crossOut', { label: 'cloud crossing: ease out (s)', min: 0.05, max: 2, value: CROSS_TIMING.tOut });
      force = ctx.params.number('clouds.force', { label: 'debug: hold a crossing at this cover (perf A/B)', min: 0, max: 1, value: 0 });
      forceLat = ctx.params.number('clouds.forceLat', { label: 'debug: with clouds.force, the focus off-screen (the lateral puff set; perf A/B)', min: 0, max: 1, value: 0 });
      crossParts = ctx.params.number('clouds.crossParts', { label: 'debug: overlay parts drawn (1 body, 2 puffs, 3 both; perf A/B)', min: 0, max: 3, value: 3 });

      const layout = layoutClouds({ seed: ctx.world.seed, clusters: 30, anchors: anchors(drift.value) });
      puffs = layout.puffs;
      puffCount = layout.count;
      puffBase = new Float32Array(puffCount);
      for (let i = 0; i < puffCount; i++) puffBase[i] = layout.clusters[layout.cluster[i]].base;
      await ctx.yield();

      // Shadow coverage map.
      const covSteps = coverageMapSteps(layout, SHADOW_W, SHADOW_H);
      let covStep = covSteps.next();
      while (!covStep.done) {
        await ctx.yield();
        covStep = covSteps.next();
      }
      const cov = covStep.value;
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
            uHole: { value: holeW },
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
          rb = Math.max(rb, hyp3(dx, dy, dz) + p[i * 4 + 3]);
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

      // The falling-through-the-clouds overlay, drawn last in the scene pass over everything at one far
      // depth (shaders.ts): a full-screen body, one instanced sprite per cartoon puff, speed streaks;
      // then the ring round the followed thing, whose onAfterRender re-draws it on top.
      const cu = {
        uFill: { value: 0 },
        uOpen: { value: 0 },
        uContact: { value: 0 },
        uRange: { value: range },
        uFoe: { value: foe },
        uAspect: { value: 1.6 },
        uPhase: { value: phase },
        uPhaseL: { value: phaseL },
        uFlow: { value: flow },
        uLat: { value: 0 },
        uDir: { value: 1 },
        uZ: { value: Z_FAR },
        uTone: { value: 1 },
        uStretch: { value: STRETCH[0] },
        uBellyT: { value: bellyT },
        uRimK: { value: rimK },
        uBodyC: { value: bodyC },
        uKBS: { value: kbs },
        uRes: { value: dbSize },
        uInk: { value: new Color().copy(PALETTE.ink) },
        uMark: { value: mark },
        uMarkC2: { value: markC },
        uMarkC: { value: new Color('#FFB84D') },
        uFade: { value: 1 },
        uLight: { value: light },
        uStreak: { value: 0 },
        uLit: { value: palLit },
        uShade: { value: palShade },
        uBelly: { value: palBelly },
        uRim: { value: palRim },
      };
      // Over the scene whatever its depth, writing the one far depth. (Reduced motion: a still opacity
      // fade, so no depth write; post's veil fades the ink instead.)
      const overlay = { transparent: true, depthTest: true, depthFunc: AlwaysDepth, depthWrite: !ctx.reducedMotion, uniforms: cu };
      bodyMat = ctx.track(new ShaderMaterial({ name: 'cloud crossing', vertexShader: crossBodyVert, fragmentShader: crossBodyFrag, ...overlay }));
      const spriteMat = ctx.track(new ShaderMaterial({ name: 'cloud crossing puffs', vertexShader: crossPuffVert, fragmentShader: crossPuffFrag, ...overlay }));
      const streakMat = ctx.track(new ShaderMaterial({ name: 'cloud crossing streaks', vertexShader: crossStreakVert, fragmentShader: crossStreakFrag, uniforms: cu, transparent: true, depthTest: false, depthWrite: false }));
      const markMat = ctx.track(new ShaderMaterial({ name: 'cloud crossing mark', vertexShader: crossMarkVert, fragmentShader: crossMarkFrag, uniforms: cu, transparent: true, depthTest: false, depthWrite: false }));
      const vgeo = ctx.track(new BufferGeometry());
      vgeo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      // Each sprite a quad the vertex shader fits round the puff's domes (shaders.ts). Two meshes,
      // the far layer and the near one, so the speed streaks run between them. Back to front (the
      // order they blend in), in each: radial, inner rows (small, near the focus) first; then lateral,
      // upstream rows first; the near mesh ends with the caps. Only one of the radial and lateral
      // sets draws at a time (the other's sprites collapse to nothing in the vertex shader). Low tier
      // (phones): the near layer only, the body filling between: about half the overlay's overdraw,
      // the cost it has.
      const quad = new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3);
      const puffGeo = (layer: number) => {
        const g = ctx.track(new InstancedBufferGeometry());
        g.setAttribute('position', quad);
        g.setIndex([0, 1, 2, 0, 2, 3]);
        const cells: number[] = [];
        const L = SPRITES[layer];
        for (let j = 0; j < L.rows; j++) for (let i = 0; i < L.cols; i++) cells.push(layer, i, j, 0);
        const T = LATERAL[layer];
        for (let j = 0; j < T.rows; j++) for (let i = 0; i < T.cols; i++) cells.push(layer, i, j, 1);
        if (layer === 1) for (let i = 0; i < CAPS; i++) cells.push(1, i, 0, 2);
        g.setAttribute('aCell', new InstancedBufferAttribute(new Float32Array(cells), 4));
        g.instanceCount = cells.length / 4;
        return g;
      };
      // Streaks: a quad each (x 0..1 along, y −1..1 across); per streak an angle (evenly spread,
      // jittered), a phase and a size.
      const tgeo = ctx.track(new InstancedBufferGeometry());
      tgeo.setAttribute('position', new Float32BufferAttribute([0, -1.6, 0, 1, -1.6, 0, 1, 1.6, 0, 0, 1.6, 0], 3));
      tgeo.setIndex([0, 1, 2, 0, 2, 3]);
      const nS = STREAKS[hi ? 0 : 1];
      const st = new Float32Array(nS * 3);
      for (let i = 0; i < nS; i++) {
        const h1 = frac(Math.sin(i * 12.9898 + 4.1) * 43758.5453);
        const h2 = frac(Math.sin(i * 78.233 + 1.3) * 43758.5453);
        const h3 = frac(Math.sin(i * 37.719 + 7.7) * 43758.5453);
        st[i * 3] = ((i + 0.15 + 0.7 * h1) / nS) * Math.PI * 2;
        st[i * 3 + 1] = h2;
        st[i * 3 + 2] = h3;
      }
      tgeo.setAttribute('aStreak', new InstancedBufferAttribute(st, 3));
      tgeo.instanceCount = nS;
      crossBody = new Mesh(vgeo, bodyMat);
      crossPuffsFar = hi ? new Mesh(puffGeo(0), spriteMat) : null;
      crossPuffs = new Mesh(puffGeo(1), spriteMat);
      crossStreaks = new Mesh(tgeo, streakMat);
      crossMark = new Mesh(vgeo, markMat);
      // The thing followed, on top of it all: right after the ring, inside the scene pass.
      crossMark.onAfterRender = (_r, _s, camera) => redrawSubject(ctx, camera);
      // Back to front: the body, the far puffs, the streaks rushing past over them, the near puffs,
      // the ring (and the re-draw).
      const parts: Array<[Mesh | null, string]> = [
        [crossBody, 'cloud crossing'],
        [crossPuffsFar, 'cloud crossing far puffs'],
        [crossStreaks, 'cloud crossing streaks'],
        [crossPuffs, 'cloud crossing puffs'],
        [crossMark, 'cloud crossing mark'],
      ];
      parts.forEach(([m, name], k) => {
        if (!m) return;
        m.name = name;
        m.frustumCulled = false;
        m.renderOrder = 1000 + k;
        m.layers.set(LAYER_NO_INK);
        crossMeshes.push(m);
        ctx.scene.add(m);
      });

      await ctx.compile();
      for (const m of crossMeshes) m.visible = false;
      // Reveal: clusters pop in one after another (nearest the city first), puffs within a cluster
      // in a quick ripple.
      const start = ctx.reveal.slot(REVEAL_SPAN + REVEAL_DUR);
      const nC = layout.clusters.length;
      const order = layout.clusters.map((c, i) => ({ i, d: -(c.dir.x * axis.x + c.dir.y * axis.y + c.dir.z * axis.z) })).sort((a, b) => a.d - b.d);
      const rank = new Float32Array(nC);
      order.forEach((o, k) => (rank[o.i] = k / Math.max(1, nC - 1)));
      for (let i = 0; i < puffCount; i++) lod.reveal[i] = start + rank[layout.cluster[i]] * REVEAL_SPAN + layout.phase[i] * 0.22;
      lod.refresh();
      // The re-draw's stand-ins are filled right before the scene is projected (beforeRender).
      sceneHookPrev = ctx.scene.onBeforeRender;
      const prevHook = sceneHookPrev;
      sceneHook = function (this: Object3D, ...a: Parameters<Object3D['onBeforeRender']>) {
        prevHook.apply(this, a);
        beforeRender(ctx);
      };
      ctx.scene.onBeforeRender = sceneHook;
      ready = true;
    },

    update(ctx: LBContext) {
      if (!ready || !lod || !puffMat || !bodyMat || !crossBody || !crossPuffs || !crossStreaks || !crossMark || !puffs || !puffBase) return;
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
          const d = hyp3(px, py, pz);
          if (d > 260) continue;
          let az = 1;
          if (fl > 1e-4) {
            const pu = px * ux + py * uy + pz * uz;
            const hx = px - ux * pu;
            const hy = py - uy * pu;
            const hz = pz - uz * pu;
            const hl = hyp3(hx, hy, hz);
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

      const base = ctx.reducedMotion ? CROSS_TIMING_RM : CROSS_TIMING;
      timing.tIn = ctx.reducedMotion ? base.tIn : tIn.value;
      timing.hold = ctx.reducedMotion ? base.hold : tHold.value;
      timing.tOut = ctx.reducedMotion ? base.tOut : tOut.value;
      // The overlay's clock: real time live; in shot mode sim time, so the review tool's warm frames
      // (frozen sim, real rAFs) never age an episode and the /play clip shows it as a player sees it.
      const dt = ctx.shotMode ? ctx.time.dt : ctx.time.realDt;
      // A teleport ends any episode; motion, however fast, never does (crossing.ts isTeleport).
      const jump = !hasPrev || isTeleport(tmp.copy(v.eye).sub(prevEye).lengthSq(), dt);
      // This frame's motion (world), and whether it is forward or backward in view (the overlay's
      // streams and fronts run outward from a focus of expansion, or inward to one of contraction).
      const moved = !jump && dt > 0 ? vel.copy(v.eye).sub(prevEye).length() : 0;
      if (moved > 1e-4) {
        velV.copy(vel).multiplyScalar(1 / moved).transformDirection(ctx.camera.matrixWorldInverse);
        lastSign = -velV.z >= -0.1 ? 1 : -1;
      }
      // Where the eye will be ANT_LEAD fill-times ahead (cloud frame), when moving fast enough. (Also
      // under reduced motion: it only decides when the fade starts, so it is up before the eye goes
      // in, instead of contact stepping it up in one frame.)
      const lead = timing.tIn * ANT_LEAD;
      const antOn = moved / Math.max(dt, 1e-4) > ANT_SPEED;
      if (antOn) step3.copy(vel).applyQuaternion(qInv).multiplyScalar(lead / dt);
      else step3.set(0, 0, 0);
      const segLen = step3.length();
      let ahead = false;

      // White-out. inside: the eye within a puff's (lumpy) surface → the veil overlay. near: within
      // FOG_REACH of a surface, or just under a cluster's flat base → the scene fog closes in.
      let inside = 0;
      let near = 0;
      let under = 0;
      const altSea = v.altSea;
      if (altSea > CLOUD_MIN - BASE_MIST - 2 - segLen && altSea < CLOUD_MAX + 14 + FOG_REACH + segLen) {
        const eyeH = eyeR - R;
        const nearPlane = ctx.camera.near * 1.3;
        const reachX = Math.max(FOG_REACH, segLen + nearPlane + 1);
        for (let i = 0; i < puffCount; i++) {
          const cx = puffs[i * 4];
          const cy = puffs[i * 4 + 1];
          const cz = puffs[i * 4 + 2];
          const r = puffs[i * 4 + 3];
          const dx = eyeLocal.x - cx;
          const dy = eyeLocal.y - cy;
          const dz = eyeLocal.z - cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > (r + reachX) * (r + reachX)) continue;
          if (antOn && !ahead) {
            // The nearest point of the path ahead to this puff: inside its contact ball (the same
            // ball as `inside` below), above its flat base, and closer than the eye is now.
            const tt = Math.min(1, Math.max(0, -(dx * step3.x + dy * step3.y + dz * step3.z) / (segLen * segLen)));
            const qx = dx + step3.x * tt;
            const qy = dy + step3.y * tt;
            const qz = dz + step3.z * tt;
            const qd = hyp3(qx, qy, qz);
            if (tt > 0 && (qd - nearPlane) / r < 1.12 && qd * qd < d2) {
              const qh = hyp3(cx + qx, cy + qy, cz + qz) - R;
              if (qh >= puffBase[i]) ahead = true;
            }
          }
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

      // Contact: inside a puff, or leaving through a flat base (thins over a few metres of mist).
      const contactNow = Math.max(inside, under * 0.85);
      const fogNow = Math.max(near, under, contactNow);
      // Temporal release: in at once, out over a few frames (overlay first, fog last). The sky dome
      // reads the same smoothed values at draw time, so silhouettes fade into the sky with the fog.
      veilS = jump ? contactNow : Math.max(contactNow, veilS * Math.exp(-dt / VEIL_RELEASE));
      mistS = jump ? fogNow : Math.max(fogNow, veilS, mistS * Math.exp(-dt / MIST_RELEASE));
      if (veilS < 1e-3) veilS = 0;
      if (mistS < 1e-3) mistS = 0;

      // The followed thing (camera subject / ridden Trackable), first: the trigger waits for it to
      // be in frame, and the overlay sits just behind it.
      const sr = subject(ctx);
      let subjDist = 0;
      let subjOn = true;
      if (sr > 0) {
        subjDist = subj.distanceTo(v.eye);
        ndc.copy(subj).project(ctx.camera);
        subjV.copy(subj).applyMatrix4(ctx.camera.matrixWorldInverse);
        // (Re-drawn on top of the overlay, it counts as in frame wherever it is: it lands on top
        // whenever it comes into view. Only a subject that cannot be re-drawn is waited for.)
        // Urgent (scan every frame until found): an episode runs, or one may start soon (the eye or
        // the subject near the layer, or the white-out fog closing in).
        const sAlt = subj.length() - R;
        const nearBand = (a: number) => a > CROSS_BAND[0] - 2 * CROSS_CLEAR && a < CROSS_BAND[1] + 2 * CROSS_CLEAR;
        resolveObjects(ctx, sr, ep.stage !== Stage.Idle || veilS > 0.002 || mistS > 0.002 || ahead || nearBand(altSea) || nearBand(sAlt));
        subjOn = subjects.drawn || (subjV.z < 0 && Math.abs(ndc.x) < 0.95 && Math.abs(ndc.y) < 0.95);
      } else if (subjects.key) subjects.clear();

      // Episode triggers: a real crossing of the layer (see CROSS_BAND), or entering a puff. A
      // teleport ends any episode.
      const rm = ctx.reducedMotion;
      let trigger = false;
      if (jump) {
        resetCrossing(ep);
        armedDown = altSea > CROSS_MID;
        armedUp = altSea < CROSS_MID;
        wait = 0;
      } else if (dt > 0) {
        const vz = (altSea - prevAltSea) / dt;
        // Explore (the zoom spring, the dive) decelerates into its target: a short look-ahead in log
        // space. The bird and rides keep their speed: a longer, linear one, so a dive through the layer
        // fires as it enters, not as it leaves.
        let pred: number;
        if (v.mode === 'explore') {
          const vlog = (Math.log(Math.max(1, altSea)) - Math.log(Math.max(1, prevAltSea))) / dt;
          pred = altSea * Math.exp(Math.max(-3, Math.min(3, vlog * CROSS_LEAD)));
        } else pred = altSea + vz * CROSS_LEAD_FLY;
        const lo = CROSS_BAND[0];
        const hi = CROSS_BAND[1];
        let dir = 0;
        // Down: in the band (or jumped clean through it this frame) and headed out of its bottom.
        if (armedDown && vz < -CROSS_VZ && altSea < hi && (altSea > lo - CROSS_CLEAR || prevAltSea > hi) && Math.min(pred, altSea) < lo - 1) dir = -1;
        if (armedUp && vz > CROSS_VZ && altSea > lo && (altSea < hi + CROSS_CLEAR || prevAltSea < lo) && Math.max(pred, altSea) > hi + 1) dir = 1;
        if (dir !== 0) {
          if (dir < 0) armedDown = false;
          else armedUp = false;
          // Riding something not in frame that cannot be re-drawn on top: wait for it (CROSS_WAIT).
          if (subjOn) trigger = true;
          else {
            wait = CROSS_WAIT;
            waitDir = dir;
          }
        }
        if (wait > 0) {
          const inReach = altSea > lo - CROSS_CLEAR && altSea < hi + CROSS_CLEAR;
          if (subjOn && inReach) {
            trigger = true;
            wait = 0;
          } else wait = inReach && Math.sign(vz) === waitDir ? Math.max(0, wait - dt) : 0;
        }
        if (altSea > hi || (altSea > CROSS_MID && vz > 0)) armedDown = true;
        if (altSea < lo || (altSea < CROSS_MID && vz < 0)) armedUp = true;
        if (veilS > CONTACT_TRIGGER && prevContact <= CONTACT_TRIGGER) trigger = true;
        if (ahead) trigger = true;
      }
      prevAltSea = altSea;
      prevContact = veilS;
      const clear = altSea < CROSS_BAND[0] - CROSS_CLEAR || altSea > CROSS_BAND[1] + CROSS_CLEAR;
      if (dt > 0 || trigger || jump) stepCrossing(ep, dt, trigger, veilS, timing, clear, lastSign);
      if (force.value > 0) forceCrossing(ep, force.value);
      // The hole opens onto a clear city, not a lavender fog: the mist releases ahead of the hole (it
      // lingered ~0.2 s after it, at the money shot of the dive), mostly gone by its first frame.
      if (ep.stage === Stage.Out) mistS = Math.min(mistS, Math.max(veilS, 1 - (ep.openK + 0.15) * 3.5));

      const cover = ep.cover;
      if (process.env.NODE_ENV !== 'production') (ctx.debug as unknown as { clouds?: unknown }).clouds = ep;
      // Reduced motion: the still fade's level, rate-limited both ways, through teleports too
      // (crossing.ts rmFadeStep); shown until it has faded out, after the episode has ended.
      rmS = !rm ? Math.min(RM_CAP, Math.max(cover, veilS)) : rmFadeStep(rmS, Math.max(cover, veilS), dt, jump);
      const rmLevel = rmS;
      const show = ep.stage !== Stage.Idle || veilS > 0.002 || (rm && rmLevel > 0.002);
      ctx.services.sky.veil = rm ? rmLevel : veilS;
      ctx.services.sky.mist = mistS;
      ctx.services.sky.cross = rm ? rmLevel : Math.max(cover, smooth(0.15, 0.85, veilS)) * (ep.stage === Stage.Idle ? 1 : ep.fade);

      // Travel: the stream phase (distance flown) and the screen point the eye moves toward.
      if (!jump && dt > 0) {
        const dist = moved;
        if (dist > 1e-4) {
          vel.multiplyScalar(1 / dist);
          // The motion in view space (velV, above): forward (−z) streams outward from the focus of
          // expansion, backward (climbing out while looking down) inward to the focus of contraction.
          const fwd = -velV.z;
          if (Math.abs(fwd) > 0.12) {
            tmp.copy(v.eye).addScaledVector(vel, lastSign * 10).project(ctx.camera);
            foeT.set(tmp.x * 0.5 + 0.5, tmp.y * 0.5 + 0.5);
          } else {
            // Sideways: the focus off the side the eye moves toward; the streams run across.
            const l = Math.hypot(velV.x, velV.y) || 1;
            foeT.set(0.5 + (velV.x / l) * 2.2, 0.5 + (velV.y / l) * 2.2);
          }
          // Kept near the frame: far off it, the log-polar puffs grew to giant arcs (and its fronts
          // swept mostly off-screen). Just outside an edge, the streams fan in from that side.
          foeT.set(Math.min(1.3, Math.max(-0.3, foeT.x)), Math.min(1.3, Math.max(-0.3, foeT.y)));
          streak = Math.min(1, dist / dt / 25);
        } else streak = 0;
        // During an episode the streaming never stops (a slowing zoom froze it into a still wall).
        const stream = !rm && (ep.stage !== Stage.Idle || veilS > 0.002) ? Math.max(dist, STREAM_MIN * dt) : rm ? 0 : dist;
        phase.x += lastSign * stream * STREAM_NEAR;
        phase.y += lastSign * stream * STREAM_FAR;
        // The lateral set scrolls at the radial set's on-screen speed at the frame's centre.
        const rC = Math.max(0.3, Math.hypot((0.5 - foe.x) * ctx.camera.aspect, 0.5 - foe.y));
        phaseL.x += lastSign * stream * STREAM_NEAR * rC;
        phaseL.y += lastSign * stream * STREAM_FAR * rC;
        // Ease the focus (exponential, frame-rate independent): a turn swings the streams round. Not
        // while the hole opens: the fronts are drawn round the focus, and a ride settling onto its
        // target (the climb turning into a chase) swung it across the frame mid-opening, sliding the
        // last cloud over the scene from the middle to a corner in one frame.
        if (ep.stage !== Stage.Out) foe.lerp(foeT, 1 - Math.exp(-dt / 0.06));
      }
      if (!rm && dt > 0) {
        // A slow drift so the inside of a cloud still breathes while hovering.
        phase.x += dt * 0.12;
        phase.y += dt * 0.05;
        phaseL.x += dt * 0.1;
        phaseL.y += dt * 0.04;
      }
      prevEye.copy(v.eye);
      hasPrev = true;
      const shown = wasShown;
      wasShown = show;

      if (show) {
        const cu = bodyMat.uniforms;
        const aspect = ctx.camera.aspect;
        if (rm) {
          // A still fade: the body alone (no puffs, fronts, streaming or speed lines), opacity only,
          // slow in and out and capped (the fogged city stays faintly visible).
          cu.uFill.value = 10;
          cu.uOpen.value = -10;
          cu.uFade.value = rmLevel;
          cu.uStreak.value = 0;
          foe.set(0.5, 0.5);
        } else {
          cu.uFill.value = ep.fill;
          cu.uOpen.value = ep.open;
          cu.uFade.value = ep.stage === Stage.Idle ? 1 : ep.alpha;
          // Speed lines: with the motion, and a floor while covered so the hold keeps moving.
          cu.uStreak.value = Math.max(streak, ep.stage !== Stage.Idle ? 0.45 : 0) * smooth(0.05, 0.4, Math.max(cover, veilS));
        }
        cu.uContact.value = smooth(0.15, 0.85, veilS);
        // The puffs smear along the motion, more with speed.
        cu.uStretch.value = STRETCH[0] + STRETCH[1] * streak;
        cu.uDir.value = ep.dir;
        cu.uAspect.value = aspect;
        if (force.value > 0 && forceLat.value > 0) foe.set(0.5, -0.3);
        // The fronts' on-screen radius range (height units): nearest screen point → farthest corner.
        frontRange(foe.x, foe.y, aspect, range);
        // The focus off-screen: the lateral puff set, flowing from the focus's side across the frame
        // (set at once when the overlay comes up, eased after).
        const out = Math.hypot(Math.max(0, -foe.x, foe.x - 1) * aspect, Math.max(0, -foe.y, foe.y - 1));
        const latT = smooth(LAT_OUT[0], LAT_OUT[1], out);
        latS = !shown ? latT : latS + (latT - latS) * (1 - Math.exp(-dt / LAT_EASE));
        cu.uLat.value = latS;
        flow.set((0.5 - foe.x) * aspect, 0.5 - foe.y);
        if (flow.lengthSq() < 1e-6) flow.set(0, 1);
        flow.normalize();
        cloudPalette(eyeSun, palLit, palShade, palBelly, palRim);
        // Shading contrast: deeper as the lit colour darkens (dusk, night).
        const tone = Math.min(1.9, Math.max(1, 0.82 / Math.max(0.05, palLit.r * 0.2126 + palLit.g * 0.7152 + palLit.b * 0.0722)));
        cu.uTone.value = tone;
        bellyT.copy(palBelly).multiplyScalar(1 - 0.1 * (tone - 1));
        rimK.copy(palRim).multiplyScalar(0.18 * tone);
        bodyC.copy(palShade).lerp(palLit, 0.62);
        kbs.set(Math.min(0.95, 0.62 * tone), Math.min(0.9, 0.55 * tone));
        // Light from the sky above: screen up, leaning toward the sun's side.
        tmp.copy(u.lbSunDir.value).transformDirection(ctx.camera.matrixWorldInverse);
        light.set(tmp.x * 0.5, 1).normalize();
        light3.set(light.x * 0.8, light.y * 0.8, 0.55).normalize();
      }

      // The followed thing: re-drawn on top of the overlay, scissored to it (redrawSubject); far or
      // impossible to re-draw, a POP ring round it. The puffs in front of it dissolve, the white-out fog
      // is pushed past it.
      holeW.w = 0;
      subjR = sr;
      mark.x = 0;
      scissor.z = -1;
      redraw = false;
      const cam = ctx.camera;
      ctx.renderer.getDrawingBufferSize(dbSize);
      if (sr > 0) {
        const sAlt = subj.length() - R;
        if (sAlt > CLOUD_MIN - sr - 6 && sAlt < CLOUD_MAX + 16 + sr) holeW.set(subj.x, subj.y, subj.z, sr);
        // (Not from inside it: a walker's eyes.)
        if (show && subjV.z < 0 && -subjV.z + sr > cam.near * 1.5 && subjDist > sr) {
          const tanHalf = Math.tan((cam.fov * DEG) / 2);
          const r0 = (Math.tan(Math.asin(Math.min(0.999, sr / subjDist))) / tanHalf) * dbSize.y * 0.5;
          const cx = (ndc.x * 0.5 + 0.5) * dbSize.x;
          const cy = (ndc.y * 0.5 + 0.5) * dbSize.y;
          // (Its instance found and not hidden by its owner: a ridden walker's collapsed body is not
          // drawn, so it gets the ring instead.)
          subjects.locate(subj, sr, SCAN_REACH);
          redraw = subjects.located;
          // The ring: while what reads as its body (Trackable.bodyRadius: a satellite's box, not its
          // panels' reach) is under MARK_PX on screen, or whenever it cannot be re-drawn (nothing
          // found: at least show where it is), never wider than MARK_MAX.
          const rb0 = r0 * Math.min(1, subjBody / sr);
          const mk = redraw ? 1 - smooth(MARK_PX[1], MARK_PX[0], rb0) : 1;
          markC.set(cx, cy);
          if (mk > 0) mark.set(mk * (rm ? rmLevel / 0.85 : ep.stage === Stage.Idle ? 1 : ep.alpha), Math.min(MARK_MAX, Math.max(MARK_MIN, rb0 * 1.35 + 5)), 2.6, 0);
          // The re-draw's scissor: the projected bounding circle's square.
          const ext = r0 * CLIP_K + CLIP_PX;
          const x0 = Math.max(0, Math.floor(cx - ext));
          const y0 = Math.max(0, Math.floor(cy - ext));
          const x1 = Math.min(dbSize.x, Math.ceil(cx + ext));
          const y1 = Math.min(dbSize.y, Math.ceil(cy + ext));
          if (x1 > x0 && y1 > y0) scissor.set(x0, y0, x1 - x0, y1 - y0);
          else redraw = false;

        }
      }
      if (process.env.NODE_ENV !== 'production') (ctx.debug as unknown as { cloudsX?: unknown }).cloudsX = { redraw, ring: Math.round(mark.x * 100) / 100, ringR: Math.round(mark.y), sc: Math.round(scissor.z), lat: Math.round(latS * 100) / 100, sx: Math.round(markC.x), sy: Math.round(markC.y) };
      // (Reduced motion: the still body alone fades; translucent puffs would stack like discs.)
      const bodyOn = show && (Math.round(crossParts.value) & 1) !== 0;
      const puffsOn = show && !rm && (Math.round(crossParts.value) & 2) !== 0;
      crossBody.visible = bodyOn;
      crossPuffs.visible = puffsOn;
      if (crossPuffsFar) crossPuffsFar.visible = puffsOn;
      // The one far depth only while the overlay is mostly opaque: fading out at the end of an
      // episode, the scene under a translucent remnant keeps its own depth, so post's ink and night
      // grade stay on it (written, the city under a 30 % remnant lost its outlines).
      const writeZ = !rm && (ep.stage === Stage.Idle || ep.alpha > 0.6);
      bodyMat.depthWrite = writeZ;
      (crossPuffs.material as ShaderMaterial).depthWrite = writeZ;
      crossStreaks.visible = puffsOn && (bodyMat.uniforms.uStreak.value as number) > 0.01;
      crossMark.visible = show && (redraw || mark.x > 0.004);

      pu.uFogMin.value = mistS > 0.002 ? PUFF_FOG_MIN : 0;
      if (mistS > 0.002) {
        // Fog the scene by depth toward the mist: visibility closes in log-space from the sky's
        // aerial fog to a few metres, so the city fades into the cloud instead of showing crisp
        // through the overlay.
        const fog = ctx.services.sky.fog;
        if (fog) {
          fog.color.lerp(mist, mistBlend(mistS));
          const far = Math.exp(mix(Math.log(Math.max(VEIL_VIS + 1, fog.far)), Math.log(VEIL_VIS), Math.pow(mistS, 1.6)));
          fog.near = Math.min(fog.near, far * mix(0.35, 0.05, smooth(0, 0.6, mistS)));
          fog.far = far;
          if (sr > 0) {
            // Clear air up to the followed thing: it never fades into the mist it flies through.
            fog.near = Math.max(fog.near, subjDist + sr * 1.2);
            fog.far = Math.max(fog.far, fog.near * 1.4 + 4);
          }
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
      ctx.services.sky.cross = 0;
      ctx.services.sky.cloudsInView = 0;
      for (const m of lod?.meshes ?? []) m.removeFromParent();
      for (const m of crossMeshes) {
        m.removeFromParent();
        (m.material as ShaderMaterial).dispose();
      }
      crossMeshes.length = 0;
      lod?.dispose();
      puffMat?.dispose();
      tex?.dispose();
      lod = null;
      crossBody = crossPuffs = crossPuffsFar = crossStreaks = crossMark = null;
      subjects.clear();
      if (sceneHook && ctx.scene.onBeforeRender === sceneHook && sceneHookPrev) ctx.scene.onBeforeRender = sceneHookPrev;
      sceneHook = sceneHookPrev = null;
      for (const p of proxies.values()) {
        if (!p) continue;
        p.mesh.removeFromParent();
        p.mesh.geometry.dispose();
      }
      proxies.clear();
      standIns.clear();
      redraw = false;
      puffMat = bodyMat = null;
      tex = null;
      ready = false;
    },
  };
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
function anchors(driftDeg: number): CloudAnchor[] {
  const out: CloudAnchor[] = [];
  const mid = (CLOUD_MIN + CLOUD_MAX) / 2;
  const rad = R + mid;
  const c0 = diveCrossing(43);
  if (c0) {
    const side = normalize3(v3(), cross3(v3(), c0.travel, c0.at));
    const toCity = addScaled3(v3(), CITY_AXIS, c0.at, -1);
    const s = dot3(toCity, side) > 0 ? -1 : 1; // away from the city
    // Placed where the drifting layer will be when the /play clip gets there (DIVE_CROSS_T): turned
    // back about the city's axis by the drift until then.
    const back = -driftDeg * DEG * DIVE_CROSS_T;
    const cb = Math.cos(back);
    const sb = Math.sin(back);
    const k = CITY_AXIS;
    const at = (base: Vec3, lateral: number, along: number) => {
      const d = addScaled3(v3(), base, side, (s * lateral) / rad);
      normalize3(d, addScaled3(d, d, c0.travel, along / rad));
      // Rodrigues: d·cos + (k × d)·sin + k (k·d)(1 − cos).
      const kd = dot3(k, d);
      const kx = cross3(v3(), k, d);
      return normalize3(v3(), v3(d.x * cb + kx.x * sb + k.x * kd * (1 - cb), d.y * cb + kx.y * sb + k.y * kd * (1 - cb), d.z * cb + kx.z * sb + k.z * kd * (1 - cb)));
    };
    // The body: a modest cumulus well off the track (its nearest lobes ~3 m from it).
    out.push({ dir: at(c0.at, 15, -2), radius: 8, base: CLOUD_MIN + 1, top: CLOUD_MAX - 2 });
    // The cloudlet the camera punches through: a tiny flat-based cumulus of five small puffs whose
    // bulk sits below and outboard of the track, so on the way in it hangs under the skyline, not
    // over it. The eye cuts its inner top corner and leaves through the flat base (~0.15 s inside).
    const puff = (alt: number, lateral: number, along: number, r: number) => {
      const c = diveCrossing(alt) ?? c0;
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
  const shot = cloudsShotView();
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

function frac(x: number): number {
  return x - Math.floor(x);
}
