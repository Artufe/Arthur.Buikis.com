// "click to follow · bus 7" beside the cursor over anything pickable (a click there rides it: D1).
// Reads the camera's own hover pick when it offers one (CameraService.hover); otherwise picks at
// most 10 times a second itself (ctx.services.track.pick poses every trackable). Only for a mouse
// hovering the canvas with no button held, never while flying the bird.

import type { LBContext, Trackable } from '../core/contracts';
import { KIND_COLOR, KIND_NAME } from './theme';

const PICK_MS = 100;

/** Small inline icons per kind group (the tooltip's badge). */
const DOT_SVG = (path: string) =>
  `<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="display:block"><path d="${path}" fill="#fff" stroke="#1B1530" stroke-width="2" stroke-linejoin="round"/></svg>`;
const GLYPH: Record<string, string> = {
  air: DOT_SVG('M2.6 13.4c0-1.5 1.4-2.3 3-2.3h11.2c3.2 0 5.6 1.1 5.6 2.4s-2.4 2.3-5.6 2.3H5.6c-1.6 0-3-.8-3-2.4zM4.4 11.2 3.2 6h2.9l2.8 5.1zM10 14.6l3.4 6h2.6l-1.4-6'),
  road: DOT_SVG('M2 7.6a2 2 0 0 1 2-2h15.6a2 2 0 0 1 2 2V17H2zM7 19.6a2.2 2.2 0 1 0 0-.1zM16.6 19.6a2.2 2.2 0 1 0 0-.1z'),
  sea: DOT_SVG('M11.4 3v11.4H4.6zM2.4 15.6h19.2l-2.6 4.4H5z'),
  person: DOT_SVG('M4.6 21.4c0-5 3.2-7.2 7.4-7.2s7.4 2.2 7.4 7.2zM12 3.8a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2z'),
  space: DOT_SVG('M1 8.6h5.4v6.8H1zM17.6 8.6H23v6.8h-5.4zM8.4 8.4h7.2v7.2H8.4z'),
};
const GROUP: Record<Trackable['kind'], string> = {
  plane: 'air', balloon: 'air', car: 'road', bus: 'road', truck: 'road', train: 'road', boat: 'sea', ferry: 'sea', person: 'person', satellite: 'space', station: 'space',
};

export class HoverTip {
  private readonly el: HTMLDivElement;
  private readonly dot: HTMLSpanElement;
  private readonly name: HTMLElement;
  private x = 0;
  private y = 0;
  private inside = false;
  private down = false;
  private mouse = false;
  private moved = true;
  private lastPick = -1e9;
  private current: Trackable | null = null;
  private shownLabel = '';
  private ew = 160;
  private on = false;
  private wx = NaN;
  private wy = NaN;
  private readonly off: Array<() => void> = [];

  constructor(
    root: HTMLElement,
    private readonly ctx: LBContext,
  ) {
    const el = document.createElement('div');
    el.className = 'lbh-hover';
    el.setAttribute('aria-hidden', 'true');
    this.dot = document.createElement('span');
    this.dot.className = 'lbh-hdot';
    const txt = document.createElement('span');
    const small = document.createElement('small');
    small.textContent = 'click to follow';
    this.name = document.createElement('b');
    txt.append(small, this.name);
    el.append(this.dot, txt);
    root.appendChild(el);
    this.el = el;
    const canvas = ctx.canvas;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      canvas.addEventListener(type, fn);
      this.off.push(() => canvas.removeEventListener(type, fn));
    };
    on('pointermove', (e) => {
      this.mouse = e.pointerType === 'mouse';
      this.x = e.offsetX;
      this.y = e.offsetY;
      this.inside = true;
      this.moved = true;
    });
    on('pointerleave', () => {
      this.inside = false;
    });
    on('pointerdown', () => {
      this.down = true;
    });
    on('pointerup', () => {
      this.down = false;
    });
    on('pointercancel', () => {
      this.down = false;
    });
  }

  /** Per frame. enabled: not flying the bird; skip: the ridden id (it is not offered). */
  tick(now: number, enabled: boolean, w: number, skip: string | null): void {
    const active = enabled && this.inside && this.mouse && !this.down && document.pointerLockElement !== this.ctx.canvas;
    if (!active) {
      this.current = null;
      this.show(false);
      return;
    }
    // Things move under a still cursor, so re-pick on a clock as well as on movement.
    const camHover = this.ctx.services.camera.hover;
    // (A locked camera — the review hook owns it — does not pick: pick here then.)
    if (camHover && !this.ctx.debug.cameraLocked) {
      // The camera picks for its pointer cursor already (≤ 10 Hz): reuse it.
      const id = camHover.call(this.ctx.services.camera);
      this.current = id ? (this.ctx.services.track.get(id) ?? null) : null;
    } else if (now - this.lastPick >= (this.moved ? PICK_MS : PICK_MS * 2)) {
      this.lastPick = now;
      this.moved = false;
      this.current = this.ctx.services.track.pick(this.x, this.y);
    }
    const t = this.current && this.current.id !== skip ? this.current : null;
    if (!t) {
      this.show(false);
      return;
    }
    if (t.label !== this.shownLabel) {
      this.shownLabel = t.label;
      this.name.textContent = t.label || KIND_NAME[t.kind];
      this.dot.style.setProperty('--kc', KIND_COLOR[t.kind]);
      this.dot.innerHTML = GLYPH[GROUP[t.kind]] ?? '';
      this.ew = this.el.offsetWidth || 160;
    }
    // Beside the cursor; flipped to its left near the right edge.
    const ew = this.ew;
    const x = this.x + 16 + ew > w - 8 ? this.x - 14 - ew : this.x + 16;
    const y = this.y + 18;
    if (x !== this.wx || y !== this.wy) {
      this.wx = x;
      this.wy = y;
      this.el.style.transform = `translate3d(${x}px,${y}px,0)`;
    }
    this.show(true);
  }

  private show(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    if (on) this.el.dataset.on = '';
    else delete this.el.dataset.on;
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
    this.el.remove();
  }
}
