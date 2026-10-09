// World labels: ctx.services.labels drawn as POP tags over the canvas. Imperative DOM driven by
// the HUD's one rAF (no React render per frame): each frame projects every anchor with the
// camera's own matrices, hides it behind the planet, fades it by altitude, keeps it off the thing
// you are following (the plane, the station, the bird stay in full view), declutters, and writes
// only the transforms and opacities that changed.

import type { LBContext, TrackPose, WorldLabel } from '../core/contracts';
import { Declutter, KIND_PRIORITY, altFade, circleHitsBox, limbClearance, mul4, project, screenRadius, type ScreenPoint } from './label-math';
import { WORLD } from './theme';

const SVG_HEAD = '<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="display:block;flex:none">';
const ICONS: Partial<Record<WorldLabel['kind'], string>> = {
  capital: `${SVG_HEAD}<path d="m12 1.8 3 6.4 7 .8-5.2 4.8 1.4 7-6.2-3.5-6.2 3.5 1.4-7L2 9l7-.8z" fill="#1B1530"/></svg>`,
  harbour: `${SVG_HEAD}<g fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><circle cx="12" cy="4.8" r="2.4"/><path d="M12 7.2v14M7.4 11h9.2M3.6 14c.6 4.4 4.2 7 8.4 7s7.8-2.6 8.4-7"/></g></svg>`,
  airport: `${SVG_HEAD}<path d="M21.5 15.5v-2l-8.5-5V3.3a1.5 1.5 0 0 0-3 0v5.2l-8.5 5v2l8.5-2.6v5.4l-2.4 1.8v1.6l3.9-1.1 3.9 1.1v-1.6L13 18.3v-5.4z" fill="currentColor"/></svg>`,
  station: `${SVG_HEAD}<g stroke="#1B1530" stroke-width="2" stroke-linejoin="round"><rect x="1" y="8.6" width="6" height="6.8" fill="#8EC9F0"/><rect x="17" y="8.6" width="6" height="6.8" fill="#8EC9F0"/><rect x="8.4" y="8.4" width="7.2" height="7.2" fill="#fff"/></g></svg>`,
};

/** Anchor point's offset from the tag's top-left: the dot's centre (tail 7 px + dot 9 px). */
const DOT = 4.5;
/** Nearer than this (m), a tag shows its second line ('pop. 640 · harbour'); names only from orbit. */
const FULL_DIST = 170;
/** A moving anchor's tag (the station) sits this far (px) above the top of its model's screen circle. */
const TRACK_GAP = 5;
/** The followed thing's keep-out circle: its bounding radius on screen × this, plus a margin (px). */
const SUBJECT_SCALE = 1; // (0.92 in round 2 let a tag sit on a chased plane's wingtip)
const SUBJECT_PAD = 10;

interface Item {
  label: WorldLabel;
  el: HTMLButtonElement;
  name: HTMLElement;
  sub: HTMLElement;
  text: string;
  subText: string | undefined;
  w: number;
  h: number;
  /** Declutter candidate index this frame (−1 = not a candidate). */
  ci: number;
  /** Visibility before the declutter (altitude × limb). */
  vis: number;
  depth: number;
  x: number;
  y: number;
  shown: boolean;
  /** Showing its second line (close by). */
  full: boolean;
  alpha: number;
  // Last written values.
  wx: number;
  wy: number;
  wa: number;
  on: boolean;
}

export interface LabelLayerOptions {
  reducedMotion: boolean;
  /** A label was activated (click, tap, Enter). */
  onActivate(l: WorldLabel): void;
}

