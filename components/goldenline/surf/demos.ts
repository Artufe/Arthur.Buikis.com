// The surf demo scripts (see script.ts): closed-loop "hands on the controls" playbacks that the
// shot tool triggers with `surf.demo`.

import type { WaveInfo } from '../core/contracts';
import { newBreakerPoint, type BreakingApi } from '../ocean/breaking/service';
import { PIER } from '../world/layout';
import { look, type Pilot, type SurfScript, yawOf } from './script';

const wv: WaveInfo = { stage: 0, dirX: 1, dirZ: 0, peelX: 0, peelZ: 1, peelSpeed: 0, crestDistance: 1e9, faceHeight: 0, hollowness: 0 };
const bpP = newBreakerPoint();

/** The wave's direction and peel at the player (paddling) → wv / bpP. */
function sense(p: Pilot) {
  const o = p.ctx.services.ocean;
  const x = p.rig.boardPosition.x;
  const z = p.rig.boardPosition.z;
  o.wave(x, z, wv);
  const brk = (o.gpu as { breaking?: BreakingApi }).breaking;
  if (brk) brk.breaker(x, z, bpP);
  else bpP.active = 0;
}

/** View yaw that points `ang` radians from the peel direction toward the wave's travel (+ = down the face). */
function lineYaw(p: Pilot, ang: number) {
  const b = p.ride.bp;
  const px = b.active > 0.05 ? b.peelX : 0;
  const pz = b.active > 0.05 ? b.peelZ : 1;
  const dx = b.active > 0.05 ? b.dx : 1;
  const dz = b.active > 0.05 ? b.dz : 0;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return yawOf(px * c + dx * s, pz * c + dz * s);
}

/** Board heading relative to the line (rad, + = pointing down the face, toward the wave's travel). */
function headingVsLine(p: Pilot) {
  const b = p.ride.bp;
  const dx = b.active > 0.05 ? b.dx : 1;
  const dz = b.active > 0.05 ? b.dz : 0;
  const y = p.ride.sim.yaw;
  const d = -Math.sin(y) * dx - Math.cos(y) * dz;
  return Math.asin(d < -1 ? -1 : d > 1 ? 1 : d);
}

export const RIDE: SurfScript = {
  name: 'ride',
  start: { x: -142, z: -72, yaw: yawOf(0.99, 0.15), pitch: -0.12, mode: 'paddle', t: 36.8 },
  phases: [
    {
      name: 'paddle',
      run(p) {
        sense(p);
        look(p, yawOf(wv.dirX + 0.08, wv.dirZ + 0.18), 0, 4);
        p.out.fwd = 1;
        p.out.run = true;
        return p.rig.mode === 'catch';
      },
    },
    {
      name: 'catch',
      run(p) {
        sense(p);
        look(p, yawOf(wv.dirX + 0.08, wv.dirZ + 0.18), -0.02, 4);
        p.out.fwd = 1;
        p.out.run = true;
        p.a += p.dt;
        if (p.a > 0.12) {
          p.out.action = true;
          p.a = 0;
        }
        return p.rig.mode === 'popup' || p.rig.mode === 'ride';
      },
    },
    {
      // Down the face, angled a little toward the line; eyes on the bottom.
      name: 'drop',
      run(p) {
        look(p, lineYaw(p, 0.9), -0.2, 5);
        return p.rig.mode === 'ride' && p.ride.t > 1.05;
      },
    },
    {
      // Carve 1: off the bottom, back up the face along the line (frontside: toes, D).
      name: 'bottom-turn',
      run(p) {
        look(p, lineYaw(p, -0.2), -0.03, 6);
        p.out.side = headingVsLine(p) > -0.25 ? 1 : 0;
        return p.t > 0.95 || p.rig.mode !== 'ride';
      },
    },
    {
      // In the barrel: hold the line in it (a touch of stall if the curl runs away, pump if the
      // collapse creeps up), eyes on the opening, until the reef runs out and the wave lets go.
      name: 'barrel',
      run(p) {
        const b = p.ride.bp;
        look(p, lineYaw(p, 0.03), -0.14, 4);
        if (b.phi > 2.2) p.out.fwd = 1;
        else if (b.phi < 1.1 && p.t > 0.4) p.out.fwd = -1;
        return (b.active < 0.3 && p.t > 1) || p.t > 6 || p.rig.mode !== 'ride';
      },
    },
    {
      // Spat out onto the shoulder in the channel.
      name: 'shoulder',
      run(p) {
        look(p, yawOf(0.05, 1), -0.12, 3);
        return p.t > 0.6 || p.rig.mode !== 'ride';
      },
    },
    {
      // Carve 2: a cutback on the open shoulder, heel side (A), back toward the whitewater.
      name: 'cutback',
      run(p) {
        look(p, yawOf(0.45, -0.6), -0.18, 6);
        p.out.side = -1;
        return p.t > 1.1 || p.rig.mode !== 'ride';
      },
    },
    {
      // ... and round again toward the pier.
      name: 'rebound',
      run(p) {
        look(p, yawOf(0.2, 1), -0.12, 6);
        p.out.side = 1;
        return p.t > 1.0 || p.rig.mode !== 'ride';
      },
    },
    {
      // Let the rebound's spray fall first.
      name: 'glide',
      run(p) {
        look(p, yawOf(0.2, 1), -0.1, 3);
        return p.t > 0.7 || p.rig.mode !== 'ride';
      },
    },
    {
      // Glide off the speed, looking back along the line at the trail the ride left on the water.
      name: 'glide-look',
      run(p) {
        look(p, yawOf(-0.15, -1), -0.16, 6);
        return p.t > 0.9 || p.rig.mode !== 'ride';
      },
    },
    {
      // Kick out: sit back onto the board beside the pilings.
      name: 'kick-out',
      run(p) {
        look(p, yawOf(-0.3, 1), -0.05, 2.5);
        if (p.t > 0.25) p.out.action = true;
        return p.rig.mode !== 'ride' || p.t > 3;
      },
    },
    {
      name: 'paddle-off',
      run(p) {
        look(p, yawOf(-0.3, 1), -0.08, 2);
        p.out.fwd = p.t > 1.2 ? 1 : 0;
        return p.t > 4;
      },
    },
  ],
};

