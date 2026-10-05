// Raw input → per-frame deltas for the camera. Mouse, wheel, keys, touch (drag, pinch, double-tap)
// and pointer lock. The camera system reads and then calls endFrame().
//
// Keyboard scope: the window variant only listens while the canvas has focus (so the site's own
// typing and shortcuts keep working); the page variant listens on the window, but never while the
// user types into a field (the command palette opens on /planet too).

import type { Variant } from '../core/contracts';

/** True for text inputs, textareas, selects and contentEditable elements (same rule as the palette's key guard). */
function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** Virtual stick travel (CSS px) for full deflection. */
export const STICK_RADIUS = 46;

/** Where the stick rests (CSS px from the canvas's left / bottom edge): littlebig-canvas.tsx draws it there. */
export const STICK_REST_X = 70;
export const STICK_REST_BOTTOM = 92;
/** A touch in the zone becomes the stick only after this long or this far (ms, px): a pinch lands in time to stay a pinch. */
export const STICK_HOLD_MS = 100;
export const STICK_HOLD_PX = 8;

/**
 * The stick zone: the bottom-left 35 % × 40 % of the canvas, always covering the resting stick
 * (plus a thumb's margin). The centre of the screen always stays look and pinch.
 */
export function inStickZone(x: number, y: number, w: number, h: number): boolean {
  const reach = STICK_RADIUS + 34;
  return x < Math.max(w * 0.35, STICK_REST_X + reach) && y > Math.min(h * 0.6, h - STICK_REST_BOTTOM - reach);
}

/**
 * Thumb offset (CSS px) → stick vector in the unit disc, with a small dead zone and a gentle
 * response curve (fine control near the centre). Writes out.x / out.y.
 */
export function stickVector(dx: number, dy: number, radius: number, out: { x: number; y: number }): void {
  const d = Math.hypot(dx, dy);
  const dead = 0.12;
  const m = Math.min(1, d / radius);
  if (m <= dead || d === 0) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const k = (m - dead) / (1 - dead);
  const mag = k * (0.6 + 0.4 * k);
  out.x = (dx / d) * mag;
  out.y = (dy / d) * mag;
}

export interface PointerPos {
  x: number;
  y: number;
}

export class CameraInput {
  /** Cursor position in CSS px relative to the canvas, and whether it is over the canvas. */
  readonly cursor: PointerPos = { x: 0, y: 0 };
  hover = false;

  /** A single-pointer drag is in progress. */
  dragging = false;
  /** Set on the frame a drag starts / ends. */
  dragStarted = false;
  dragEnded = false;
  /** Drag movement this frame (CSS px). */
  dragDX = 0;
  dragDY = 0;

  /** Pointer-lock look movement this frame (CSS px). */
  lockDX = 0;
  lockDY = 0;
  locked = false;

  /** Wheel delta this frame (px, + = zoom out) and the cursor where it happened. */
  wheel = 0;
  readonly wheelAt: PointerPos = { x: 0, y: 0 };

  /** Pinch zoom factor this frame (>1 = fingers spreading = zoom in) and its centre. */
  pinch = 1;
  readonly pinchAt: PointerPos = { x: 0, y: 0 };
  pinching = false;

  /** A double click / double tap happened this frame, at this position. */
  doubleClick = false;
  readonly doubleAt: PointerPos = { x: 0, y: 0 };

  /** A plain click (press + release without dragging) happened this frame. */
  click = false;

  /** performance.now() of the last user input (hint row). */
  lastInput = 0;

