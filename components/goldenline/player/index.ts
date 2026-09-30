// First-person player: state machine and locomotion (controller.ts), poses per mode (poses.ts)
// blended on every transition, the lofted board (board/), SDF-modelled skinned arms and legs
// (body/), frame-accurate footprints (gait.ts) and the camera rig (camera.ts).
// See player/README.md for the state machine and the surf system's take-over hooks.

import { CapsuleGeometry, Group, Matrix4, Mesh, MeshBasicNodeMaterial, Quaternion, SphereGeometry, Vector3 } from 'three/webgpu';
import type { GLContext, GLSystem, PlayerMode } from '../core/contracts';
import { SPLAT_FOAM, SPLAT_WAKE } from '../core/contracts';
import { bool } from 'three/tsl';
import type { NumberParam, ToggleParam } from '../core/params';
import { clamp, damp } from '../core/pool';
import { SPAWN } from '../world/layout';
import type { PlayerRig, RideDriver, Stance } from './api';
import { createBoardLook, createBoardMaterial, createPadMaterial } from './board/material';
import { boardSpec } from './board/shape';
import { buildLimb } from './body/build';
import { bake } from '../core/bakes';
import { NEAR_CASTER_LAYER } from '../atmosphere/shadows';
import { buildArm, buildLeg } from './body/models';
import { ArmRig, LegRig } from './body/rig';
import { createSkinLook, createSkinMaterial } from './body/skin';
import { CameraRig } from './camera';
import { PlayerCore, strokePull } from './controller';
import { type Intent, makeIntent, readInput } from './intent';
import { Pose } from './pose';
import { poseFor, proneBoard } from './poses';
import { ease, wrapAngle } from './rigmath';
import { SCRIPTS, ScriptRunner } from './script';
import { Drips } from './drips';

const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _q = new Quaternion();
const _up = new Vector3(0, 1, 0);

/** Lab cameras in the body frame (+X forward, +Y up, +Z right); `at` centres on a hand. */
const INSPECT: Array<{ cam: [number, number, number]; look: [number, number, number]; at?: 'handR' | 'handL' }> = [
  { cam: [0.4, 1.2, 2.3], look: [0.1, 0.9, 0] },
  { cam: [2.5, 1.3, 0.35], look: [0, 0.85, 0] },
  { cam: [0.28, 0.12, 0.3], look: [0.07, 0, 0], at: 'handR' },
  { cam: [0.95, 0.55, 0.55], look: [0.1, 0.08, 0] },
  { cam: [0.28, 0.12, -0.3], look: [0.07, 0, 0], at: 'handL' },
  { cam: [1.9, 0.9, 1.3], look: [0.25, 0.25, 0] },
  { cam: [-0.25, 0.1, 0.25], look: [0.07, 0, 0], at: 'handR' },
  { cam: [0.05, 0.14, 1.4], look: [0.05, 0.1, 0] },
  { cam: [-0.4, 1.0, 0.0], look: [0.8, 0.0, 0] },
];

