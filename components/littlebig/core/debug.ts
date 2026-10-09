// window.__littlebig: the hook scripts/littlebig-shot.mjs (and Playwright tests) drive for
// deterministic screenshots, sequences, perf and boot timings. Installed in dev, and in
// production only with ?shot=1.

import type { BootEntry, CameraMode, LBContext, RideView, TrackKind, ViewSpec } from './contracts';
import type { BirdHold } from '../camera/bird';
import { DIVE_SECONDS } from '../camera/dive';
import { DIVE_T0, diveAt, SHOTS } from './shots';

export interface PerfResult {
  frames: number;
  /** Serial CPU+GPU cost per frame (update + render + GPU sync), ms. */
  median: number;
  p95: number;
  max: number;
  mean: number;
  /** Frames over median + 6 ms (BRIEF §1 hitch rule). */
  hitches: number;
  /**
   * Serial cost of rendering an EMPTY scene the same way (clear + present + GPU sync), ms. In
   * headless Chromium this harness overhead is ~5-6 ms; `net` = median − baseline is the scene.
   */
  baseline: number;
  net: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  /** rAF interval stats from the live loop before the run (vsync-quantised), ms. */
  raf: { median: number; p95: number; max: number };
}

export interface LittlebigHook {
  /** True once every stage-2 system has initialised (wait for this before shooting). */
  ready: boolean;
  ctx: LBContext;
  /** Place the camera (degrees). glide: see CameraService.setView. */
  setView(v: ViewSpec, glide?: number): void;
  getView(): Required<ViewSpec>;
  /** Jump sim time (s); systems get onTimeJump. */
  setTime(t: number): void;
  /** Advance the sim by n steps of dt seconds (fixed-step accumulated), then render once. */
  step(dt?: number, n?: number): void;
  /** Freeze / unfreeze real-time advance (frozen by default in shot mode). */
  freeze(on: boolean): void;
  shots(): Array<{ name: string; about: string }>;
  /** Apply a named shot (view + time). Returns false for an unknown name. */
  shot(name: string): boolean;
  /**
   * Put the camera at fraction u of the scripted dive and render one full frame. glide = seconds
   * since the previous frame (the camera's ground/roof reference springs over it); dt = sim seconds
   * to advance with the frame (default: glide), so cars, people, planes and clouds move along the
   * descent. The true camera path needs glide = diveSeconds / (frames − 1): render the /play clip
   * at 30 fps (diveSeconds × 30 + 1 frames).
   */
  dive(u: number, glide?: number, dt?: number): void;
  /** Nominal length of the scripted dive at 1× (s). */
  readonly diveSeconds: number;
  /** Sim time the /play clip's dive starts at (the shot tool's `--dive` default for `--t`). */
  readonly diveT0: number;
  /** Measure n frames serially (CPU + GPU, synced). */
  perf(frames?: number): Promise<PerfResult>;
  boot(): BootEntry[];
  params: {
    list(): Record<string, number | boolean>;
    get(key: string): number | boolean | undefined;
    set(key: string, value: number | boolean): boolean;
  };
  /** Current camera + sim state. */
  state(): Record<string, unknown>;
  /** Render one frame now (no sim advance). */
  render(): void;
  /** Stop / restart the rAF loop (scripted measurements drive frames themselves). */
  loop(on: boolean): void;
  /** renderer.info memory/programs plus scene counts (leak checks). */
  info(): { geometries: number; textures: number; programs: number; calls: number; triangles: number; objects: number };
  // ── v2 (D1): rides and the bird, for deterministic review shots ──
  /**
   * Ride a Trackable. Settled at once (the transition skipped, every spring at rest) and rendered,
   * unless live: then the transition runs as the frames advance (step / advance). False if unknown
   * or not drawn.
   */
  ride(id: string, opts?: { live?: boolean }): boolean;
  /** Bird flight from the current pose (settled unless live). */
  fly(opts?: { live?: boolean }): void;
  /** Back to explore: instantly (live: the real blended hand-back). */
  exitMode(opts?: { live?: boolean }): void;
  mode(): { mode: CameraMode; ride: string | null; blend: number };
  /** Every registered Trackable, and whether it is drawn right now. */
  trackables(kind?: TrackKind): Array<{ id: string; kind: TrackKind; label: string; sub?: string; view: RideView; radius: number; shown: boolean }>;
  /** Hold a bird input (deterministic flights; the review tool's --steer), or null to let go. */
  birdInput(i: { steer?: number; climb?: number; flap?: boolean; dive?: boolean } | null): void;
  /**
   * Advance `seconds` in frames of 1/fps (sim, camera, ride and bird all move), rendering only the
   * last one: the live path, deterministic.
   */
  advance(seconds: number, fps?: number): void;
  /**
   * v2 (BA): freeze the bird at a pose for close review, the camera on a turntable round it (null
   * lets go and hands the camera back). The first call anchors the bird 3 m ahead of the camera,
   * level, heading along the view; later calls keep that spot until let go. False before the bird
   * system is up.
   */
  birdPose(p: BirdPoseSpec | null): boolean;
}

