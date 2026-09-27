// GOLDENLINE surfing (B1): the ride (board physics on the breaker, carves, pump, stall, the tube,
// wipeouts), its camera, rail wake and spray, and the demo playbacks. Takes over the player at
// the pop-up through A6's RideDriver hook (player/README.md). See surf/README.md.

import { Vector3 } from 'three/webgpu';
import type { GLContext, GLSystem } from '../core/contracts';
import type { NumberParam, ToggleParam } from '../core/params';
import { isPlayerRig, type PlayerRig } from '../player/api';
import { SCRIPTS } from './demos';
import { type FxTune, RideFx } from './fx';
import { Ride, type RideTune } from './ride';
import { BoardSim } from './sim';
import { ScriptPlayer } from './script';

const _c = new Vector3();
const _t = new Vector3();

/** Debug: look at the rider from outside (reviewing fans, shadows, the barrel). Allocation-free. */
function chaseCamera(ctx: GLContext, rig: PlayerRig, mode: number) {
  const b = rig.boardPosition;
  const hx = -Math.sin(rig.boardYaw);
  const hz = -Math.cos(rig.boardYaw);
  if (mode === 1) _c.set(b.x - hz * 6.5 + hx * 1.5, b.y + 1.6, b.z + hx * 6.5 + hz * 1.5);
  else if (mode === 2) _c.set(b.x - hx * 7, b.y + 3.5, b.z - hz * 7);
  else if (mode === 3) _c.set(b.x + hx * 6 + hz * 0.6, b.y + 0.9, b.z + hz * 6 - hx * 0.6);
  // 4: exactly down-sun of the rider, looking back up-sun: fans glow, and their shadows run toward
  // the lens down the glitter path.
  else if (mode === 5) {
    // 5: above and down-sun, looking down past the rider at the water the fan's shadow falls on.
    const sd = ctx.services.atmosphere.sunDir;
    const l = Math.max(1e-3, Math.hypot(sd.x, sd.z));
    _c.set(b.x - (sd.x / l) * 7, b.y + 7.5, b.z - (sd.z / l) * 7);
    _t.set(b.x - (sd.x / l) * 2.5, b.y, b.z - (sd.z / l) * 2.5);
  } else {
    const sd = ctx.services.atmosphere.sunDir;
    const l = Math.max(1e-3, Math.hypot(sd.x, sd.z));
    _c.set(b.x - (sd.x / l) * 11, b.y + 2.2, b.z - (sd.z / l) * 11);
  }
  if (mode !== 5) _t.set(b.x, b.y + 0.9, b.z);
  ctx.debug.cameraLocked = true;
  if (ctx.params.get('player.detach')?.value !== true) ctx.params.set('player.detach', true);
  ctx.camera.position.copy(_c);
  ctx.camera.lookAt(_t);
  ctx.camera.updateMatrixWorld();
}

