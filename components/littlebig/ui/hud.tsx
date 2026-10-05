'use client';

// The POP HUD over the LITTLEBIG canvas: the mode dock, the follow card, world labels, the hover
// tip, the time button, the hint row and a one-time coach mark. One rAF drives everything that
// moves (labels, the hover tip, the time warp, the camera's mode); React re-renders only when
// something it shows changes (at most 4 times a second for the card's live line).
//
// It codes against the v2 contracts only (core/contracts.ts): the camera's optional mode / ride /
// cycle / fly / exitMode, ctx.services.track and ctx.services.labels. Whatever is missing degrades:
// a mode with nothing to ride is a disabled button, no labels means no tags.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraMode, LBContext, TrackKind, TrackPose, Trackable, Variant, WorldLabel } from '../core/contracts';
import type { Engine } from '../core/engine';
import type { NumberParam } from '../core/params';
import { FollowCard, type CardInfo } from './card';
import { Coach, Hint, Note } from './coach';
import { Dock } from './dock';
import { HoverTip } from './hover';
import { circleHitsBox, framedFlyTarget } from './label-math';
import { LabelLayer } from './labels';
import { MODES, activeMode, rideCandidates, type ModeId } from './modes';
import { HUD_CSS } from './styles';
import { nextTimeTarget, warpRate } from './sun-time';
import { WORLD } from './theme';
import { TimeButton, type TimeState } from './time';

// Hint lines (the v1 row, plus one per ride view). *key* is drawn as a keycap chip.
const HINT_ORBIT = '*drag* to spin · *scroll* to dive · *double-click* to fly';
const HINT_ORBIT_TOUCH = '*drag* to spin · *pinch* to dive · *double-tap* to fly';
const HINT_STREET = '*wasd* walk · *drag* to look · *space* jump · *scroll* out to fly';
const HINT_STREET_PAGE = '*wasd* walk · *click* to look · *space* jump · *scroll* out to fly';
const HINT_STREET_TOUCH = '*left thumb* walks · *drag* to look · *pinch* out to fly';
const HINT_SEA = '*scroll* out to fly · *double-click* land to fly there';
const HINT_SEA_TOUCH = '*pinch* out to fly · *double-tap* land to fly there';
const HINT_BIRD = '*wasd* steer · *space* flap · *shift* dive · *esc* to land';
const HINT_BIRD_TOUCH = '*left thumb* steers · *tap* to flap · *×* to land';
const HINT_CHASE = '*drag* to look around · *scroll* to zoom · *[* *]* next · *esc* to hop off';
const HINT_EYES = '*drag* to look around · *[* *]* next · *esc* to step out';
const HINT_SPACE = '*drag* to orbit · *scroll* to zoom · *[* *]* next · *esc* to come home';
const HINT_RIDE_TOUCH = '*drag* to look · *pinch* to zoom · *×* to hop off';
const HINT_EYES_TOUCH = '*drag* to look around · *×* to step out';
const HINT_IDLE = 2000;
const HINT_REPEAT_IDLE = 9000;
/** After a mode change, its hint shows this soon (ms). */
const HINT_MODE_DELAY = 900;

const COACH_KEY = 'littlebig.coach.v2';
const COACH_DELAY = 2600;
const COACH_MAX = 14000;
const RIDE_KINDS: readonly TrackKind[] = ['plane', 'balloon', 'car', 'bus', 'truck', 'train', 'boat', 'ferry', 'person'];

const NO_AVAIL: Record<ModeId, boolean> = { explore: true, bird: false, plane: false, drive: false, space: false, people: false };

const AIR: ReadonlySet<TrackKind> = new Set(['plane', 'balloon', 'satellite', 'station']);