export function createPlayerSystem(): GLSystem {
  let core: PlayerCore;
  let rig: PlayerRig;
  let camRig: CameraRig;
  const intent: Intent = makeIntent();
  const runner = new ScriptRunner();
  const pose = new Pose();
  const poseOpts = { reduced: false, bob: 1 };
  const prev = new Pose();
  const sa = new Pose();
  const sb = new Pose();
  let group: Group | null = null;
  let boardGroup: Group | null = null;
  let arms: [ArmRig, ArmRig] | null = null;
  let legs: [LegRig, LegRig] | null = null;
  const disposables: Array<{ dispose(): void }> = [];
  let boardLook: ReturnType<typeof createBoardLook>;
  let skinLook = createSkinLook();
  let p: {
    demo: NumberParam;
    demoAt: NumberParam;
    follow: ToggleParam;
    detach: ToggleParam;
    inspect: NumberParam;
    body: ToggleParam;
    boardOn: ToggleParam;
    bob: NumberParam;
    sens: NumberParam;
    walk: NumberParam;
    run: NumberParam;
    thrust: NumberParam;
    assist: NumberParam;
    sss: NumberParam;
    tone: NumberParam;
    relief: NumberParam;
    wet: NumberParam;
    tint: NumberParam;
    log: ToggleParam;
  };
  let demoLast = 0;
  let demoPending = false;
  const lastCam = new Vector3();
  let film = 0;
  let drips: Drips | null = null;
  // Shadow-only torso and head: the lens never sees them, the sun does.
  let torso: Mesh | null = null;
  let head: Mesh | null = null;
  const _tb = new Matrix4();
  const _tx = new Vector3();
  const _ty = new Vector3();
  const _tz = new Vector3();
  const _hipC = new Vector3();
  const _shC = new Vector3();
  let waterAt: (x: number, z: number) => number = () => 0;
  const tipPrev = [new Vector3(), new Vector3()];
  const tipNow = new Vector3();
  const tipVel = new Vector3();
  const dripAcc = [0, 0];
  let dripWater = 0;
  let flow = 0;
  const lastStroke = [0, 0];
  const lastEntry = [0, 0];
  const tunables = { walkSpeed: 1.45, runSpeed: 3.4, paddleThrust: 2.7, bob: 1, catchAssist: 1.2 };
  const stance: Stance = { frontX: -0.1, frontZ: 0.02, frontAngle: 1.02, rearX: -0.72, rearZ: -0.01, rearAngle: 1.45, crouch: 0.45, lean: 0, fore: 0, arms: 0.5 };

  const startDemo = (ctx: GLContext, n: number) => {
    const s = SCRIPTS[n - 1];
    if (!s) return;
    rig.teleport(s.start.x, s.start.z, s.start.yaw, s.start.mode);
    core.pitch = s.start.pitch ?? 0;
    runner.start(s);
    core.lab.on = false;
    rig.demoActive = true;
    // Fast-forward deterministically so a still can land mid-script.
    const steps = Math.round(p.demoAt.value * 60);
    // Only the player advances (other systems are frozen), so wave-dependent scripts (catch)
    // should start at 0 and be stepped with the shot tool's --advance / --seq instead.
    for (let i = 0; i < steps; i++) tick(ctx, 1 / 60, true);
  };

  const tick = (ctx: GLContext, dt: number, silent: boolean) => {
    // [surf] A scripted input source (surf demos) replaces the keyboard, mouse and player demos.
    if (rig.externalIntent) rig.externalIntent(intent);
    else if (rig.demoActive) {
      runner.step(dt, core.pos.x, core.pos.z, core.yaw, core.pitch, intent);
      if (runner.labWave > 0) {
        core.startLabWave(runner.labWave);
        runner.labWave = 0;
      }
    }
    else readInput(ctx.input, p.sens.value, intent);
    core.logModes = p.log.value;
    if (dt > 0) core.update(dt, intent);
    if (dt > 0) {
      // A sheet of water over the deck while paddling (broken into beads at its edges).
      const proneNow = core.mode === 'paddle' || core.mode === 'catch';
      const filmT = proneNow ? 0.25 + 0.4 * core.paddleW : core.mode === 'wade' ? core.boardFloat * 0.5 : 0;
      const wo = p.wet.value;
      film = damp(film, filmT * (wo >= 0 ? wo : 1), filmT > film ? 4 : 0.25, dt);
      flow += dt * (0.05 + core.speed * 0.35);
    }
    // [surf] Also while it drives the pop-up (and its own wipeout): the prone and pop-up poses
    // build the board from the core's position, water height, heading and attitude.
    const driven =
      !!core.driver && (core.mode === 'ride' || (core.mode === 'popup' && !!core.driver.popup) || (core.mode === 'wipeout' && !!core.driver.handlesWipeout));
    if (driven) {
      // The surf system drives the board; keep the core's body state on it for the hand-back.
      core.pos.set(rig.boardPosition.x, core.pos.y, rig.boardPosition.z);
      core.vel.copy(rig.velocity);
      core.speed = rig.speed;
      _v.set(1, 0, 0).applyQuaternion(rig.boardQuat);
      core.heading = Math.atan2(-_v.x, -_v.z);
      core.waterY = rig.boardPosition.y + 0.012;
      if (core.mode !== 'ride') {
        core.boardN.set(0, 1, 0).applyQuaternion(rig.boardQuat);
        core.boardPitch = 0;
        core.boardRoll = 0;
      }
    }
    // Pitch limits per mode keep the torso-less body out of frame (see README).
    const lo = core.mode === 'paddle' || core.mode === 'catch' ? -0.62 : core.mode === 'walk' || core.mode === 'wade' ? -1.1 : -1.0;
    if (core.pitch < lo) core.pitch = damp(core.pitch, lo, 10, Math.max(dt, 1 / 60));
    buildPose(ctx);
    if (!silent) apply(ctx, dt);
    else if (arms && legs) {
      // Keep the camera springs coherent while fast-forwarding.
      camRig.reset(pose.eye);
    }
  };

  const buildPose = (ctx: GLContext) => {
    poseOpts.reduced = ctx.reducedMotion;
    poseOpts.bob = p.bob.value;
    const o = poseOpts;
    const inRide = core.mode === 'ride';
    if (inRide && !core.driver) {
      proneBoard(core, rig.boardPosition, rig.boardQuat);
      rig.boardPosition.y += 0.02;
    }
    poseFor(core.mode, core, rig.stance, rig.boardPosition, rig.boardQuat, pose, o, sa, sb);
    if (core.blend < 1) {
      poseFor(core.from, core, rig.stance, rig.boardPosition, rig.boardQuat, prev, o, sa, sb);
      pose.blend(prev, pose, ease(core.blend));
    }
  };

  const apply = (ctx: GLContext, dt: number) => {
    const locked = ctx.debug.cameraLocked && (!rig.demoActive || p.detach.value);
    if (locked && p.follow.value) followDebugCamera(ctx);
    if (boardGroup) {
      boardGroup.position.copy(pose.board);
      boardGroup.quaternion.copy(pose.boardQ);
      boardGroup.updateMatrix();
      boardGroup.updateMatrixWorld(true);
    }
    if (arms && legs) {
      arms[0].pose(pose.armL);
      arms[1].pose(pose.armR);
      legs[0].pose(pose.legL);
      legs[1].pose(pose.legR);
      placeShadowProxies();
    }
    if (p.inspect.value > 0) inspectCamera(ctx, p.inspect.value);
    else if (!locked) camRig.apply(ctx, pose.eye, core.yaw, core.pitch, pose.camPitch, pose.camRoll, dt, core.waterY);
    // Outputs for other systems. While a ride driver runs, it owns the board and velocity.
    const driven =
      !!core.driver && (core.mode === 'ride' || (core.mode === 'popup' && !!core.driver.popup) || (core.mode === 'wipeout' && !!core.driver.handlesWipeout)); // [surf]
    rig.mode = core.mode;
    rig.modeTime = core.modeTime;
    rig.eye.copy(locked ? ctx.camera.position : camRig.final);
    rig.yaw = core.yaw;
    rig.pitch = core.pitch;
    rig.lookYaw = wrapAngle(core.yaw - core.heading);
    rig.wetness = core.wet;
    if (!driven) {
      rig.velocity.copy(core.vel);
      rig.speed = core.speed;
      rig.boardPosition.copy(pose.board);
      rig.boardQuat.copy(pose.boardQ);
    }
    _v.set(1, 0, 0).applyQuaternion(rig.boardQuat);
    rig.boardYaw = Math.atan2(-_v.x, -_v.z);
    lastCam.copy(ctx.camera.position);

    // Hands in the water: wake on every stroke, a little foam where each hand goes in.
    const prone = core.mode === 'paddle' || core.mode === 'catch';
    if (prone && dt > 0) {
      const st = ctx.services.state;
      for (let s = 0; s < 2; s++) {
        const ph = s === 1 ? core.stroke : (core.stroke + 0.5) % 1;
        const w = s === 0 ? pose.armL.wrist : pose.armR.wrist;
        if (lastStroke[s] > 0.9 && ph < 0.1 && core.paddleW > 0.5) st.splat(SPLAT_FOAM, w.x, w.z, 0.14, 0.35);
        const pull = strokePull(ph) * core.paddleW;
        if (pull > 0.1) {
          _v2.set(-1, 0, 0).applyQuaternion(pose.boardQ);
          st.splat(SPLAT_WAKE, w.x, w.z, 0.18, pull * 0.6, _v2.x, _v2.z);
        }
        lastStroke[s] = ph;
      }
    }
    if (drips && arms && dt > 0) emitDrips(ctx, dt, prone);

    // Surface look: wet skin and board (film/flow advance in tick so demos fast-forward them).
    const wetO = p.wet.value;
    const wet = wetO >= 0 ? wetO : core.wet;
    (boardLook.wet as { value: number }).value = wet;
    (boardLook.film as { value: number }).value = clamp(film, 0, 1) * clamp(wet * 1.3, 0, 1);
    (boardLook.flow as { value: number }).value = flow;
    (boardLook.tint as { value: number }).value = p.tint.value;
    (skinLook.wet as { value: number }).value = clamp(wet * 1.1 - 0.05, 0, 1);
    (skinLook.flow as { value: number }).value = flow;
    (skinLook.salt as { value: number }).value = clamp(1 - wet * 1.6, 0, 1) * 0.9;
    (skinLook.sss as { value: number }).value = p.sss.value;
    (skinLook.tone as { value: number }).value = p.tone.value;
    (skinLook.relief as { value: number }).value = p.relief.value;
    if (arms && legs && boardGroup) {
      const showBody = p.body.value;
      arms[0].mesh.visible = showBody;
      arms[1].mesh.visible = showBody;
      legs[0].mesh.visible = showBody;
      legs[1].mesh.visible = showBody;
      boardGroup.visible = p.boardOn.value;
    }
  };

  const placeShadowProxies = () => {
    if (!torso || !head) return;
    _hipC.addVectors(pose.legL.hip, pose.legR.hip).multiplyScalar(0.5);
    _shC.addVectors(pose.armL.shoulder, pose.armR.shoulder).multiplyScalar(0.5);
    // Torso: from the hips to just above the shoulder line, as wide as the shoulders.
    _ty.subVectors(_shC, _hipC);
    const len = _ty.length();
    _ty.divideScalar(Math.max(1e-4, len));
    _tx.subVectors(pose.armR.shoulder, pose.armL.shoulder).normalize();
    _tz.crossVectors(_tx, _ty).normalize();
    _tx.crossVectors(_ty, _tz);
    // (right × up points backward)
    _v3.copy(_tz);
    _tb.makeBasis(_tx.multiplyScalar(0.17), _ty.multiplyScalar((len + 0.15) / 2.9), _tz.multiplyScalar(0.115));
    _v.addVectors(_hipC, _shC).multiplyScalar(0.5);
    _tb.setPosition(_v);
    torso.matrix.copy(_tb);
    torso.matrixWorld.copy(_tb);
    // Head: behind the eye, over the neck.
    _v.subVectors(pose.eye, _shC);
    head.position.copy(pose.eye).addScaledVector(_v, -0.12);
    head.position.addScaledVector(_v3, 0.06);
    head.updateMatrix();
    head.matrixWorld.copy(head.matrix);
  };

  /** Water off the hands: drips on the recovery, a flick on entry, a trickle while wet on land. */
  const emitDrips = (ctx: GLContext, dt: number, prone: boolean) => {
    const d = drips as Drips;
    const rnd = d.random;
    dripWater = core.waterY;
    for (let s = 0; s < 2; s++) {
      const arm = (arms as [ArmRig, ArmRig])[s];
      // Middle-finger tip: distal phalanx frame, 2.2 cm out along its axis.
      tipNow.set(0.021, -0.003, 0).applyMatrix4(arm.bones[9].matrixWorld);
      tipVel.subVectors(tipNow, tipPrev[s]).divideScalar(dt);
      tipPrev[s].copy(tipNow);
      if (tipVel.lengthSq() > 100) continue; // teleport
      const water = dripWater;
      const above = tipNow.y > water + 0.01;
      let rate = 0;
      if (prone) {
        const ph = s === 1 ? core.stroke : (core.stroke + 0.5) % 1;
        if (ph > 0.53 && ph < 0.97 && above) rate = 55 * core.paddleW * (1 - (ph - 0.53) / 0.5);
        // Entry flick: the hand slapping in throws a few droplets forward and up.
        if (ph < 0.06 && lastEntry[s] > 0.9 && core.paddleW > 0.4) {
          d.burst(tipNow, tipVel.x * 0.25, 0.9, tipVel.z * 0.25, 7, 0.55, 0.0022);
        }
        lastEntry[s] = ph;
      } else if (core.wet > 0.55) {
        rate = 4 * (core.wet - 0.55) * 2;
      }
      dripAcc[s] += rate * dt;
      while (dripAcc[s] >= 1) {
        dripAcc[s] -= 1;
        const r = 0.0012 + rnd() * 0.0016;
        d.emit(tipNow.x + (rnd() - 0.5) * 0.03, tipNow.y, tipNow.z + (rnd() - 0.5) * 0.03, tipVel.x * 0.7, tipVel.y * 0.5 - 0.2, tipVel.z * 0.7, r);
      }
    }
    d.update(dt, waterAt);
  };

  /** Lab: a third-person camera fixed to the body frame, for reviewing the limbs up close. */
  const inspectCamera = (ctx: GLContext, n: number) => {
    const c = INSPECT[Math.round(n) - 1];
    if (!c) return;
    const prone = core.mode === 'paddle' || core.mode === 'catch' || core.mode === 'ride' || core.mode === 'popup';
    // Body frame: heading yaw at the feet (standing) or the board (prone / riding).
    _q.setFromAxisAngle(_up, core.heading + Math.PI / 2);
    const o = prone ? pose.board : _v3.set(core.pos.x, core.feetY, core.pos.z);
    const target = c.at === 'handR' ? pose.armR.wrist : c.at === 'handL' ? pose.armL.wrist : null;
    _v.set(c.cam[0], c.cam[1], c.cam[2]).applyQuaternion(_q);
    if (target) _v.add(target);
    else _v.add(o);
    _v2.set(c.look[0], c.look[1], c.look[2]).applyQuaternion(_q);
    if (target) _v2.add(target);
    else _v2.add(o);
    ctx.camera.position.copy(_v);
    ctx.camera.lookAt(_v2);
    ctx.camera.updateMatrixWorld();
  };

  /** A locked debug camera at a paddling eye line gets a body under it (the `lineup` shot). */
  const followDebugCamera = (ctx: GLContext) => {
    const cam = ctx.camera.position;
    const s = ctx.services.ocean.sample(cam.x, cam.z, core.sample);
    const above = cam.y - s.height;
    if (!(above > 0.2 && above < 0.9 && s.depth > 1.2)) {
      if (group) group.visible = false;
      return;
    }
    if (group) group.visible = true;
    _v.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    const yaw = Math.atan2(-_v.x, -_v.z);
    if (core.mode !== 'paddle') {
      core.teleport(cam.x, cam.z, yaw, 'paddle');
      core.paddleW = 1;
      core.strokeRate = 0.98;
    }
    core.heading = yaw;
    core.yaw = yaw;
    // Board centre 0.3 m behind the eye; then shift the whole body so the eye is the lens.
    core.pos.set(cam.x - _v.x * 0.3, s.height, cam.z - _v.z * 0.3);
    core.paddleW = 1;
    // Frozen stills (shots): hold the right hand at the reach, where the stroke reads best.
    if (ctx.time.frozen && ctx.time.dt === 0) core.stroke = 0.9;
    buildPose(ctx);
    _v2.subVectors(cam, pose.eye);
    translatePose(pose, _v2);
  };

  return {
    name: 'player',
    async init(ctx: GLContext) {
      const P = ctx.params;
      const g = 'player';
      p = {
        demo: P.number('player.demo', { label: 'demo script', group: g, min: 0, max: SCRIPTS.length, step: 1, value: 0 }),
        demoAt: P.number('player.demoAt', { label: 'demo start at (s)', group: g, min: 0, max: 90, step: 0.5, value: 0 }),
        follow: P.toggle('player.follow', { label: 'body under debug cam', group: g, value: false }),
        detach: P.toggle('player.detach', { label: 'demo without the camera (inspect)', group: g, value: false }),
        inspect: P.number('player.inspect', { label: 'inspect camera (lab)', group: g, min: 0, max: INSPECT.length, step: 1, value: 0 }),
        body: P.toggle('player.body', { label: 'arms + legs', group: g, value: true }),
        boardOn: P.toggle('player.board', { label: 'board', group: g, value: true }),
        bob: P.number('player.bob', { label: 'head bob', group: g, min: 0, max: 2, value: 1 }),
        sens: P.number('player.sens', { label: 'mouse sensitivity', group: g, min: 0.0005, max: 0.006, value: 0.0022 }),
        walk: P.number('player.walkSpeed', { label: 'walk speed', group: g, min: 0.6, max: 3, value: 1.45 }),
        run: P.number('player.runSpeed', { label: 'run speed', group: g, min: 2, max: 6, value: 3.4 }),
        thrust: P.number('player.paddleThrust', { label: 'paddle thrust', group: g, min: 0.5, max: 6, value: 2.7 }),
        assist: P.number('player.catchAssist', { label: 'catch assist', group: g, min: 0, max: 3, value: 1.2 }),
        sss: P.number('player.skinSSS', { label: 'skin SSS', group: g, min: 0, max: 3, value: 1 }),
        relief: P.number('player.skinRelief', { label: 'skin relief', group: g, min: 0, max: 3, value: 1 }),
        tone: P.number('player.skinTone', { label: 'skin tone', group: g, min: 0.6, max: 1.4, value: 1 }),
        wet: P.number('player.wet', { label: 'wetness (-1 auto)', group: g, min: -1, max: 1, value: -1 }),
        log: P.toggle('player.log', { label: 'log mode changes', group: g, value: false }),
        tint: P.number('player.boardTint', { label: 'board resin tint', group: g, min: 0, max: 1, value: 1 }),
      };
      tunables.walkSpeed = p.walk.value;
      core = new PlayerCore(ctx, tunables);
      camRig = new CameraRig();

      const r: PlayerRig = {
        mode: 'walk',
        eye: new Vector3(),
        velocity: new Vector3(),
        yaw: 0,
        pitch: 0,
        boardPosition: new Vector3(),
        boardYaw: 0,
        boardQuat: new Quaternion(),
        board: boardSpec,
        stance,
        cam: camRig,
        wetness: 0,
        modeTime: 0,
        speed: 0,
        lookYaw: 0,
        demoActive: false,
        intent, // [surf]
        externalIntent: null, // [surf]
        viewTurn: 0, // [surf]
        teleport(x: number, z: number, yaw: number, mode?: PlayerMode) {
          core.teleport(x, z, yaw, mode ?? 'walk');
          r.mode = core.mode;
          buildPose(ctx);
          camRig.reset(pose.eye);
          r.eye.copy(pose.eye);
        },
        setMode(mode: PlayerMode, blend?: number) {
          core.requested = mode;
          core.requestedBlend = blend ?? 0;
        },
        setRideDriver(d: RideDriver | null) {
          core.driver = d;
        },
      };
      rig = r;
      ctx.services.player = r;

      // Detail maps.
      // [polish] Detail maps, board and pad geometry are baked in the boot workers (core/bakes.ts).
      const [noise, wax, beads, skin, boardGeo, padGeo] = await Promise.all([
        bake('player.noise'),
        bake('player.wax'),
        bake('player.beads'),
        bake('player.skin'),
        bake('player.board'),
        bake('player.pad'),
      ]);
      disposables.push(noise, wax, beads, skin);

      group = new Group();
      group.name = 'player';

      // Board.
      boardLook = createBoardLook(ctx.services.atmosphere.sunDirNode);
      const boardMat = createBoardMaterial(boardLook, { wax, beads, noise });
      const padMat = createPadMaterial(boardLook, { noise });
      disposables.push(boardMat, padMat, boardGeo, padGeo);
      boardGroup = new Group();
      boardGroup.matrixAutoUpdate = false;
      const boardMesh = new Mesh(boardGeo, boardMat);
      const padMesh = new Mesh(padGeo, padMat);
      for (const m of [boardMesh, padMesh]) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        boardGroup.add(m);
      }
      group.add(boardGroup);

      // Limbs: right side meshed, left mirrored.
      skinLook = createSkinLook();
      const skinMat = createSkinMaterial(skinLook, { skin, beads, noise });
      disposables.push(skinMat);
      const [armGeo, legGeo] = await Promise.all([bake('player.arm'), bake('player.leg')]); // [polish] worker bakes
      const armR = buildLimb(buildArm(1), undefined, armGeo);
      const armL = buildLimb(buildArm(-1), armR);
      const legR = buildLimb(buildLeg(1), undefined, legGeo);
      const legL = buildLimb(buildLeg(-1), legR);
      for (const l of [armR, armL, legR, legL]) disposables.push(l.geometry, l.skeleton);
      arms = [new ArmRig(armL, skinMat, -1), new ArmRig(armR, skinMat, 1)];
      legs = [new LegRig(legL, skinMat, -1), new LegRig(legR, skinMat, 1)];
      for (const l of arms) group.add(l.mesh);
      for (const l of legs) group.add(l.mesh);
      // Discarded in every camera pass (colour, depth, MRT); kept in the shadow pass only.
      const ghost = new MeshBasicNodeMaterial();
      ghost.maskNode = bool(false);
      ghost.maskShadowNode = bool(true);
      const tGeo = new CapsuleGeometry(1, 0.9, 4, 16);
      const hGeo = new SphereGeometry(0.11, 16, 12);
      disposables.push(ghost, tGeo, hGeo);
      torso = new Mesh(tGeo, ghost);
      head = new Mesh(hGeo, ghost);
      for (const m of [torso, head]) {
        m.castShadow = true;
        m.receiveShadow = false;
        m.frustumCulled = false;
        m.matrixAutoUpdate = false;
        m.matrixWorldAutoUpdate = false;
        group.add(m);
      }
      drips = new Drips();
      group.add(drips.mesh);
      disposables.push(drips);
      // Drips fall within a metre of the body: one water height per frame is plenty.
      waterAt = () => dripWater;
      // [polish] the body and board cast into the nearest shadow cascade only (atmosphere/shadows.ts)
      group.traverse((o) => o.layers.set(NEAR_CASTER_LAYER));
      ctx.scene.add(group);
      console.info(`[goldenline] player limbs built in ${(armR.ms + armL.ms + legR.ms + legL.ms).toFixed(0)} ms`);

      r.teleport(SPAWN.x, SPAWN.z, SPAWN.yaw, 'walk');
      ctx.params.onChange((q) => {
        if (q === p.demo) demoPending = true;
        if (q === p.walk) tunables.walkSpeed = p.walk.value;
        if (q === p.run) tunables.runSpeed = p.run.value;
        if (q === p.thrust) tunables.paddleThrust = p.thrust.value;
        if (q === p.assist) tunables.catchAssist = p.assist.value;
      });
      tunables.runSpeed = p.run.value;
      tunables.paddleThrust = p.thrust.value;
      tunables.catchAssist = p.assist.value;
      if (p.demo.value > 0) demoPending = true;
    },

    warmup(ctx: GLContext) {
      // Pose once so the skinned meshes have valid bones for the pipeline warm-up.
      tick(ctx, 1 / 60, false);
    },

    update(ctx: GLContext) {
      const dt = ctx.time.dt;
      // Demo scripts own the camera; a debug camera move from elsewhere ends the demo.
      if (demoPending) {
        demoPending = false;
        demoLast = p.demo.value;
        if (demoLast > 0) startDemo(ctx, demoLast);
        else {
          rig.demoActive = false;
          runner.stop();
        }
      } else if (rig.demoActive && !p.detach.value && ctx.debug.cameraLocked && ctx.camera.position.distanceToSquared(lastCam) > 1e-6) {
        rig.demoActive = false;
        runner.stop();
        ctx.params.set('player.demo', 0);
        demoPending = false;
      }
      if (ctx.debug.cameraLocked && !rig.demoActive) {
        // Someone else's shot: stay out of it unless asked to put a body under the camera.
        if (!p.follow.value) {
          if (group) group.visible = false;
          return;
        }
        tick(ctx, dt, false);
        return;
      }
      if (group) group.visible = true;
      tick(ctx, dt, false);
    },

    dispose(ctx: GLContext) {
      if (group) ctx.scene.remove(group);
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      group = null;
      boardGroup = null;
      arms = null;
      legs = null;
    },
  };
}

function translatePose(p: Pose, d: Vector3) {
  p.eye.add(d);
  p.board.add(d);
  p.armL.shoulder.add(d);
  p.armL.wrist.add(d);
  p.armL.pole.add(d);
  p.armR.shoulder.add(d);
  p.armR.wrist.add(d);
  p.armR.pole.add(d);
  p.legL.hip.add(d);
  p.legL.ankle.add(d);
  p.legL.pole.add(d);
  p.legR.hip.add(d);
  p.legR.ankle.add(d);
  p.legR.pole.add(d);
}
