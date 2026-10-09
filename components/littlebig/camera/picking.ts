// Pointer selection and hover hysteresis. Independent of camera mode transitions.
import { Vector3 } from 'three';
import type { CameraMode, LBContext, TrackPose, Trackable } from '../core/contracts';
import type { CameraInput } from './input';
const DEG = Math.PI / 180;
const HOVER_DT = 0.1;
function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
export function createPicking() {
  let hoverT = 0;
  let hoverId: string | null = null;
  let cursorSet = '';
  /** The pick disc's minimum (CSS px): wider up high, where everything that moves is small and fast. */
  function pickPx(ctx: LBContext): number {
    return 14 + 8 * smoothstep(30, 60, ctx.view.altTerrain);
  }

  function pickAt(ctx: LBContext, x: number, y: number): Trackable | null {
    return ctx.services.track?.pick(x, y, pickPx(ctx)) ?? null;
  }

  /**
   * True while canvas point (x, y) is within k× trackable `id`'s pick disc (zero-alloc): 2× by
   * default, 4× for something in the air or in space seen from high up (it drifts across the view).
   */
  function nearHovered(ctx: LBContext, id: string, x: number, y: number, k = 0): boolean {
    const t = ctx.services.track?.get(id);
    if (!t || !t.pose(ctx, hp)) return false;
    // (Someone's eyes are their anchor: the body's middle is lower.)
    if (t.view === 'eyes') hp.pos.addScaledVector(hp.up, -t.radius * 0.75);
    const cam = ctx.camera;
    const dist = cam.position.distanceTo(hp.pos);
    hpS.copy(hp.pos).project(cam);
    if (!(hpS.z < 1) || dist < 0.3) return false;
    const W = ctx.canvas.clientWidth || 1;
    const H = ctx.canvas.clientHeight || 1;
    const sx = ((hpS.x + 1) / 2) * W;
    const sy = ((1 - hpS.y) / 2) * H;
    const pxWorld = (2 * Math.tan((cam.fov * DEG) / 2)) / H;
    const rPx = Math.max((t.view === 'eyes' ? t.radius * 1.1 : t.radius) / (pxWorld * dist), t.kind === 'person' ? 18 : pickPx(ctx));
    const air = t.kind === 'plane' || t.kind === 'balloon' || t.kind === 'satellite' || t.kind === 'station';
    const f = k > 0 ? k : air && ctx.view.altTerrain > 60 ? 4 : 2;
    return Math.hypot(x - sx, y - sy) <= f * rPx;
  }
  let lastHoverId: string | null = null;
  let lastHoverAge = 99;
  const hp: TrackPose = { pos: new Vector3(), fwd: new Vector3(0, 1, 0), up: new Vector3(0, 0, 1), speed: 0 };
  const hpS = new Vector3();

  /** ≤ 10 Hz: what is under the cursor (pointer cursor, the UI's hover label). */
  function hover(ctx: LBContext, inp: CameraInput, dt: number, mode: CameraMode, rideId: string | null) {
    hoverT -= dt;
    const canPick = mode !== 'bird' && inp.hover && !inp.dragging && !inp.locked && !inp.pinching;
    if (!canPick) {
      if (hoverId !== null) hoverId = null;
      if (cursorSet && !inp.dragging) ctx.canvas.style.cursor = cursorSet = '';
      return;
    }
    lastHoverAge += dt;
    if (hoverT > 0) return;
    hoverT = HOVER_DT;
    // (Sticky: kept while the cursor stays within 2× of the hovered thing's disc, 3× up high.)
    if (!hoverId || !nearHovered(ctx, hoverId, inp.cursor.x, inp.cursor.y)) {
      const hit = pickAt(ctx, inp.cursor.x, inp.cursor.y);
      hoverId = hit && hit.id !== rideId ? hit.id : null;
    }
    if (hoverId) {
      lastHoverId = hoverId;
      lastHoverAge = 0;
    }
    const want = hoverId ? 'pointer' : '';
    if (want !== cursorSet) ctx.canvas.style.cursor = cursorSet = want;
  }

  function clear(ctx: LBContext) {
    if (cursorSet) ctx.canvas.style.cursor = cursorSet = '';
  }
  function click(ctx: LBContext, x: number, y: number): Trackable | null {
    const held = hoverId && nearHovered(ctx, hoverId, x, y) ? ctx.services.track.get(hoverId) : undefined;
    let hit = held ?? pickAt(ctx, x, y);
    if (!hit && lastHoverId && lastHoverAge < 1.5 && nearHovered(ctx, lastHoverId, x, y, 5)) hit = ctx.services.track.get(lastHoverId) ?? null;
    return hit;
  }
  return { pickAt, click, hover, clear, get id() { return hoverId; } };
}