  /** A touch pointer has been seen (touch UI and hints). */
  touchSeen = false;
  /** The last plain click came from a mouse (pointer lock is mouse-only). */
  clickMouse = false;
  /**
   * The left-thumb virtual stick (touch, street level). The camera sets `enabled` each frame; a
   * touch that starts in the stick zone while enabled drives it instead of looking around.
   * x, y: −1…1 (y + = down = walk backwards), ox, oy: where the thumb went down (CSS px).
   */
  readonly stick = { enabled: false, active: false, x: 0, y: 0, ox: 0, oy: 0, id: -1 };
  /**
   * A touch that went down in the stick zone but is not the stick yet: it becomes the stick after
   * STICK_HOLD_MS or STICK_HOLD_PX of travel; a second finger landing first turns both into a pinch;
   * lifting it first is a tap.
   */
  private pend = { id: -1, x: 0, y: 0, cx: 0, cy: 0, t: 0 };

  private readonly keys = new Set<string>();
  /** Keys that went down since the last frame (a tap shorter than a frame still counts). */
  private readonly downs = new Set<string>();
  private readonly pointers = new Map<number, PointerPos & { type: string }>();
  private pinchDist = 0;
  private downAt: PointerPos & { t: number } = { x: 0, y: 0, t: 0 };
  private moved = 0;
  private lastTap = { x: 0, y: 0, t: -1e9 };
  private readonly off: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly variant: Variant,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window | Document, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    canvas.style.touchAction = 'none';
    // A phone or tablet offers the touch UI before its first touch.
    this.touchSeen = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;

    on(canvas, 'pointerdown', (e: PointerEvent) => this.onDown(e));
    on(canvas, 'pointermove', (e: PointerEvent) => this.onMove(e));
    on(canvas, 'pointerup', (e: PointerEvent) => this.onUp(e));
    on(canvas, 'pointercancel', (e: PointerEvent) => this.onUp(e));
    on(canvas, 'pointerenter', () => (this.hover = true));
    on(canvas, 'pointerleave', () => (this.hover = false));
    on(canvas, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    on(canvas, 'dblclick', (e: MouseEvent) => {
      this.doubleClick = true;
      this.setPos(this.doubleAt, e.clientX, e.clientY);
      this.touch();
    });
    on(canvas, 'contextmenu', (e: Event) => e.preventDefault());
    const keyTarget = variant === 'page' ? window : canvas;
    on(keyTarget, 'keydown', (e: KeyboardEvent) => this.onKey(e, true));
    on(keyTarget, 'keyup', (e: KeyboardEvent) => this.onKey(e, false));
    const drop = () => {
      this.keys.clear();
      this.downs.clear();
    };
    on(window, 'blur', drop);
    // The window variant only hears keys while the canvas has focus, so a key released after
    // focus left it would stay held forever (the planet spinning on its own).
    if (variant === 'window') on(canvas, 'blur', drop);
    // Focus moving into a text field (e.g. the palette opening) drops held keys: no stuck walking.
    on(document, 'focusin', (e: FocusEvent) => {
      if (isEditable(e.target)) this.keys.clear();
    });
    on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    on(document, 'mousemove', (e: MouseEvent) => {
      if (!this.locked) return;
      this.lockDX += e.movementX;
      this.lockDY += e.movementY;
      this.touch();
    });
  }

  /** Dev introspection (player tests). */
  debugState() {
    return { pointers: [...this.pointers.keys()], pend: this.pend.id, pinching: this.pinching, dragging: this.dragging, stick: this.stick.active };
  }

  /** True while a key (KeyboardEvent.code) is held. */
  key(code: string): boolean {
    return this.keys.has(code);
  }

  /** True if the key went down since the last frame (edge-triggered: jumps). */
  pressed(code: string): boolean {
    return this.downs.has(code);
  }

  requestLock() {
    if (this.variant !== 'page' || this.locked) return;
    try {
      const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* not allowed here; ignore */
    }
  }

  releaseLock() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** Canvas size in CSS px. */
  get width() {
    return this.canvas.clientWidth || 1;
  }
  get height() {
    return this.canvas.clientHeight || 1;
  }

  endFrame() {
    this.dragDX = 0;
    this.dragDY = 0;
    this.lockDX = 0;
    this.lockDY = 0;
    this.wheel = 0;
    this.pinch = 1;
    this.doubleClick = false;
    this.click = false;
    this.dragStarted = false;
    this.dragEnded = false;
    this.downs.clear();
  }