/** A bird review pose (core/debug.ts birdPose; scripts/littlebig-shot.mjs --bird-pose). */
export interface BirdPoseSpec {
  /** The beat: phase (rad), or u, the cycle fraction (downstroke [0, 0.55), then the upstroke). */
  phase?: number;
  u?: number;
  /** camera/bird/shared.ts BirdRender: amp, tuck, spread, turn, speed (m/s), crash, stand, legs, hop. */
  amp?: number;
  tuck?: number;
  spread?: number;
  turn?: number;
  speed?: number;
  crash?: number;
  stand?: number;
  legs?: number;
  hop?: number;
  /** 1: set it on the floor below its spot (standing height, FEET × scale), level. */
  ground?: number;
  /** Seconds since the impact (the daze), and the clock (s) of the glide's life and the flail. */
  daze?: number;
  clock?: number;
  /** Body attitude (deg): nose up +, banked right +. */
  pitch?: number;
  bank?: number;
  /** Turntable: azimuth round the bird (deg: 0 behind, 90 its left, 180 head on), elevation (deg), distance (m), lens (deg). */
  az?: number;
  el?: number;
  dist?: number;
  fov?: number;
  /** Draw scale (default 0.62, the game's BIRD_SIZE). */
  scale?: number;
}

/** The camera system's dev-only extras (camera/index.ts), not part of the contract. */
interface CameraDev {
  director?: {
    ride(ctx: LBContext, id: string, instant?: boolean): boolean;
    fly(ctx: LBContext, instant?: boolean): void;
    exitMode(ctx: LBContext, instant?: boolean): void;
    settle(ctx: LBContext): void;
    override: { steer: number; climb: number; flap: boolean; dive: boolean } | null;
  };
}

declare global {
  interface Window {
    __littlebig?: LittlebigHook;
  }
}

export interface DebugDeps {
  enabled: boolean;
  isReady(): boolean;
  setTime(t: number): void;
  step(dt: number, n: number): void;
  renderNow(): void;
  /** Run one full frame (update + render) synchronously with the given sim dt. */
  frameNow(dt: number): void;
  pauseLoop(): void;
  resumeLoop(): void;
}