export function createSurfSystem(): GLSystem {
  let ride: Ride | null = null;
  let rig: PlayerRig | null = null;
  let player: ScriptPlayer | null = null;
  let p: {
    demo: NumberParam;
    log: ToggleParam;
    logFrames: ToggleParam;
    chase: NumberParam;
  };
  const tune: RideTune = {
    drag1: 0.1,
    drag2: 0.022,
    grip0: 5,
    gripV: 1.3,
    latMax: 21,
    pump: 1.6,
    stall: 1.1,
    soup: 1.4,
    sepV: 1.4,
    lookGain: 3,
    carveG: 1.5,
    railRate: 7,
    bank: 0.4,
    fov: 9,
    pocket: 12,
  };
  const fxTune: FxTune = { fan: 1, trail: 1, sheet: 1 };
  let fx: RideFx | null = null;
  let demoPending = false;
  let lastMode = '';

  const startDemo = (ctx: GLContext, n: number) => {
    const s = SCRIPTS[n - 1];
    if (!s || !rig || !player) return;
    ctx.time.t = s.start.t;
    rig.teleport(s.start.x, s.start.z, s.start.yaw, s.start.mode);
    player.start(s);
    fx?.reset();
    rig.demoActive = true;
    rig.externalIntent = intentFromScript;
    // The playback owns the camera through the player (a shot's locked camera is released).
    ctx.debug.cameraLocked = false;
  };
  let intentFromScript: (out: PlayerRig['intent']) => void = () => {};

  return {
    name: 'surf',
    init(ctx: GLContext) {
      const P = ctx.params;
      const g = 'surf';
      p = {
        demo: P.number('surf.demo', { label: 'demo (1 ride, 2 pier run, 3 wipeout)', group: g, min: 0, max: SCRIPTS.length, step: 1, value: 0 }),
        log: P.toggle('surf.log', { label: 'log mode changes', group: g, value: false }),
        logFrames: P.toggle('surf.logFrames', { label: 'log the ride per frame', group: g, value: false }),
        chase: P.number('surf.chase', { label: 'debug chase camera (1 side, 2 behind, 3 ahead, 4 down-sun, 5 overhead)', group: g, min: 0, max: 5, step: 1, value: 0 }),
      };
      const nums: Array<[keyof RideTune, string, number, number]> = [
        ['drag1', 'planing drag (linear)', 0, 1],
        ['drag2', 'planing drag (quadratic)', 0, 0.08],
        ['grip0', 'fin grip at rest', 0, 20],
        ['gripV', 'fin grip per m/s', 0, 4],
        ['latMax', 'fin hold (m/s²)', 5, 40],
        ['pump', 'pump thrust (m/s²)', 0, 5],
        ['stall', 'stall drag', 0, 4],
        ['soup', 'whitewater drag', 0, 5],
        ['lookGain', 'look steering gain', 0.5, 8],
        ['carveG', 'carve limit (g)', 0.5, 3],
        ['railRate', 'rail-to-rail rate', 1, 20],
        ['bank', 'horizon bank share', 0, 1],
        ['fov', 'FOV push at speed (deg)', 0, 20],
        ['pocket', 'pocket drive (m/s², 0 = pure physics)', 0, 16],
      ];
      for (let i = 0; i < nums.length; i++) {
        const [k, label, min, max] = nums[i];
        const prm = P.number(`surf.${k}`, { label, group: g, min, max, value: tune[k] });
        tune[k] = prm.value;
      }
      const fxp: Array<[keyof FxTune, string]> = [
        ['fan', 'rail spray fan ×'],
        ['trail', 'foam trail ×'],
        ['sheet', 'speed spray ×'],
      ];
      for (let i = 0; i < fxp.length; i++) {
        const [k, label] = fxp[i];
        fxTune[k] = P.number(`surf.fx.${k}`, { label, group: g, min: 0, max: 3, value: fxTune[k] }).value;
      }
      ctx.params.onChange((q) => {
        if (q === p.demo) demoPending = true;
        if (q.key === 'surf.fx.proxies' && fx) fx.showU.value = q.value ? 1 : 0;
        if (q.key === 'surf.fx.test' && fx) fx.test[0] = q.value ? 1 : 0;
        if (q.key === 'surf.fx.shadows' && fx) fx.proxies.castShadow = !!q.value;
        if (q.key === 'surf.fx.shadowScale' && fx && q.kind === 'number') {
          fx.shadowScale = q.value;
          return;
        }
        if (q.key.startsWith('surf.fx.') && q.kind === 'number') {
          const k = q.key.slice(8) as keyof FxTune;
          if (k in fxTune) fxTune[k] = q.value;
          return;
        }
        if (q.group === g && q.kind === 'number' && q.key.startsWith('surf.')) {
          const k = q.key.slice(5) as keyof RideTune;
          if (k in tune) tune[k] = q.value;
        }
      });
      ride = new Ride(tune);
      fx = new RideFx(fxTune);
      fx.showU.value = P.toggle('surf.fx.proxies', { label: 'show the spray-shadow proxies (debug)', group: g, value: false }).value ? 1 : 0;
      fx.test[0] = P.toggle('surf.fx.test', { label: 'test fan over the pier tip (debug)', group: g, value: false }).value ? 1 : 0;
      fx.proxies.castShadow = P.toggle('surf.fx.shadows', { label: 'spray fans cast shadows', group: g, value: true }).value;
      fx.shadowScale = P.number('surf.fx.shadowScale', { label: 'spray shadow clump size ×', group: g, min: 0.25, max: 4, value: 1 }).value;
      ctx.scene.add(fx.proxies);
      const r = ctx.services.player;
      if (isPlayerRig(r)) {
        rig = r;
        rig.setRideDriver(ride);
        player = new ScriptPlayer(ctx, rig, ride, rig.intent);
        const sp = player;
        intentFromScript = (out) => sp.step(out);
      }
      if (p.demo.value > 0) demoPending = true;
      // Dev-only handle for probes (scratch scripts drive the sim against synthetic surfaces).
      if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') (window as unknown as { __surf?: unknown }).__surf = { ride, tune, BoardSim, fx, player };
    },

    warmup(ctx: GLContext) {
      // The spray-shadow proxies only draw while a fan is flying: give them instances for the
      // warm frames so their shadow pipelines compile during loading.
      if (fx) fx.warm();
    },

    update(ctx: GLContext) {
      if (!ride || !rig) return;
      if (fx) fx.update(ctx, rig, ride);
      if (demoPending) {
        demoPending = false;
        if (p.demo.value > 0) startDemo(ctx, p.demo.value);
        else {
          player?.stop();
          rig.externalIntent = null;
          rig.demoActive = false;
        }
      }
      if (p.chase.value > 0 && rig.demoActive) chaseCamera(ctx, rig, p.chase.value);
      if (p.log.value && ctx.time.dt > 0) {
        const s = ride.state;
        const b = ride.bp;
        const m = rig.mode;
        if (m !== lastMode)
          console.warn(`[surf] mode ${lastMode} → ${m} t=${ctx.time.t.toFixed(2)} ${ride.endReason} p(${rig.boardPosition.x.toFixed(1)},${rig.boardPosition.y.toFixed(2)},${rig.boardPosition.z.toFixed(1)}) phase=${player?.phase ?? ''}`);
        lastMode = m;
        if (p.logFrames.value && (m === 'ride' || m === 'popup' || m === 'catch'))
          console.warn(
            `[surf] t=${ctx.time.t.toFixed(2)} ${player?.phase ?? ''} ${m} p(${rig.boardPosition.x.toFixed(1)},${rig.boardPosition.y.toFixed(2)},${rig.boardPosition.z.toFixed(1)}) v=${s.speed.toFixed(1)} |v|=${Math.hypot(s.vx, s.vy, s.vz).toFixed(1)} vy=${s.vy.toFixed(1)} aLat=${(s.aLat / 9.81).toFixed(2)}g skid=${s.skid.toFixed(1)} rail=${((s.rail * 180) / Math.PI).toFixed(0)} yaw=${((ride.sim.yaw * 180) / Math.PI).toFixed(0)} view=${((rig.yaw * 180) / Math.PI).toFixed(0)} n.y=${ride.sim.ny.toFixed(2)} air=${s.airborne ? 1 : 0} | φ=${b.phi.toFixed(2)} u=${b.u.toFixed(1)} H=${b.H.toFixed(1)} c=${b.c.toFixed(1)} act=${b.active.toFixed(2)} tube=${s.tube.toFixed(2)} brk=${s.breaking.toFixed(2)} drive=${ride.drive.toFixed(1)} vPeel=${(s.vx * b.peelX + s.vz * b.peelZ).toFixed(1)} pk=${ride.peelS.toFixed(1)} dphi=${ride.dphiS.toFixed(2)} Ts=${b.Ts.toFixed(2)} slip=${ride.sim.slip.toFixed(2)}`,
          );
      }
    },

    dispose(ctx: GLContext) {
      if (fx) {
        ctx.scene.remove(fx.proxies);
        fx.dispose();
        fx = null;
      }
      if (rig) {
        rig.setRideDriver(null);
        rig.externalIntent = null;
      }
      ride = null;
      rig = null;
      player = null;
    },
  };
}
