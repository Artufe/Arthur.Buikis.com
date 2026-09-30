// Keyboard and mouse state, polled by systems each frame. Mouse deltas accumulate between
// frames and are consumed with takeMouse(). Pointer lock is requested by the canvas on click.

export class Input {
  /** Keyed by KeyboardEvent.code ('KeyW', 'Space', 'ShiftLeft', ...). */
  readonly down = new Set<string>();
  /** Codes pressed since the last endFrame(). */
  readonly pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  buttons = 0;
  wheel = 0;
  locked = false;
  private readonly target: HTMLElement;
  private readonly off: Array<() => void> = [];

  constructor(target: HTMLElement) {
    this.target = target;
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      window.addEventListener(type, fn as EventListener);
      this.off.push(() => window.removeEventListener(type, fn as EventListener));
    };
    on('keydown', (e) => {
      if (!this.active()) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    on('keyup', (e) => this.down.delete(e.code));
    on('blur', () => {
      this.down.clear();
      this.buttons = 0;
    });
    on('mousemove', (e) => {
      if (!this.locked && !(this.buttons & 1)) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    on('mouseup', (e) => {
      this.buttons &= ~(1 << e.button);
    });
    const onDown = (e: MouseEvent) => {
      this.buttons |= 1 << e.button;
    };
    const onWheel = (e: WheelEvent) => {
      if (this.locked) e.preventDefault();
      this.wheel += e.deltaY;
    };
    const onContext = (e: Event) => e.preventDefault();
    target.addEventListener('mousedown', onDown);
    target.addEventListener('wheel', onWheel, { passive: false });
    target.addEventListener('contextmenu', onContext);
    this.off.push(() => {
      target.removeEventListener('mousedown', onDown);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('contextmenu', onContext);
    });
    const onLock = () => {
      this.locked = document.pointerLockElement === target;
    };
    document.addEventListener('pointerlockchange', onLock);
    this.off.push(() => document.removeEventListener('pointerlockchange', onLock));
  }

  /** Keys only count while the game has focus (locked, or the pointer is over the canvas). */
  private active() {
    return this.locked || this.target.matches(':hover');
  }

  requestLock() {
    if (this.locked) return;
    const p = this.target.requestPointerLock?.();
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
  }

  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }

  dispose() {
    for (const f of this.off) f();
    if (this.locked) document.exitPointerLock();
  }
}