export function installDebugHook(ctx: LBContext, deps: DebugDeps): () => void {
  if (!deps.enabled || typeof window === 'undefined') return () => {};
  const birdPose = birdPoseHook(ctx, deps);
  const hook: LittlebigHook = {
    birdPose,
    get ready() {
      return deps.isReady();
    },
    ctx,
    setView(v, glide) {
      ctx.debug.cameraLocked = true;
      ctx.services.camera.setView(v, glide ? { glide } : undefined);
      deps.renderNow();
    },
    getView: () => ctx.services.camera.getView(),
    setTime(t) {
      deps.setTime(t);
      deps.renderNow();
    },
    step(dt = 1 / 60, n = 1) {
      deps.step(dt, n);
    },
    freeze(on) {
      ctx.time.frozen = on;
    },
    shots: () => Object.entries(SHOTS).map(([name, s]) => ({ name, about: s.about })),
    shot(name) {
      const s = SHOTS[name];
      if (!s) return false;
      const view = s.view(ctx);
      deps.setTime(typeof s.t === 'function' ? s.t(view) : (s.t ?? 0));
      ctx.debug.cameraLocked = true;
      ctx.services.camera.setView(view);
      // One update so time-driven uniforms (sun, fog) match the new time, then render.
      deps.frameNow(0);
      // v2 (D1): a ride or the bird on top of the view.
      if (s.ride) hook.ride(s.ride);
      if (s.bird) {
        hook.birdInput({ steer: s.bird.steer, climb: s.bird.climb, flap: s.bird.flap, dive: s.bird.dive });
        hook.fly();
        hook.advance(s.bird.secs);
      }
      return true;
    },
    dive(u, glide, dt) {
      ctx.debug.cameraLocked = true;
      ctx.services.camera.setView(diveAt(ctx, u), glide ? { glide } : undefined);
      deps.frameNow(Math.max(0, dt ?? glide ?? 0));
    },
    diveSeconds: DIVE_SECONDS,
    diveT0: DIVE_T0,
    async perf(frames = 120) {
      const raf = ctx.perf.summarize();
      deps.pauseLoop();
      await new Promise((r) => setTimeout(r, 30));
      const gl = ctx.renderer.getContext();
      const px = new Uint8Array(4);
      const ts: number[] = [];
      const dt = ctx.time.frozen ? 0 : 1 / 60;
      for (let i = 0; i < frames + 15; i++) {
        const t0 = performance.now();
        deps.frameNow(dt);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // waits for the GPU
        if (i >= 15) ts.push(performance.now() - t0);
      }
      const info = ctx.renderer.info;
      const calls = info.render.calls;
      const triangles = info.render.triangles;
      // Harness baseline: the same loop drawing an empty scene.
      const Empty = ctx.scene.constructor as new () => typeof ctx.scene;
      const empty = new Empty();
      const bs: number[] = [];
      for (let i = 0; i < 70; i++) {
        const t0 = performance.now();
        ctx.renderer.render(empty, ctx.camera);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (i >= 10) bs.push(performance.now() - t0);
      }
      bs.sort((a, b) => a - b);
      const baseline = bs[bs.length >> 1];
      deps.renderNow();
      deps.resumeLoop();
      const so = ts.slice().sort((a, b) => a - b);
      const median = so[so.length >> 1];
      return {
        frames,
        median,
        p95: so[Math.floor(so.length * 0.95)],
        max: so[so.length - 1],
        mean: ts.reduce((a, b) => a + b, 0) / ts.length,
        hitches: ts.filter((t) => t > median + 6).length,
        baseline,
        net: Math.max(0, median - baseline),
        drawCalls: calls,
        triangles,
        programs: info.programs?.length ?? 0,
        raf: { median: raf.median, p95: raf.p95, max: raf.max },
      };
    },
    boot: () => ctx.boot.entries.slice(),
    params: {
      list: () => ctx.params.snapshot(),
      get: (k) => ctx.params.get(k)?.value,
      set: (k, v) => ctx.params.set(k, v),
    },
    state() {
      const v = ctx.view;
      return {
        lat: v.lat,
        lon: v.lon,
        alt: v.alt,
        altTerrain: v.altTerrain,
        altSea: v.altSea,
        ground: v.ground,
        heading: (v.heading * 180) / Math.PI,
        pitch: (v.pitch * 180) / Math.PI,
        fov: v.fov,
        street: v.street,
        mode: v.mode,
        ride: v.ride,
        city: { x: v.cityX, z: v.cityZ, dist: v.cityDist },
        near: ctx.camera.near,
        far: ctx.camera.far,
        t: ctx.time.t,
        frame: ctx.time.frame,
        frozen: ctx.time.frozen,
        quality: ctx.quality,
        reveal: ctx.reveal.clock,
        ready: deps.isReady(),
      };
    },
    render() {
      deps.renderNow();
    },
    loop(on) {
      if (on) deps.resumeLoop();
      else deps.pauseLoop();
    },
    ride(id, opts) {
      const dir = (ctx.services.camera as CameraDev).director;
      if (!dir) return false;
      ctx.debug.cameraLocked = true;
      if (!dir.ride(ctx, id, !opts?.live)) return false;
      if (!opts?.live) dir.settle(ctx);
      deps.frameNow(0);
      return true;
    },
    fly(opts) {
      const dir = (ctx.services.camera as CameraDev).director;
      if (!dir) return;
      ctx.debug.cameraLocked = true;
      dir.fly(ctx, !opts?.live);
      if (!opts?.live) dir.settle(ctx);
      deps.frameNow(0);
    },
    exitMode(opts) {
      const dir = (ctx.services.camera as CameraDev).director;
      if (!dir) return;
      dir.exitMode(ctx, !opts?.live);
      deps.frameNow(0);
    },
    mode: () => {
      const m = ctx.services.camera.mode?.();
      return m ? { mode: m.mode, ride: m.ride, blend: m.blend } : { mode: 'explore', ride: null, blend: 1 };
    },
    trackables(kind) {
      const pose = { pos: ctx.view.eye.clone(), fwd: ctx.view.eye.clone(), up: ctx.view.eye.clone(), speed: 0 };
      return ctx.services.track.list(kind).map((t) => ({ id: t.id, kind: t.kind, label: t.label, sub: t.sub, view: t.view, radius: t.radius, shown: t.pose(ctx, pose) }));
    },
    birdInput(i) {
      const dir = (ctx.services.camera as CameraDev).director;
      if (!dir) return;
      dir.override = i ? { steer: i.steer ?? 0, climb: i.climb ?? 0, flap: i.flap ?? false, dive: i.dive ?? false } : null;
    },
    advance(seconds, fps = 60) {
      const n = Math.max(1, Math.round(seconds * fps));
      // frameNow renders each frame; the in-between ones cost a draw each, which is fine for review.
      for (let i = 0; i < n; i++) deps.frameNow(1 / fps);
    },
    info() {
      const i = ctx.renderer.info;
      let objects = 0;
      ctx.scene.traverse(() => objects++);
      return {
        geometries: i.memory.geometries,
        textures: i.memory.textures,
        programs: i.programs?.length ?? 0,
        calls: i.render.calls,
        triangles: i.render.triangles,
        objects,
      };
    },
  };
  window.__littlebig = hook;
  // Common web-game test hooks; only installed with this development/shot module.
  const testWindow = window as typeof window & { render_game_to_text?: () => string; advanceTime?: (ms: number) => void };
  const previousText = testWindow.render_game_to_text;
  const previousAdvance = testWindow.advanceTime;
  const textState = () => JSON.stringify({ coordinates: 'planet centered at origin; metres, Y up; view lat/lon in degrees', ready: hook.ready, ...hook.state(), mode: hook.mode() });
  const advance = (ms: number) => { if (hook.ready) hook.advance(ms / 1000); };
  testWindow.render_game_to_text = textState;
  testWindow.advanceTime = advance;
  return () => {
    if (window.__littlebig === hook) delete window.__littlebig;
    if (testWindow.render_game_to_text === textState) testWindow.render_game_to_text = previousText;
    if (testWindow.advanceTime === advance) testWindow.advanceTime = previousAdvance;
  };
}