  dispose() {
    this.releaseLock();
    for (const f of this.off) f();
    this.off.length = 0;
    this.keys.clear();
    this.pointers.clear();
    this.stick.active = false;
    this.pend.id = -1;
  }

  private touch() {
    this.lastInput = performance.now();
  }

  private setPos(out: PointerPos, cx: number, cy: number) {
    const r = this.canvas.getBoundingClientRect();
    out.x = cx - r.left;
    out.y = cy - r.top;
  }

  private onDown(e: PointerEvent) {
    this.touch();
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.canvas.focus({ preventScroll: true });
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture can fail for synthetic events */
    }
    const p = { x: 0, y: 0, type: e.pointerType };
    this.setPos(p, e.clientX, e.clientY);
    if (e.pointerType === 'touch') this.touchSeen = true;
    if (this.pend.id >= 0) {
      // A second finger while the zone touch is undecided: both are a pinch (or a look + pinch).
      const q = this.pend;
      const id = q.id;
      q.id = -1;
      this.addPointer(id, { x: q.cx, y: q.cy, type: 'touch' });
    } else if (e.pointerType === 'touch' && this.stick.enabled && !this.stick.active && this.pointers.size === 0 && inStickZone(p.x, p.y, this.width, this.height)) {
      const q = this.pend;
      q.id = e.pointerId;
      q.x = q.cx = p.x;
      q.y = q.cy = p.y;
      q.t = performance.now();
      return;
    }
    this.addPointer(e.pointerId, p);
  }

  /** Commit the undecided zone touch as the stick (hold time passed, or it moved). */
  private commitStick() {
    const q = this.pend;
    const st = this.stick;
    st.active = true;
    st.id = q.id;
    st.ox = q.x;
    st.oy = q.y;
    stickVector(q.cx - q.x, q.cy - q.y, STICK_RADIUS, st);
    q.id = -1;
  }

  /** Per frame (before reading): an undecided zone touch held long enough becomes the stick. */
  poll(now = performance.now()) {
    if (this.pend.id >= 0 && now - this.pend.t >= STICK_HOLD_MS) this.commitStick();
    if (this.pend.id >= 0 && !this.stick.enabled) this.pend.id = -1;
  }

  private addPointer(id: number, p: PointerPos & { type: string }) {
    this.pointers.set(id, p);
    this.cursor.x = p.x;
    this.cursor.y = p.y;
    if (this.pointers.size === 1) {
      this.dragging = true;
      this.dragStarted = true;
      this.moved = 0;
      this.downAt = { x: p.x, y: p.y, t: performance.now() };
    } else if (this.pointers.size === 2) {
      // Two fingers: a pinch replaces the drag.
      if (this.dragging) this.dragEnded = true;
      this.dragging = false;
      this.pinching = true;
      this.pinchDist = this.twoFingerDist();
    }
  }

  private onMove(e: PointerEvent) {
    if (this.pend.id >= 0 && e.pointerId === this.pend.id) {
      const q = this.pend;
      const r = this.canvas.getBoundingClientRect();
      q.cx = e.clientX - r.left;
      q.cy = e.clientY - r.top;
      this.touch();
      if (Math.hypot(q.cx - q.x, q.cy - q.y) >= STICK_HOLD_PX) this.commitStick();
      return;
    }
    if (this.stick.active && e.pointerId === this.stick.id) {
      const st = this.stick;
      const r = this.canvas.getBoundingClientRect();
      stickVector(e.clientX - r.left - st.ox, e.clientY - r.top - st.oy, STICK_RADIUS, st);
      this.touch();
      return;
    }
    const p = this.pointers.get(e.pointerId);
    const prevX = p ? p.x : this.cursor.x;
    const prevY = p ? p.y : this.cursor.y;
    this.setPos(this.cursor, e.clientX, e.clientY);
    if (!p) return;
    p.x = this.cursor.x;
    p.y = this.cursor.y;
    this.touch();
    if (this.pinching && this.pointers.size >= 2) {
      const d = this.twoFingerDist();
      if (this.pinchDist > 0 && d > 0) this.pinch *= d / this.pinchDist;
      this.pinchDist = d;
      const it = this.pointers.values();
      const a = it.next().value!;
      const b = it.next().value!;
      this.pinchAt.x = (a.x + b.x) / 2;
      this.pinchAt.y = (a.y + b.y) / 2;
    } else if (this.dragging) {
      this.dragDX += p.x - prevX;
      this.dragDY += p.y - prevY;
      this.moved += Math.abs(p.x - prevX) + Math.abs(p.y - prevY);
    }
  }

  private onUp(e: PointerEvent) {
    if (this.pend.id >= 0 && e.pointerId === this.pend.id) {
      // Lifted before it became the stick: a tap (double-tap flies there).
      const q = this.pend;
      q.id = -1;
      this.touch();
      if (e.type === 'pointerup') this.tap(q.cx, q.cy, 'touch');
      return;
    }
    if (this.stick.active && e.pointerId === this.stick.id) {
      const st = this.stick;
      st.active = false;
      st.id = -1;
      st.x = 0;
      st.y = 0;
      this.touch();
      return;
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    this.touch();
    if (this.pinching) {
      if (this.pointers.size < 2) {
        this.pinching = false;
        // The finger still down carries on as a drag from where it is (no jump, never a click).
        const rest = this.pointers.values().next().value;
        if (rest) {
          this.cursor.x = rest.x;
          this.cursor.y = rest.y;
          this.dragging = true;
          this.dragStarted = true;
          this.moved = 1e9;
        }
      }
      return;
    }
    if (this.dragging && this.pointers.size === 0) {
      this.dragging = false;
      this.dragEnded = true;
      const now = performance.now();
      if (this.moved < 6 && now - this.downAt.t < 350) this.tap(p.x, p.y, p.type);
    }
  }

  /** A press + release without dragging: a click, and on touch maybe the second tap of a double-tap. */
  private tap(x: number, y: number, type: string) {
    const now = performance.now();
    this.click = true;
    this.clickMouse = type === 'mouse';
    // Touch double-tap (mouse gets the native dblclick).
    if (type !== 'mouse') {
      if (now - this.lastTap.t < 320 && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 30) {
        this.doubleClick = true;
        this.doubleAt.x = x;
        this.doubleAt.y = y;
        this.lastTap.t = -1e9;
      } else this.lastTap = { x, y, t: now };
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    this.touch();
    // Zooming in is intent: take keyboard focus (WASD at street level) unless the user is typing.
    if (document.activeElement !== this.canvas && !isEditable(document.activeElement)) this.canvas.focus({ preventScroll: true });
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    // Trackpad pinch arrives as ctrl+wheel with small deltas: amplify it.
    this.wheel += e.deltaY * k * (e.ctrlKey ? 4 : 1);
    this.setPos(this.wheelAt, e.clientX, e.clientY);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    // A release always lands, whatever has focus or which modifiers are held (no stuck keys).
    if (!down) this.keys.delete(e.code);
    if (this.variant === 'window' && document.activeElement !== this.canvas) return;
    // A good guest: typing into the palette (or any field) never moves the camera.
    if (isEditable(e.target) || isEditable(document.activeElement)) return;
    const game = /^(Key[WASDQE]|Arrow(Up|Down|Left|Right)|Space|ShiftLeft|ShiftRight|Equal|Minus|NumpadAdd|NumpadSubtract)$/.test(e.code);
    if (!game) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (down) {
      if (!e.repeat) this.downs.add(e.code);
      this.keys.add(e.code);
    }
    this.touch();
    e.preventDefault();
  }

  private twoFingerDist(): number {
    const it = this.pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}