/** Walk / paddle toward (x, z) like a person would: turn first, then go. Returns the distance. */
function goTo(p: Pilot, x: number, z: number, pitch: number, run: boolean) {
  const dx = x - bodyX(p);
  const dz = z - bodyZ(p);
  const d = Math.hypot(dx, dz);
  const y = yawOf(dx, dz);
  look(p, y, pitch, 4);
  const prone = p.rig.mode === 'paddle' || p.rig.mode === 'catch';
  // Walking turns the body with the view; a prone board only follows the view within ~90°, so
  // scull it round with A/D first.
  let e = y - (prone ? p.rig.boardYaw : p.rig.yaw);
  e = Math.atan2(Math.sin(e), Math.cos(e));
  if (prone && Math.abs(e) > 0.45) {
    p.out.side = e > 0 ? -1 : 1;
    p.out.fwd = 0.35;
  } else p.out.fwd = Math.abs(e) < 0.8 ? Math.min(1, d / 0.8) : 0;
  p.out.run = run;
  return d;
}
function bodyX(p: Pilot) {
  return p.rig.mode === 'walk' || p.rig.mode === 'wade' ? p.rig.eye.x : p.rig.boardPosition.x;
}
function bodyZ(p: Pilot) {
  return p.rig.mode === 'walk' || p.rig.mode === 'wade' ? p.rig.eye.z : p.rig.boardPosition.z;
}

/** The pier run: out along the deck, off the open end, round to the ladder and back up. */
export const PIER_RUN: SurfScript = {
  name: 'pier',
  start: { x: PIER.tipX + 22, z: PIER.z - 0.4, yaw: yawOf(-1, 0), pitch: -0.08, mode: 'walk', t: 30 },
  phases: [
    {
      name: 'walk-out',
      run(p) {
        const d = goTo(p, PIER.tipX + 1.6, PIER.z, -0.1, p.t > 1.5);
        return d < 0.9 || p.t > 14;
      },
    },
    {
      // A few quick steps to the edge and off: Space launches the jump.
      name: 'jump',
      run(p) {
        goTo(p, PIER.tipX - 3, PIER.z, -0.32, true);
        p.out.fwd = 1;
        p.a += p.dt;
        if (p.a > 0.25) p.out.action = true;
        return p.rig.mode !== 'walk' || p.t > 4 || p.rig.eye.y < PIER.deckHeight + 1.2;
      },
    },
    {
      name: 'fall',
      run(p) {
        // Eyes on the water coming up.
        look(p, p.rig.yaw, -0.7, 6);
        return p.rig.mode === 'paddle' || p.t > 3;
      },
    },
    {
      name: 'surface',
      run(p) {
        look(p, yawOf(-0.4, 0.9), -0.1, 1.6);
        return p.t > 1.6;
      },
    },
    {
      // Paddle round in a loop to line up with the ladder.
      name: 'round',
      run(p) {
        const L = p.ctx.services.pier.ladder;
        const lx = L ? L.x : PIER.tipX - 0.4;
        const d = goTo(p, lx - 3.2, PIER.z + 1.4, -0.15, false);
        return d < 1 || p.t > 10;
      },
    },
    {
      name: 'to-ladder',
      run(p) {
        const L = p.ctx.services.pier.ladder;
        const lx = L ? L.x : PIER.tipX - 0.4;
        const d = goTo(p, lx - 1.3, PIER.z, 0.05, false);
        if (d < 0.9) p.out.action = true;
        return p.rig.mode === 'climb' || p.t > 10;
      },
    },
    {
      name: 'climb',
      run(p) {
        const k = p.t;
        look(p, yawOf(1, 0), k < 1.2 ? 0.5 : k < 3.2 ? 0.25 : -0.05, 2);
        return p.rig.mode === 'walk' || p.t > 8;
      },
    },
    {
      name: 'deck',
      run(p) {
        const d = goTo(p, PIER.tipX + 4.5, PIER.z - 0.3, -0.12, false);
        return d < 0.6 || p.t > 5;
      },
    },
    {
      name: 'look-back',
      run(p) {
        look(p, yawOf(-1, 0.1), -0.35, 1.5);
        return p.t > 3;
      },
    },
  ],
};

/** A wipeout: the same takeoff, then a stall held far too long in the barrel until it lands on you. */
export const WIPEOUT: SurfScript = {
  name: 'wipeout',
  start: RIDE.start,
  phases: [
    RIDE.phases[0],
    RIDE.phases[1],
    RIDE.phases[2],
    RIDE.phases[3],
    {
      name: 'stall-too-long',
      run(p) {
        look(p, lineYaw(p, 0.05), -0.12, 4);
        p.out.fwd = -1;
        return p.rig.mode !== 'ride' || p.t > 8;
      },
    },
    {
      name: 'tumble',
      run(p) {
        return p.rig.mode === 'paddle' || p.t > 5;
      },
    },
    {
      name: 'recover',
      run(p) {
        look(p, yawOf(-0.9, 0.3), -0.1, 1.5);
        return p.t > 4;
      },
    },
  ],
};

export const SCRIPTS: SurfScript[] = [RIDE, PIER_RUN, WIPEOUT];