/**
 * v2 (BA) birdPose: holds the bird system's render state at a pose (camera/bird/index.ts calls
 * mesh.userData.hold each update, after the director wrote it) and puts the camera on a turntable
 * round it, on top of the camera system's frame; the lens (near, fov, shift) is saved and handed
 * back on release. three's classes come from cloning the camera's own (no engine imports here).
 */
function birdPoseHook(ctx: LBContext, deps: DebugDeps): LittlebigHook['birdPose'] {
  const D = Math.PI / 180;
  const cam = ctx.camera;
  type Lens = { near: number; fov: number; shift: boolean };
  let at: { P: typeof cam.position; up: typeof cam.position; fwd: typeof cam.position; left: typeof cam.position; camUp: typeof cam.position; saved: Lens; mine: Lens } | null = null;
  const v = cam.position.clone();
  const f = cam.position.clone();
  const u = cam.position.clone();
  const l = cam.position.clone();
  const m = cam.matrix.clone();
  const lens = (): Lens => ({ near: cam.near, fov: cam.fov, shift: !!cam.view?.enabled });
  const setLens = (x: Lens) => {
    cam.near = x.near;
    cam.fov = x.fov;
    if (cam.view) cam.view.enabled = x.shift;
    cam.updateProjectionMatrix();
  };
  return (p) => {
    const bird = ctx.scene.getObjectByName('bird');
    if (!bird) return false;
    if (!p) {
      if (at) {
        setLens(at.saved);
        cam.up.copy(at.camUp);
      }
      delete bird.userData.hold;
      at = null;
      deps.frameNow(0);
      return true;
    }
    ctx.debug.cameraLocked = true;
    if (!at) {
      const fwd = cam.getWorldDirection(cam.position.clone());
      const P = cam.position.clone().addScaledVector(fwd, 3);
      const up = P.clone().normalize();
      fwd.addScaledVector(up, -fwd.dot(up)).normalize();
      // On the floor: the terrain's height there (R = |eye| − altSea), the feet FEET below the centre.
      if (p.ground) P.copy(up).multiplyScalar(cam.position.length() - ctx.view.altSea + ctx.world.planet.surfaceAt(up) + 0.36 * (p.scale ?? 0.62));
      at = { P, up, fwd, left: up.clone().cross(fwd), camUp: cam.up.clone(), saved: lens(), mine: lens() };
    }
    const A = at;
    const q = { amp: 0, tuck: 0, spread: 0, turn: 0, speed: 7, crash: 0, stand: 0, legs: 0, hop: 0, pitch: 0, bank: 0, az: 90, el: 0, dist: 1.8, fov: 30, scale: 0.62, ...p };
    const phase = q.phase ?? (q.u ?? 0) * 2 * Math.PI;
    const hold: BirdHold = (st, dev) => {
      st.show = true;
      st.pos.copy(A.P);
      // Attitude: pitched about the left axis, then banked about the forward one (right wing down +).
      const pr = q.pitch * D;
      const br = q.bank * D;
      f.copy(A.fwd).multiplyScalar(Math.cos(pr)).addScaledVector(A.up, Math.sin(pr));
      u.copy(A.up).multiplyScalar(Math.cos(pr)).addScaledVector(A.fwd, -Math.sin(pr));
      l.copy(A.left).multiplyScalar(Math.cos(br)).addScaledVector(u, Math.sin(br));
      u.multiplyScalar(Math.cos(br)).addScaledVector(A.left, -Math.sin(br));
      st.quat.setFromRotationMatrix(m.makeBasis(l, u, f));
      st.scale = q.scale;
      st.phase = phase;
      st.amp = q.amp;
      st.tuck = q.tuck;
      st.spread = q.spread;
      st.turn = q.turn;
      st.speed = q.speed;
      st.crash = q.crash;
      st.stand = q.stand;
      st.legs = q.legs;
      st.hop = q.hop;
      if (q.clock !== undefined) dev.clock = q.clock;
      // (No daze given: one long over, or the frozen clock would keep the last pose's feathers.)
      dev.daze = q.daze ?? 99;
      // The turntable, in the bird's level frame.
      const a = q.az * D;
      const e = q.el * D;
      v.copy(A.fwd).multiplyScalar(-Math.cos(a)).addScaledVector(A.left, Math.sin(a)).multiplyScalar(Math.cos(e)).addScaledVector(A.up, Math.sin(e));
      cam.position.copy(A.P).addScaledVector(v, q.dist);
      cam.up.copy(Math.abs(q.el) > 80 ? A.fwd : A.up);
      cam.lookAt(A.P);
      // The camera system rewrites the lens only when its own changes: keep its latest for the release.
      const now = lens();
      if (now.near !== A.mine.near || now.fov !== A.mine.fov || now.shift !== A.mine.shift) A.saved = now;
      A.mine = { near: 0.05, fov: q.fov, shift: false };
      setLens(A.mine);
      cam.updateMatrixWorld();
      ctx.uniforms.lbCamPos.value.copy(cam.position);
    };
    bird.userData.hold = hold;
    deps.frameNow(0);
    return true;
  };
}