export class LabelLayer {
  private readonly items = new Map<WorldLabel, Item>();
  private readonly list: Item[] = [];
  private version = -1;
  private readonly pv = new Float64Array(16);
  private readonly sp: ScreenPoint = { x: 0, y: 0, w: 0, z: 0 };
  private readonly pose: TrackPose;
  private readonly subj: TrackPose['pos'];
  private readonly dc = new Declutter(5);
  /** Panels the labels keep clear of, CSS px boxes [x0, y0, x1, y1]…; set by the HUD. */
  reserved: number[] = [];
  /** The ridden trackable's id: its own label hides (the card shows it). */
  hideTrack: string | null = null;
  /** Riding or flying the bird: tags keep off the followed thing (camera.subject). */
  following = false;
  private drag: { id: number; x: number; y: number; type: string; item: Item } | null = null;
  private readonly sc = { x: 0, y: 0, r: 0 };
  /** This frame's keep-out circle round the followed thing (CSS px; r = 0: none). Read-only. */
  get subject(): Readonly<{ x: number; y: number; r: number }> {
    return this.sc;
  }
  private dragged = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly ctx: LBContext,
    private readonly opts: LabelLayerOptions,
  ) {
    // Vector3 without importing three into the canvas chunk (the camera's position is one).
    const V = ctx.camera.position.constructor as new () => TrackPose['pos'];
    this.pose = { pos: new V(), fwd: new V(), up: new V(), speed: 0 };
    this.subj = new V();
  }

  /**
   * The followed thing's keep-out circle on screen (x, y, r in CSS px) into `out`; r = 0 if none
   * (exploring, or the eye is inside it: a walker's eyes, a driver's seat).
   */
  private subjectCircle(w: number, h: number, out: { x: number; y: number; r: number }) {
    out.r = 0;
    if (!this.following) return;
    const ctx = this.ctx;
    let rad = ctx.services.camera.subject?.(this.subj) ?? 0;
    if (!(rad > 0) && this.hideTrack) {
      const t = ctx.services.track.get(this.hideTrack);
      if (t && t.pose(ctx, this.pose)) {
        this.subj.copy(this.pose.pos);
        rad = t.radius;
      }
    }
    if (!(rad > 0)) return;
    const s = this.subj;
    const e = ctx.camera.position;
    if (Math.hypot(s.x - e.x, s.y - e.y, s.z - e.z) < rad * 1.6) return;
    const sp = project(this.pv, s.x, s.y, s.z, w, h, this.sp);
    if (sp.w <= 0) return;
    out.x = sp.x;
    out.y = sp.y;
    out.r = screenRadius(rad, sp.w, ctx.camera.projectionMatrix.elements[5], h) * SUBJECT_SCALE + SUBJECT_PAD;
  }

  private sync() {
    const labels = this.ctx.services.labels.list();
    this.version = this.ctx.services.labels.version;
    const keep = new Set(labels);
    for (const [l, it] of this.items) {
      if (keep.has(l)) continue;
      it.el.remove();
      this.items.delete(l);
    }
    for (const l of labels) if (!this.items.has(l)) this.items.set(l, this.create(l));
    this.list.length = 0;
    for (const it of this.items.values()) this.list.push(it);
    // Draw order: the important ones on top.
    this.list.sort((a, b) => (KIND_PRIORITY[a.label.kind] ?? 0) - (KIND_PRIORITY[b.label.kind] ?? 0));
    for (const it of this.list) this.root.appendChild(it.el);
  }

  private create(l: WorldLabel): Item {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'lbh-tag';
    el.dataset.kind = l.kind;
    el.dataset.off = '';
    el.tabIndex = -1;
    if (l.track) el.dataset.track = '';
    const clickable = !!l.track || l.flyAlt !== 0;
    el.disabled = !clickable;
    const box = document.createElement('span');
    box.className = 'lbh-tag-box';
    const icon = ICONS[l.kind];
    if (icon) box.insertAdjacentHTML('afterbegin', icon);
    const txt = document.createElement('span');
    txt.className = 'lbh-tag-txt';
    const name = document.createElement('span');
    name.className = 'lbh-tag-name';
    const sub = document.createElement('span');
    sub.className = 'lbh-tag-sub';
    txt.append(name, sub);
    box.append(txt);
    const tail = document.createElement('span');
    tail.className = 'lbh-tag-tail';
    const dot = document.createElement('span');
    dot.className = 'lbh-tag-dot';
    el.append(box, tail, dot);
    const it: Item = {
      label: l, el, name, sub, text: '', subText: undefined, w: 0, h: 0, ci: -1, vis: 0, depth: 0, x: 0, y: 0, shown: false, full: false, alpha: 0,
      wx: NaN, wy: NaN, wa: -1, on: false,
    };
    this.setText(it);
    this.wire(it);
    return it;
  }

  private setText(it: Item) {
    const l = it.label;
    it.text = l.text;
    it.subText = l.sub;
    it.name.textContent = l.text;
    it.sub.textContent = l.sub ?? '';
    it.sub.style.display = l.sub ? '' : 'none';
    const verb = l.track ? 'ride' : l.flyAlt === 0 ? '' : 'fly to';
    const name = l.sub ? `${l.text}, ${l.sub}` : l.text;
    it.el.setAttribute('aria-label', verb ? `${verb} ${name}` : name);
    it.w = 0; // re-measure
  }

  /** Tap = activate; a drag that starts on a tag hands over to the canvas (spin / look). */
  private wire(it: Item) {
    const el = it.el;
    const canvas = this.ctx.canvas;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.dragged = false;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, item: it };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    el.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
      this.drag = null;
      this.dragged = true;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const init = { pointerId: e.pointerId, pointerType: d.type, isPrimary: true, bubbles: true, cancelable: true, button: 0, buttons: 1 };
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: d.x, clientY: d.y }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: e.clientX, clientY: e.clientY }));
    });
    const end = (e: PointerEvent) => {
      if (this.drag?.id === e.pointerId) this.drag = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('click', (e) => {
      if (this.dragged) {
        this.dragged = false;
        e.preventDefault();
        return;
      }
      this.opts.onActivate(it.label);
    });
    // The wheel zooms the planet even over a tag.
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        canvas.dispatchEvent(new WheelEvent('wheel', e));
      },
      { passive: false },
    );
  }

  /** Per frame. w, h: the layer's size (CSS px); dt: real seconds. */
  update(w: number, h: number, dt: number): void {
    const ctx = this.ctx;
    const svc = ctx.services.labels;
    if (svc.version !== this.version) this.sync();
    const list = this.list;
    if (list.length === 0) return;
    const cam = ctx.camera;
    mul4(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements, this.pv);
    const ex = cam.position.x;
    const ey = cam.position.y;
    const ez = cam.position.z;
    const alt = ctx.view.altTerrain;
    const R = WORLD.R;
    const dc = this.dc;
    const sc = this.sc;
    this.subjectCircle(w, h, sc);
    const p5 = cam.projectionMatrix.elements[5];
    dc.begin();
    const res = this.reserved;
    for (let i = 0; i + 3 < res.length; i += 4) dc.reserve(res[i], res[i + 1], res[i + 2], res[i + 3]);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const l = it.label;
      it.ci = -1;
      it.vis = 0;
      if (l.text !== it.text || l.sub !== it.subText) this.setText(it);
      if (it.w === 0) {
        // Measured once (and after a text change); the tag is laid out even while hidden.
        it.w = it.el.offsetWidth;
        it.h = it.el.offsetHeight;
        if (it.w === 0) continue;
      }
      const a = altFade(alt, l.minAlt, l.maxAlt);
      if (a < 0.01) continue;
      let px: number;
      let py: number;
      let pz: number;
      // A moving anchor's model radius (m): its tag stands above the model on screen, not on it.
      let lift = 0;
      if (l.track) {
        if (l.track === this.hideTrack) continue;
        const t = ctx.services.track.get(l.track);
        if (!t || !t.pose(ctx, this.pose)) continue;
        const p = this.pose;
        px = p.pos.x;
        py = p.pos.y;
        pz = p.pos.z;
        lift = t.radius * 0.75;
      } else {
        const r = R + l.h;
        px = l.dir.x * r;
        py = l.dir.y * r;
        pz = l.dir.z * r;
      }
      const sp = project(this.pv, px, py, pz, w, h, this.sp);
      // Behind the camera: it fades where it was.
      if (sp.w <= 0) continue;
      // Otherwise it follows its anchor even while it fades (sliding behind the limb or off an edge).
      it.x = sp.x;
      it.y = lift > 0 ? sp.y - Math.min(140, screenRadius(lift, sp.w, p5, h)) - TRACK_GAP : sp.y;
      it.depth = sp.z;
      // Close by (the regional view and below), the tag shows its second line too.
      const ddx = px - ex;
      const ddy = py - ey;
      const ddz = pz - ez;
      const full = !!l.sub && ddx * ddx + ddy * ddy + ddz * ddz < FULL_DIST * FULL_DIST;
      if (full !== it.full) {
        it.full = full;
        if (full) it.el.dataset.full = '';
        else delete it.el.dataset.full;
        it.w = it.el.offsetWidth;
        it.h = it.el.offsetHeight;
      }
      if (it.x < -it.w || it.x > w + it.w || it.y < -10 || it.y > h + it.h) continue;
      const clear = limbClearance(ex, ey, ez, px, py, pz, R);
      const limb = Math.min(1, Math.max(0, (clear + 0.5) / 5));
      // Sliding off an edge: fade out rather than show a cut tag.
      const x0 = it.x - it.w / 2;
      const y0 = it.y - it.h + DOT;
      const over = Math.max(0, 4 - x0, x0 + it.w - (w - 4), 4 - y0, y0 + it.h - (h - 4));
      const edge = Math.max(0, 1 - over / 24);
      const vis = a * limb * edge;
      if (vis < 0.02) continue;
      // Never over the plane / station / bird being followed (the user's ask: it stays in view).
      if (sc.r > 0 && circleHitsBox(sc.x, sc.y, sc.r, x0, y0, x0 + it.w, y0 + it.h)) continue;
      it.vis = vis;
      it.ci = dc.add(x0, y0, x0 + it.w, y0 + it.h - DOT * 2, KIND_PRIORITY[l.kind] ?? 0, it.shown, sp.z);
      n++;
    }
    if (n > 0) dc.solve();
    // Fades in over ~0.3 s and out faster; instant in shot mode (deterministic review frames).
    const still = this.opts.reducedMotion || ctx.shotMode;
    const kIn = still ? 1 : Math.min(1, dt * 9);
    const kOut = still ? 1 : Math.min(1, dt * 15);
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const shown = it.ci >= 0 && dc.shown[it.ci] === 1;
      it.shown = shown;
      const target = shown ? it.vis : 0;
      it.alpha += (target - it.alpha) * (target > it.alpha ? kIn : kOut);
      if (target === 0 && (it.alpha < 0.03 || (it.alpha > 0 && this.onPanel(it)))) it.alpha = 0;
      this.write(it);
    }
  }

  /** A tag fading out while its anchor slides under a panel (a fast camera move): gone at once, never drawn over the HUD. */
  private onPanel(it: Item): boolean {
    const x0 = it.x - it.w / 2;
    const y0 = it.y - it.h + DOT;
    const x1 = x0 + it.w;
    const y1 = y0 + it.h;
    const r = this.reserved;
    for (let i = 0; i + 3 < r.length; i += 4) if (x0 < r[i + 2] && x1 > r[i] && y0 < r[i + 3] && y1 > r[i + 1]) return true;
    return false;
  }

  private write(it: Item) {
    const el = it.el;
    const a = it.alpha;
    const on = a > 0.001;
    if (on !== it.on) {
      it.on = on;
      el.style.visibility = on ? 'visible' : 'hidden';
    }
    if (!on) return;
    const interactive = a > 0.5;
    if (interactive !== !('off' in el.dataset)) {
      if (interactive) delete el.dataset.off;
      else el.dataset.off = '';
      el.tabIndex = interactive && !el.disabled ? 0 : -1;
    }
    // A small pop as it appears (not under reduced motion).
    const s = this.opts.reducedMotion ? 1 : 0.82 + 0.18 * Math.min(1, a * 1.25);
    const x = it.x - it.w / 2;
    const y = it.y - it.h + DOT;
    if (Math.abs(x - it.wx) > 0.1 || Math.abs(y - it.wy) > 0.1 || Math.abs(a - it.wa) > 0.004) {
      it.wx = x;
      it.wy = y;
      el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${s.toFixed(3)})`;
    }
    if (Math.abs(a - it.wa) > 0.004) {
      it.wa = a;
      el.style.opacity = a.toFixed(3);
    }
  }

  /** The tags' sizes changed (touch, compact): measure them again on the next update. */
  remeasure(): void {
    for (const it of this.list) it.w = 0;
  }

  dispose(): void {
    for (const it of this.items.values()) it.el.remove();
    this.items.clear();
    this.list.length = 0;
  }
}
