// What the player wants this frame, from the keyboard/mouse or from a demo script.

import type { Input } from '../core/input';

export interface Intent {
  /** -1..1 forward / back. */
  fwd: number;
  /** -1..1 right / left (+ = right). */
  side: number;
  run: boolean;
  /** Mouse look deltas in radians (+x = turn right, +y = look down). */
  lookX: number;
  lookY: number;
  /** Space: pop-up / push-up / slide onto the board. */
  action: boolean;
  actionHeld: boolean;
}

export function makeIntent(): Intent {
  return { fwd: 0, side: 0, run: false, lookX: 0, lookY: 0, action: false, actionHeld: false };
}

export function readInput(input: Input, sens: number, out: Intent) {
  const d = input.down;
  out.fwd = (d.has('KeyW') || d.has('ArrowUp') ? 1 : 0) - (d.has('KeyS') || d.has('ArrowDown') ? 1 : 0);
  out.side = (d.has('KeyD') || d.has('ArrowRight') ? 1 : 0) - (d.has('KeyA') || d.has('ArrowLeft') ? 1 : 0);
  out.run = d.has('ShiftLeft') || d.has('ShiftRight');
  out.lookX = input.mouseDX * sens;
  out.lookY = input.mouseDY * sens;
  out.action = input.pressed.has('Space');
  out.actionHeld = d.has('Space');
  return out;
}
