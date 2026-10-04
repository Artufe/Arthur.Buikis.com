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

  private readonly keys = new Set<string>();
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
    on(window, 'blur', () => this.keys.clear());
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

  /** True while a key (KeyboardEvent.code) is held. */
  key(code: string): boolean {
    return this.keys.has(code);
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
  }

  dispose() {
    this.releaseLock();
    for (const f of this.off) f();
    this.off.length = 0;
    this.keys.clear();
    this.pointers.clear();
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
    this.pointers.set(e.pointerId, p);
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
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    this.touch();
    if (this.pinching) {
      if (this.pointers.size < 2) this.pinching = false;
      return;
    }
    if (this.dragging && this.pointers.size === 0) {
      this.dragging = false;
      this.dragEnded = true;
      const now = performance.now();
      if (this.moved < 6 && now - this.downAt.t < 350) {
        this.click = true;
        // Touch double-tap (mouse gets the native dblclick).
        if (p.type !== 'mouse') {
          if (now - this.lastTap.t < 320 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30) {
            this.doubleClick = true;
            this.doubleAt.x = p.x;
            this.doubleAt.y = p.y;
            this.lastTap.t = -1e9;
          } else this.lastTap = { x: p.x, y: p.y, t: now };
        }
      }
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    this.touch();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    // Trackpad pinch arrives as ctrl+wheel with small deltas: amplify it.
    this.wheel += e.deltaY * k * (e.ctrlKey ? 4 : 1);
    this.setPos(this.wheelAt, e.clientX, e.clientY);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (this.variant === 'window' && document.activeElement !== this.canvas) return;
    // A good guest: typing into the palette (or any field) never moves the camera or loses keys.
    if (isEditable(e.target) || isEditable(document.activeElement)) {
      if (!down) this.keys.delete(e.code);
      return;
    }
    const game = /^(Key[WASDQE]|Arrow(Up|Down|Left|Right)|Space|ShiftLeft|ShiftRight|Equal|Minus|NumpadAdd|NumpadSubtract)$/.test(e.code);
    if (!game) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
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