function readFlag(name: string): boolean {
  try {
    return new URLSearchParams(window.location.search).has(name);
  } catch {
    return false;
  }
}

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, v: string) {
  try {
    window.localStorage.setItem(key, v);
  } catch {
    /* private mode: the coach may show again; harmless */
  }
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** The card's live line when the trackable has no detail(): speed, and height for things that fly. */
function fallbackDetail(kind: TrackKind, pose: TrackPose): string {
  const kmh = Math.round(pose.speed * 3.6);
  if (AIR.has(kind)) return `alt ${Math.round(pose.pos.length() - WORLD.R)} m · ${kmh} km/h`;
  return kind === 'person' ? (kmh < 1 ? 'standing about' : `strolling · ${kmh} km/h`) : `${kmh} km/h`;
}

function modeOf(kind: TrackKind) {
  return MODES.find((m) => m.kinds.includes(kind));
}

/** Every trackable of the mode the kind belongs to, mode kinds in order (station, then satellites). */
function groupOf(ctx: LBContext, kind: TrackKind): Trackable[] {
  const out: Trackable[] = [];
  for (const k of modeOf(kind)?.kinds ?? [kind]) out.push(...ctx.services.track.list(k));
  return out;
}

/** A mode that rides several kinds (space: the station and the satellites): prev / next is the HUD's. */
function multiKind(kind: TrackKind): boolean {
  return (modeOf(kind)?.kinds.length ?? 1) > 1;
}

interface Live {
  mode: CameraMode;
  ride: string | null;
  modeAt: number;
  trackVer: number;
  methods: string;
  availSig: string;
  cardSig: string;
  hintText: string;
  hintOn: boolean;
  hintShown: string;
  hintSince: number;
  timeSig: string;
  touch: boolean;
  stick: boolean;
  warp: { t0: number; target: number; to: 'evening' | 'morning'; start: number; base: number; max: number; uiAt: number } | null;
  coachShownAt: number;
  coachDone: boolean;
  noteTimer: number;
  lastCard: CardInfo | null;
  leaveTimer: number;
  /** The hint went to the bottom left for this ride (the chased thing sits under the card's corner). */
  hintLow: boolean;
  /** A mode asked for while nothing was ridable: retried as the camera dives in. */
  pending: { id: ModeId; since: number; until: number } | null;
  eye: { x: number; y: number; z: number; at: number };
  speed: number;
}

export function Hud({ engine, variant, shotHud }: { engine: Engine; variant: Variant; shotHud: boolean }) {
  const ctx: LBContext = engine.ctx;
  const rootRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<{ mode: CameraMode; ride: string | null; kind?: TrackKind }>({ mode: 'explore', ride: null });
  const [avail, setAvail] = useState<Record<ModeId, boolean>>(NO_AVAIL);
  const [card, setCard] = useState<CardInfo | null>(null);
  // The last card, kept for its exit animation after the ride ends.
  const [leaving, setLeaving] = useState<CardInfo | null>(null);
  const [hint, setHint] = useState<{ text: string; on: boolean }>({ text: HINT_ORBIT, on: false });
  const [time, setTime] = useState<TimeState>({ to: 'evening', progress: null, disabled: false });
  const [coach, setCoach] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [touch, setTouch] = useState(false);
  const poseRef = useRef<TrackPose | null>(null);
  const live = useRef<Live>({
    mode: 'explore',
    ride: null,
    modeAt: 0,
    trackVer: -1,
    methods: '',
    availSig: '',
    cardSig: '',
    hintText: '',
    hintOn: false,
    hintShown: '',
    hintSince: performance.now(),
    timeSig: '',
    touch: false,
    stick: false,
    warp: null,
    coachShownAt: 0,
    coachDone: false,
    noteTimer: 0,
    lastCard: null,
    leaveTimer: 0,
    pending: null,
    hintLow: false,
    eye: { x: 0, y: 0, z: 0, at: 0 },
    speed: 0,
  });

  // A pose scratch object (Vector3s without importing three: the camera's position is one).
  if (!poseRef.current) {
    const V = ctx.camera.position.constructor as new () => TrackPose['pos'];
    poseRef.current = { pos: new V(), fwd: new V(), up: new V(), speed: 0 };
  }

  const flash = useCallback((text: string) => {
    const L = live.current;
    window.clearTimeout(L.noteTimer);
    setNote(text);
    L.noteTimer = window.setTimeout(() => setNote(null), 2600);
  }, []);

  const finishCoach = useCallback(() => {
    const L = live.current;
    if (L.coachDone) return;
    L.coachDone = true;
    storageSet(COACH_KEY, '1');
    setCoach(false);
  }, []);

  /** Back to the canvas after a mouse press on the HUD, so its keys keep working. */
  const refocus = useCallback(
    (viaPointer: boolean) => {
      if (viaPointer) ctx.canvas.focus({ preventScroll: true });
    },
    [ctx],
  );

  /** Ride the best candidate of a mode (shownOnly: only things drawn right now). */
  const tryRide = useCallback(
    (def: (typeof MODES)[number], shownOnly: boolean): boolean => {
      const camSvc = ctx.services.camera;
      if (!camSvc.ride) return false;
      const cands = rideCandidates(ctx, def, poseRef.current!, live.current.ride, shownOnly);
      for (let i = 0; i < cands.length && i < 60; i++) {
        if (camSvc.ride(cands[i].id)) {
          live.current.pending = null;
          finishCoach();
          return true;
        }
      }
      return false;
    },
    [ctx, finishCoach],
  );

  /**
   * Prev / next (card arrows, [ ] keys, the mode pressed again). A mode of one kind (people) is the
   * camera's own cycle (D1). A mode of several kinds steps through all of them in one fixed ring —
   * the station, then each satellite; planes, then balloons — so prev always undoes next.
   */
  const cycle = useCallback(
    (dir: 1 | -1) => {
      const camSvc = ctx.services.camera;
      const cur = live.current.ride ? ctx.services.track.get(live.current.ride) : undefined;
      if (!cur) return;
      if (!multiKind(cur.kind)) {
        camSvc.cycle?.(dir);
        return;
      }
      const group = groupOf(ctx, cur.kind);
      const n = group.length;
      const i = group.indexOf(cur);
      const pose = poseRef.current!;
      for (let k = 1; k < n; k++) {
        const t = group[(((i + dir * k) % n) + n) % n];
        // Only what is drawn can be ridden (cheap check first, like the camera's own cycle).
        if (t !== cur && t.pose(ctx, pose) && camSvc.ride?.(t.id)) return;
      }
    },
    [ctx],
  );

  const pickMode = useCallback(
    (id: ModeId, viaPointer: boolean) => {
      const camSvc = ctx.services.camera;
      const L = live.current;
      const def = MODES.find((m) => m.id === id)!;
      refocus(viaPointer);
      if (id === 'explore') {
        if (L.mode !== 'explore') camSvc.exitMode?.();
        return;
      }
      if (id === 'bird') {
        if (L.mode !== 'bird') camSvc.fly?.();
        return;
      }
      if (!camSvc.ride) return;
      const curKind = L.ride ? ctx.services.track.get(L.ride)?.kind : undefined;
      if (L.mode === 'ride' && curKind && def.kinds.includes(curKind)) {
        // Pressed again: the next one (of the kind, or of the mode once the kind runs out).
        cycle(1);
        return;
      }
      if (tryRide(def, false)) return;
      // Walkers (and maybe cars) are only drawn near the ground, and the camera rides only what is
      // drawn: dive into town first, then hop on (the rAF's slow tick retries as they appear).
      if (id === 'people' || id === 'drive') {
        if (L.mode !== 'explore') camSvc.exitMode?.();
        camSvc.flyTo(ctx.world.planet.cityDir, id === 'people' ? 12 : 34);
        L.pending = { id, since: performance.now(), until: performance.now() + 9000 };
        flash(id === 'people' ? 'diving into town to find someone…' : 'diving into town to catch a ride…');
        return;
      }
      flash(`no ${def.label}s in sight right now`);
    },
    [ctx, cycle, flash, refocus, tryRide],
  );

  const exitRide = useCallback(() => {
    ctx.services.camera.exitMode?.();
    ctx.canvas.focus({ preventScroll: true });
  }, [ctx]);

  const cycleFromCard = useCallback(
    (dir: 1 | -1, viaPointer: boolean) => {
      refocus(viaPointer);
      cycle(dir);
    },
    [cycle, refocus],
  );

  const activateLabel = useCallback(
    (l: WorldLabel) => {
      const camSvc = ctx.services.camera;
      if (l.track) {
        if (camSvc.ride?.(l.track)) finishCoach();
        return;
      }
      if (l.flyAlt === 0) return;
      const alt = l.flyAlt ?? 60;
      const v = ctx.view;
      // Aim short of the place so it lands mid-view with its tag (label-math framedFlyTarget).
      const to = framedFlyTarget(v.focus, v.heading, l.dir, alt, WORLD.R + Math.max(0, l.h), { x: 0, y: 0, z: 0 });
      if (live.current.mode !== 'explore') camSvc.exitMode?.();
      camSvc.flyTo(to, alt);
    },
    [ctx, finishCoach],
  );

  // ── time warp ──
  const pressTime = useCallback(
    (viaPointer: boolean) => {
      refocus(viaPointer);
      const L = live.current;
      const p = ctx.params.get('core.timeScale') as NumberParam | undefined;
      if (!p || p.kind !== 'number' || ctx.time.frozen) return;
      if (L.warp) {
        // Stop: brake over the last ~2 s of sim instead of halting dead.
        L.warp.target = Math.min(L.warp.target, ctx.time.t + 2);
        return;
      }
      const tgt = nextTimeTarget(ctx.time.t, ctx.view.lat, ctx.view.lon);
      L.warp = { t0: ctx.time.t, target: tgt.t, to: tgt.to, start: performance.now(), base: p.value || 1, max: Math.max(1, p.max), uiAt: 0 };
      setTime({ to: tgt.to, progress: 0, disabled: false });
    },
    [ctx, refocus],
  );

  // ── the one rAF ──
  useEffect(() => {
    const root = rootRef.current;
    const layer = labelsRef.current;
    if (!root || !layer) return;
    const L = live.current;
    const pose = poseRef.current!;
    const labels = new LabelLayer(layer, ctx, { reducedMotion: ctx.reducedMotion, onActivate: (l) => activateLabel(l) });
    const hover = new HoverTip(root, ctx);
    let engineReady = false;
    let readyAt = 0;
    let slowAt = 0;
    void engine.ready.then(() => {
      engineReady = true;
      readyAt = performance.now();
      slowAt = 0; // the dock's availability at once, not on the next slow tick
    });
    if (storageGet(COACH_KEY) === '1' && !readFlag('coach')) L.coachDone = true;
    let W = root.clientWidth;
    let H = root.clientHeight;
    const layout = () => {
      W = root.clientWidth;
      H = root.clientHeight;
      const compact = variant === 'window' || W < 720 || H < 540;
      const narrow = W < 460;
      root.toggleAttribute('data-compact', compact);
      root.toggleAttribute('data-narrow', narrow);
      // Landscape: the planet fills the height and leaves the sides empty, so the dock stands up on
      // the right (a rail) and the hint sits bottom left. Portrait: the dock lies along the bottom,
      // under the planet. Either way it never covers the planet or a chased plane.
      root.toggleAttribute('data-rail', !narrow && W >= H * 1.05);
      root.toggleAttribute('data-short', H < 470);
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(root);
    const reserved: number[] = [];
    let cardBottom = -1;
    // The panels labels keep clear of (the page's back link lives outside the HUD root).
    const panels = ['.lbh-dock', '.lbh-card', '.lbh-time', '.lbh-coach', '.lbh-hint:not([data-off])'];
    const measure = () => {
      const rb = root.getBoundingClientRect();
      reserved.length = 0;
      const add = (el: Element | null) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0) reserved.push(r.left - rb.left, r.top - rb.top, r.right - rb.left, r.bottom - rb.top);
      };
      for (const sel of panels) add(root.querySelector(sel));
      if (variant === 'page') add(document.querySelector('a.lb-back'));
      labels.reserved = reserved;
      // Riding (landscape): the hint tucks under the card, clear of the chased thing (layout box,
      // not the pop-in transform).
      const card = root.querySelector<HTMLElement>('.lbh-card:not([data-out])');
      const cb = card ? Math.round(card.offsetTop + card.offsetHeight) : 0;
      if (cb !== cardBottom) {
        cardBottom = cb;
        root.style.setProperty('--lbh-cb', `${cb}px`);
      }
    };

    const endWarp = () => {
      const w = L.warp;
      if (!w) return;
      const p = ctx.params.get('core.timeScale') as NumberParam | undefined;
      if (p) p.value = w.base;
      L.warp = null;
      L.timeSig = '';
    };
    const stepWarp = (now: number) => {
      const w = L.warp;
      if (!w) return;
      const p = ctx.params.get('core.timeScale') as NumberParam | undefined;
      const rem = w.target - ctx.time.t;
      if (!p || rem <= 0 || ctx.time.frozen) {
        endWarp();
        return;
      }
      // Written straight to the param (the engine reads .value each frame; no change listeners).
      p.value = w.base * warpRate((now - w.start) / 1000, rem, w.max);
      if (now - w.uiAt > 100) {
        w.uiAt = now;
        const prog = Math.min(1, Math.max(0, (ctx.time.t - w.t0) / Math.max(1e-6, w.target - w.t0)));
        setTime({ to: w.to, progress: prog, disabled: false });
      }
    };

    const slow = (now: number) => {
      measure();
      const camSvc = ctx.services.camera;
      const track = ctx.services.track;
      const v = ctx.view;
      // Touch and the street stick.
      const st = camSvc.stick?.();
      const isTouch = st?.touch ?? false;
      if (isTouch !== L.touch) {
        L.touch = isTouch;
        root.toggleAttribute('data-touch', isTouch);
        setTouch(isTouch);
      }
      const stick = !!st?.visible;
      if (stick !== L.stick) {
        L.stick = stick;
        root.toggleAttribute('data-stick', stick);
      }
      // What the dock can offer.
      const methods = `${camSvc.ride ? 'r' : ''}${camSvc.fly ? 'f' : ''}${camSvc.cycle ? 'c' : ''}${camSvc.exitMode ? 'x' : ''}`;
      if (track.version !== L.trackVer || methods !== L.methods) {
        L.trackVer = track.version;
        L.methods = methods;
        const a: Record<ModeId, boolean> = { ...NO_AVAIL };
        a.bird = !!camSvc.fly;
        for (const m of MODES) if (m.kinds.length) a[m.id] = !!camSvc.ride && m.kinds.some((k) => track.list(k).length > 0);
        const sig = JSON.stringify(a);
        if (sig !== L.availSig) {
          L.availSig = sig;
          setAvail(a);
        }
      }
      // The follow card.
      let info: CardInfo | null = null;
      if (L.mode === 'ride' && L.ride) {
        const t = track.get(L.ride);
        if (t) {
          let detail = '';
          try {
            detail = t.detail?.(ctx) ?? (t.pose(ctx, pose) ? fallbackDetail(t.kind, pose) : '');
          } catch {
            detail = '';
          }
          info = {
            key: t.id,
            kind: t.kind,
            title: t.label || t.id,
            sub: t.sub,
            detail: detail || 'on the move',
            canCycle: multiKind(t.kind) ? groupOf(ctx, t.kind).length > 1 : track.list(t.kind).length > 1 && !!camSvc.cycle,
          };
        }
      } else if (L.mode === 'bird') {
        const e = ctx.camera.position;
        const dtS = (now - L.eye.at) / 1000;
        if (L.eye.at > 0 && dtS > 0 && dtS < 1) {
          const d = Math.hypot(e.x - L.eye.x, e.y - L.eye.y, e.z - L.eye.z);
          L.speed += (d / dtS - L.speed) * 0.5;
        }
        L.eye.x = e.x;
        L.eye.y = e.y;
        L.eye.z = e.z;
        L.eye.at = now;
        info = {
          key: 'bird',
          kind: 'bird',
          title: 'you, a little bird',
          sub: 'free as a bird · flap to climb',
          detail: `alt ${Math.max(0, Math.round(v.altSea))} m · ${Math.round(L.speed * 3.6)} km/h`,
          canCycle: false,
        };
      }
      const cardSig = info ? `${info.key}|${info.title}|${info.sub}|${info.detail}|${info.canCycle}` : '';
      if (cardSig !== L.cardSig) {
        if (!info && L.lastCard && !ctx.reducedMotion) {
          setLeaving(L.lastCard);
          window.clearTimeout(L.leaveTimer);
          L.leaveTimer = window.setTimeout(() => setLeaving(null), 240);
        }
        if (info) setLeaving(null);
        L.cardSig = cardSig;
        L.lastCard = info;
        setCard(info);
      }
      // The hint row.
      const kind = L.ride ? track.get(L.ride) : undefined;
      let text: string;
      if (L.mode === 'bird') text = isTouch ? HINT_BIRD_TOUCH : HINT_BIRD;
      else if (L.mode === 'ride') {
        const eyes = kind?.view === 'eyes';
        text = isTouch ? (eyes ? HINT_EYES_TOUCH : HINT_RIDE_TOUCH) : eyes ? HINT_EYES : kind?.view === 'alongside' ? HINT_SPACE : HINT_CHASE;
      }
      else {
        const sea = !v.street && v.alt < 14 && ctx.world.planet.heightAt(v.focus) < -0.3;
        text = v.street
          ? isTouch
            ? HINT_STREET_TOUCH
            : variant === 'page'
              ? HINT_STREET_PAGE
              : HINT_STREET
          : sea
            ? isTouch
              ? HINT_SEA_TOUCH
              : HINT_SEA
            : isTouch
              ? HINT_ORBIT_TOUCH
              : HINT_ORBIT;
      }
      // The coach mark is about to pop for a first-time visitor: the hint waits for it (no flash of
      // the hint under the arriving bubble).
      const coachSoon = !L.coachDone && L.coachShownAt === 0 && (!engineReady || now - readyAt < COACH_DELAY + 500);
      let on: boolean;
      if (ctx.shotMode) on = true;
      else if (coachSoon) on = false;
      else {
        const idle = now - Math.max(L.hintSince, camSvc.lastInputAt());
        const fresh = now - L.modeAt < 6000 && L.modeAt > 0;
        on = fresh ? now - L.modeAt > HINT_MODE_DELAY && idle > 400 : idle > (text === L.hintShown && !L.hintOn ? HINT_REPEAT_IDLE : HINT_IDLE);
        if (on) L.hintShown = text;
      }
      // Never over the chased plane / bus / satellite: riding in landscape the hint sits under the
      // card, or (for the rest of this ride) bottom left if the thing is up there; else it waits.
      const hintEl = root.querySelector<HTMLElement>('.lbh-hint');
      const sc = labels.subject;
      if (on && hintEl && sc.r > 0 && !ctx.shotMode) {
        const hw = hintEl.offsetWidth;
        const hh = hintEl.offsetHeight;
        if (root.hasAttribute('data-rail') && L.lastCard) {
          const pad = root.hasAttribute('data-compact') ? 10 : 14;
          const lowY = H - pad - hh;
          const upY = cardBottom + 12;
          if (!L.hintLow && circleHitsBox(sc.x, sc.y, sc.r, pad, upY, pad + hw, upY + hh)) {
            L.hintLow = true;
            root.toggleAttribute('data-hintlow', true);
          }
          if (L.hintLow && circleHitsBox(sc.x, sc.y, sc.r, pad, lowY, pad + hw, lowY + hh)) on = false;
        } else {
          const rb = root.getBoundingClientRect();
          const r = hintEl.getBoundingClientRect();
          if (circleHitsBox(sc.x, sc.y, sc.r, r.left - rb.left, r.top - rb.top, r.right - rb.left, r.bottom - rb.top)) on = false;
        }
      }
      if (text !== L.hintText || on !== L.hintOn) {
        L.hintText = text;
        L.hintOn = on;
        setHint({ text, on });
      }
      // The time button's destination (where you are looking).
      if (!L.warp) {
        const to = nextTimeTarget(ctx.time.t, v.lat, v.lon).to;
        const disabled = ctx.time.frozen && !ctx.shotMode;
        const sig = `${to}|${disabled}`;
        if (sig !== L.timeSig) {
          L.timeSig = sig;
          setTime({ to, progress: null, disabled });
        }
      }
      // A pending mode: hop on as soon as something is drawn; give up on user input or timeout.
      const pend = L.pending;
      if (pend) {
        if (camSvc.lastInputAt() > pend.since + 300 || (L.mode !== 'explore' && L.modeAt > pend.since)) L.pending = null;
        else if (!tryRide(MODES.find((m) => m.id === pend.id)!, true) && now > pend.until) {
          L.pending = null;
          flash(pend.id === 'people' ? 'nobody about just now · try again in a bit' : 'no rides about just now');
        }
      }
      // The coach mark: once, a little after the world is up, while exploring, if there is anything to ride.
      if (!L.coachDone && L.coachShownAt === 0 && (!ctx.shotMode || readFlag('coach'))) {
        const anyRide = !!camSvc.ride && RIDE_KINDS.some((k) => track.list(k).length > 0);
        // (Shot mode with ?coach: at once, so a review frame catches it.)
        if (anyRide && L.mode === 'explore' && engineReady && now - readyAt > (ctx.shotMode ? 0 : COACH_DELAY) && !v.street) {
          L.coachShownAt = now;
          setCoach(true);
        }
      } else if (!L.coachDone && L.coachShownAt > 0 && now - L.coachShownAt > COACH_MAX && !ctx.shotMode) {
        finishCoach();
      }
    };

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const t0 = performance.now();
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const camSvc = ctx.services.camera;
      const m = camSvc.mode?.();
      const mode: CameraMode = m?.mode ?? ctx.view.mode ?? 'explore';
      const ride = m ? m.ride : (ctx.view.ride ?? null);
      if (mode !== L.mode || ride !== L.ride) {
        L.mode = mode;
        L.ride = ride;
        if (L.hintLow) {
          L.hintLow = false;
          root.toggleAttribute('data-hintlow', false);
        }
        L.modeAt = now;
        L.speed = 0;
        L.eye.at = 0;
        setCam({ mode, ride, kind: ride ? ctx.services.track.get(ride)?.kind : undefined });
        if (mode !== 'explore') finishCoach();
        slowAt = 0;
      }
      // Something registered or left: the dock catches up this frame (a ride the labels already
      // offer must not show as disabled).
      if (ctx.services.track.version !== L.trackVer) slowAt = 0;
      // Layout reads first (the previous frame's writes are flushed), then this frame's writes.
      if (now - slowAt >= 250) {
        slowAt = now;
        slow(now);
      }
      stepWarp(now);
      labels.hideTrack = ride;
      labels.following = mode !== 'explore';
      labels.update(W, H, dt);
      hover.tick(now, mode !== 'bird', W, ride);
      // The HUD's own JS cost, beside the systems' (F1 / ctx.perf.systemMs.hud).
      ctx.perf.system('hud', performance.now() - t0);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      labels.dispose();
      hover.dispose();
      endWarp();
      window.clearTimeout(L.noteTimer);
      window.clearTimeout(L.leaveTimer);
    };
  }, [ctx, engine, variant, activateLabel, finishCoach, flash, tryRide]);

  // ── keys: 1–6 pick a mode. ([ ] and Esc belong to the camera: camera/input.ts, D1.) ──
  useEffect(() => {
    const root = rootRef.current;
    const wrap = root?.parentElement;
    if (!wrap) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isEditable(e.target) || isEditable(document.activeElement)) return;
      const m = MODES.find((x) => x.key === e.key);
      if (!m) return;
      const btn = root?.querySelector<HTMLButtonElement>(`.lbh-mode[aria-keyshortcuts="${m.key}"]`);
      if (btn && !btn.disabled) pickMode(m.id, false);
      e.preventDefault();
    };
    // [ ] in a mode of several kinds (space, plane, drive) is the HUD's ring, not the camera's
    // per-kind cycle (which would never step from a satellite back to the station): caught on the
    // window in the capture phase, ahead of the camera's own key listener, like its Esc.
    const onBracket = (e: KeyboardEvent) => {
      if ((e.code !== 'BracketLeft' && e.code !== 'BracketRight') || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target) || isEditable(document.activeElement) || live.current.mode !== 'ride') return;
      const cur = live.current.ride ? ctx.services.track.get(live.current.ride) : undefined;
      if (!cur || !multiKind(cur.kind)) return;
      if (variant === 'window' && !wrap.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      cycle(e.code === 'BracketRight' ? 1 : -1);
    };
    // Page: the whole window (like the camera's keys). Window: only while focus is inside it.
    const target: HTMLElement | Window = variant === 'page' ? window : wrap;
    target.addEventListener('keydown', onKey as EventListener);
    window.addEventListener('keydown', onBracket, true);
    return () => {
      target.removeEventListener('keydown', onKey as EventListener);
      window.removeEventListener('keydown', onBracket, true);
    };
  }, [ctx, variant, pickMode, cycle]);

  const active = activeMode(cam.mode, cam.kind ?? (cam.ride ? ctx.services.track.get(cam.ride)?.kind : undefined));
  return (
    <div
      ref={rootRef}
      className="lbh"
      data-variant={variant}
      data-rm={ctx.reducedMotion ? '' : undefined}
      data-shot={shotHud ? '' : undefined}
      data-card={card ? '' : undefined}
    >
      <style>{HUD_CSS}</style>
      {/* Tab order: the dock, the card, the time; the moving world labels last (CSS stacks them under). */}
      <Dock active={active} avail={avail} onPick={pickMode} />
      {card ? <FollowCard info={card} onCycle={cycleFromCard} onExit={exitRide} /> : leaving && <FollowCard info={leaving} leaving onCycle={cycleFromCard} onExit={exitRide} />}
      <TimeButton state={time} onPress={pressTime} />
      {coach && !note && <Coach touch={touch} onDone={finishCoach} />}
      {note && <Note text={note} />}
      <Hint text={hint.text} on={hint.on && !coach && !note} snap={coach || !!note} />
      <div ref={labelsRef} className="lbh-labels" />
    </div>
  );
}
