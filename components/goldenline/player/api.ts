// The player's extended service. Everything here is additive on top of PlayerService
// (core/contracts.ts); the surf system (B1) imports these types to take over the ride.
// See player/README.md for the state machine and the hand-off.

import type { Quaternion, Vector3 } from 'three/webgpu';
import type { GLContext, PlayerMode, PlayerService } from '../core/contracts';

/**
 * Board frame: +X toward the nose, +Y out of the deck, +Z toward the rider's right when prone.
 * The origin sits on the bottom's centreline at mid-length (the rocker's flat spot is ~y = 0).
 */
export interface BoardSpec {
  length: number;
  /** Deck height above the origin at mid-length (the board's thickness there). */
  deckY: number;
  /** Half-width at mid-length. */
  halfWidth: number;
  /** Deck height (board frame) at a station x (m from mid-length), on the centreline. */
  deckAt(x: number): number;
  /** Half-width at a station x. */
  halfWidthAt(x: number): number;
}

/** Where the feet stand on the board while riding (board frame, metres). */
export interface Stance {
  frontX: number;
  frontZ: number;
  /** Foot heading in the board's XZ plane (rad, 0 = +X toward the nose). */
  frontAngle: number;
  rearX: number;
  rearZ: number;
  rearAngle: number;
  /** 0 = tall, 1 = deep crouch. */
  crouch: number;
  /** -1 = leaning on the heels, +1 = on the toes (weight shift rail to rail). */
  lean: number;
  /** -1..1 fore/aft weight (front foot vs back foot). */
  fore: number;
  /** Arm spread for balance, 0..1. */
  arms: number;
}

/** Camera effects other systems can drive. All of them are no-ops under reduced motion except `roll`. */
export interface CameraFx {
  /** Extra vertical FOV in degrees (speed push). Eased by the camera, so write a target. */
  fovKick: number;
  /** Horizon bank (rad, + = roll right). Eased. */
  roll: number;
  /** Extra pitch (rad) applied on top of mouse look, e.g. looking down the face. Eased. */
  pitchOffset: number;
  /** Positional head offset (world metres) added after the head spring. Not eased. */
  offset: Vector3;
  /** Add trauma for camera shake (0..1). Decays on its own. */
  shake(amount: number): void;
  /** Kick the head spring (world m/s), e.g. a whitewater hit. */
  impulse(x: number, y: number, z: number): void;
}

/**
 * The surf system's take-over. Register with `rig.setRideDriver(driver)`. The player calls
 * `begin` once when the pop-up lands, then `update` every frame while the mode is 'ride' (and
 * 'wipeout' if `handlesWipeout`). The driver writes the board pose (rig.boardPosition,
 * rig.boardQuat), the stance, rig.velocity and the camera FX; the player renders the board, legs,
 * arms and camera from those. Return the next mode: 'ride' to keep riding, 'wipeout', or 'paddle'
 * (kick-out / the wave is gone: the player eases back to prone paddling).
 */
export interface RideDriver {
  handlesWipeout?: boolean;
  begin(ctx: GLContext, rig: PlayerRig): void;
  update(ctx: GLContext, rig: PlayerRig, dt: number): PlayerMode;
  end?(ctx: GLContext, rig: PlayerRig): void;
}

export interface PlayerRig extends PlayerService {
  /** Full board orientation (board frame → world). boardYaw mirrors its heading. */
  boardQuat: Quaternion;
  board: BoardSpec;
  stance: Stance;
  cam: CameraFx;
  /** 0..1 seconds-scaled wetness of skin and board (1 = just out of the water). */
  wetness: number;
  /** Seconds spent in the current mode. */
  modeTime: number;
  /** Planing speed along the board heading (m/s), written by whoever drives the board. */
  speed: number;
  /** Heading the head looks along, relative to the board heading, while prone or riding (rad). */
  lookYaw: number;
  /** Change mode with an eased transition (never snaps). */
  setMode(mode: PlayerMode, blendSeconds?: number): void;
  setRideDriver(driver: RideDriver | null): void;
  /** True while a debug demo script drives the player (see player/script.ts). */
  demoActive: boolean;
}

export function isPlayerRig(p: PlayerService): p is PlayerRig {
  return (p as Partial<PlayerRig>).setRideDriver !== undefined;
}
