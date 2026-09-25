'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { comboRate, SnakeSound, SOUND_KEY } from './audio/sound';
import { applyInput, createInitialState, step } from './engine/engine';
import { headingFromKeys, headingToward, type DirKeys } from './engine/math';
import { SIM_DT, type EngineEvent, type GameState } from './engine/types';
import { Hud, WebGLFallback, type HudPhase, type HudView } from './hud';
import {
  insertEntry,
  loadLeaderboard,
  qualifies,
  readNumber,
  readString,
  safeStorage,
  saveLeaderboard,
  writeString,
  type LeaderboardEntry,
} from './leaderboard';
import type { RendererHandle, Theme } from './render/mount';

const BEST_KEY = 'snake.best';
const INITIALS_KEY = 'snake.initials';
const MOUSE_IDLE_MS = 1500;
const DRAG_START_PX = 14;
const TAP_MS = 300;

const KEY_DIR: Record<string, keyof DirKeys | undefined> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  W: 'up',
  s: 'down',
  S: 'down',
  a: 'left',
  A: 'left',
  d: 'right',
  D: 'right',
};

function readTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function viewOf(s: GameState): HudView {
  return {
    status: s.status,
    score: s.score,
    best: s.best,
    length: Math.round(s.bodyLength * 10) / 10,
    deathCause: s.deathCause,
  };
}

function sameView(a: HudView | null, b: HudView): boolean {
  return (
    !!a &&
    a.status === b.status &&
    a.score === b.score &&
    a.best === b.best &&
    a.length === b.length &&
    a.deathCause === b.deathCause
  );
}

export function SnakeCanvas({ variant }: { variant: 'window' | 'page' }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<RendererHandle | null>(null);
  const soundRef = useRef<SnakeSound | null>(null);
  const stateRef = useRef<GameState | null>(null);
  const prevRef = useRef<GameState | null>(null);
  const accRef = useRef(0);
  const frozenRef = useRef(false);
  const phaseRef = useRef<HudPhase>('none');
  const viewRef = useRef<HudView | null>(null);
  const keysRef = useRef<DirKeys>({ up: false, down: false, left: false, right: false });
  const mouseRef = useRef({ x: 0, y: 0, at: -Infinity, active: false });
  const wantSoundRef = useRef(false);

  const [view, setView] = useState<HudView>({ status: 'idle', score: 0, best: 0, length: 4, deathCause: null });
  const [phase, setPhaseState] = useState<HudPhase>('none');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [rank, setRank] = useState(-1);
  const [lastInitials, setLastInitials] = useState('');
  const [muted, setMuted] = useState(true);
  const [touch, setTouch] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [failed, setFailed] = useState(false);

  const setPhase = useCallback((p: HudPhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const syncView = useCallback((s: GameState) => {
    const next = viewOf(s);
    if (sameView(viewRef.current, next)) return;
    viewRef.current = next;
    setView(next);
  }, []);

  const onEngineEvents = useCallback(
    (events: EngineEvent[], s: GameState) => {
      const sound = soundRef.current;
      for (const e of events) {
        if (e.type === 'eat') sound?.play(e.food.kind === 'golden' ? 'golden' : 'eat', comboRate(e.combo));
        if (e.type === 'death') {
          sound?.play('death');
          window.setTimeout(() => soundRef.current?.play('sink'), 250);
          const store = safeStorage();
          writeString(store, BEST_KEY, String(Math.max(readNumber(store, BEST_KEY), s.score)));
          const table = loadLeaderboard(store);
          setEntries(table);
          setRank(-1);
          setPhase(qualifies(table, s.score) ? 'initials' : 'table');
        }
      }
    },
    [setPhase],
  );

  const restart = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    const best = Math.max(s.best, readNumber(safeStorage(), BEST_KEY));
    const next = applyInput({ ...s, best }, { type: 'restart' });
    stateRef.current = next;
    prevRef.current = next;
    accRef.current = 0;
    handleRef.current?.reset(next);
    setPhase('none');
    setRank(-1);
    syncView(next);
    soundRef.current?.play('ui');
  }, [setPhase, syncView]);

  const submitInitials = useCallback(
    (initials: string) => {
      const s = stateRef.current;
      if (!s) return;
      const store = safeStorage();
      const result = insertEntry(loadLeaderboard(store), {
        initials,
        score: s.score,
        length: Math.round(s.bodyLength * 10) / 10,
        date: Date.now(),
      });
      saveLeaderboard(store, result.entries);
      writeString(store, INITIALS_KEY, initials);
      setLastInitials(initials);
      setEntries(result.entries);
      setRank(result.rank);
      setPhase('table');
      soundRef.current?.play('ui');
    },
    [setPhase],
  );

  // Must run inside a user gesture (click / key): browsers only start audio there.
  const toggleSound = useCallback(() => {
    const want = !wantSoundRef.current;
    wantSoundRef.current = want;
    writeString(safeStorage(), SOUND_KEY, want ? 'on' : 'off');
    setMuted(!want);
    void soundRef.current?.setMuted(!want);
  }, []);

  const unlockSound = useCallback(() => {
    const sound = soundRef.current;
    if (sound && wantSoundRef.current && sound.isMuted()) void sound.setMuted(false);
  }, []);

  const togglePause = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    const next = applyInput(s, { type: 'pause' });
    stateRef.current = next;
    if (next.status === 'paused') soundRef.current?.suspend();
    else soundRef.current?.resume();
  }, []);

  // Renderer, sound and the game loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let cancelled = false;
    let raf = 0;
    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    let removeDevHook: (() => void) | null = null;

    const store = safeStorage();
    const theme = readTheme();
    const sound = new SnakeSound(theme);
    soundRef.current = sound;
    wantSoundRef.current = readString(store, SOUND_KEY) === 'on';
    setMuted(!wantSoundRef.current);
    setTouch(window.matchMedia('(pointer: coarse)').matches);
    setLastInitials(readString(store, INITIALS_KEY) ?? '');
    setEntries(loadLeaderboard(store));
    const initial = createInitialState({ seed: Math.floor(Math.random() * 0x7fffffff), best: readNumber(store, BEST_KEY) });
    stateRef.current = initial;
    prevRef.current = initial;
    syncView(initial);

    (async () => {
      let handle: RendererHandle;
      try {
        const { mount } = await import('./render/mount');
        if (cancelled) return;
        handle = mount(canvas, {
          theme,
          reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        });
      } catch {
        if (!cancelled) setFailed(true);
        return;
      }
      if (cancelled) {
        handle.dispose();
        return;
      }
      handleRef.current = handle;
      const rect = wrap.getBoundingClientRect();
      handle.resize(rect.width, rect.height);
      resizeObserver = new ResizeObserver(([entry]) => handle.resize(entry.contentRect.width, entry.contentRect.height));
      resizeObserver.observe(wrap);
      themeObserver = new MutationObserver(() => {
        const t = readTheme();
        handle.setTheme(t);
        soundRef.current?.setTheme(t);
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      setMounted(true);
      if (process.env.NODE_ENV !== 'production') {
        void import('./dev-scenes').then(({ installDevHook }) => {
          if (cancelled) return;
          removeDevHook = installDevHook({
            handle,
            apply: (s, prev) => {
              stateRef.current = s;
              prevRef.current = prev;
              accRef.current = 0;
              syncView(s);
            },
            freeze: (on) => {
              frozenRef.current = on;
            },
            setHud: (p, e, r) => {
              setPhase(p);
              setEntries(e);
              setRank(r);
            },
          });
        });
      }

      let last = performance.now();
      const loop = (now: number) => {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        let s = stateRef.current!;
        const frozen = frozenRef.current;
        if (!frozen) {
          const m = mouseRef.current;
          if (m.active && s.status === 'playing' && now - m.at < MOUSE_IDLE_MS) {
            const g = handle.screenToGround(m.x, m.y);
            if (g && (g.x - s.head.x) ** 2 + (g.z - s.head.z) ** 2 > 0.36) {
              const h = headingToward(s.head, g);
              if (h !== null) s = applyInput(s, { type: 'steer', heading: h });
            }
          }
          accRef.current = s.status === 'playing' ? accRef.current + dt : 0;
          let prev = prevRef.current ?? s;
          while (accRef.current >= SIM_DT) {
            prev = s;
            const r = step(s, SIM_DT);
            s = r.state;
            accRef.current -= SIM_DT;
            if (r.events.length > 0) {
              handle.handleEvents(r.events, s);
              onEngineEvents(r.events, s);
            }
          }
          prevRef.current = prev;
          stateRef.current = s;
        }
        const alpha = !frozen && s.status === 'playing' ? accRef.current / SIM_DT : 1;
        handle.frame({ prev: prevRef.current ?? s, cur: s, alpha, dt: frozen ? 0 : dt });
        soundRef.current?.setMotion(s.speed, s.status === 'playing');
        syncView(s);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      removeDevHook?.();
      handleRef.current?.dispose();
      handleRef.current = null;
      sound.dispose();
      soundRef.current = null;
    };
  }, [onEngineEvents, setPhase, syncView]);

  // Keyboard.
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (phaseRef.current === 'initials') return; // the initials field owns the keyboard
      const s = stateRef.current;
      if (!s || !handleRef.current) return;
      unlockSound();
      if (e.key === ' ') {
        e.preventDefault();
        togglePause();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        restart();
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        toggleSound();
        return;
      }
      const dir = KEY_DIR[e.key];
      if (!dir) return;
      e.preventDefault();
      keysRef.current = { ...keysRef.current, [dir]: true };
      mouseRef.current.active = false;
      const h = headingFromKeys(keysRef.current);
      if (h !== null) stateRef.current = applyInput(s, { type: 'steer', heading: h });
    };
    const onUp = (e: KeyboardEvent) => {
      const dir = KEY_DIR[e.key];
      if (dir) keysRef.current = { ...keysRef.current, [dir]: false };
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [restart, toggleSound, togglePause, unlockSound]);

  // Mouse (steer toward the pointer) and touch (drag like a joystick, tap to start/restart).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let drag: { id: number; x: number; y: number; t: number; moved: boolean } | null = null;

    const tap = () => {
      const s = stateRef.current;
      if (!s) return;
      if (s.status === 'idle') stateRef.current = applyInput(s, { type: 'start' });
      else if (s.status === 'paused') togglePause();
      else if (s.status === 'gameover' && phaseRef.current === 'table') restart();
    };
    const onDown = (e: PointerEvent) => {
      unlockSound();
      if (e.pointerType === 'mouse') {
        tap();
        return;
      }
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') {
        mouseRef.current = { x: e.clientX, y: e.clientY, at: performance.now(), active: true };
        return;
      }
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return;
      drag.moved = true;
      const s = stateRef.current;
      if (!s || phaseRef.current === 'initials') return;
      // The camera never rotates, so screen right = +x and screen down = +z.
      stateRef.current = applyInput(s, { type: 'steer', heading: Math.atan2(dy, dx) });
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && performance.now() - drag.t < TAP_MS) tap();
      drag = null;
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') mouseRef.current.active = false;
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [restart, togglePause, unlockSound]);

  // Hidden tab: pause the run and silence audio.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        const s = stateRef.current;
        if (s?.status === 'playing') stateRef.current = applyInput(s, { type: 'pause' });
        soundRef.current?.suspend();
      } else if (stateRef.current?.status !== 'paused') {
        soundRef.current?.resume();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Reduced motion can change while the game is open.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => handleRef.current?.setReducedMotion(mq.matches);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  return (
    <div ref={wrapRef} data-variant={variant} className="relative h-full w-full overflow-hidden bg-[#0d0a07]">
      <canvas
        ref={canvasRef}
        data-mounted={mounted ? '1' : '0'}
        aria-label="snake game"
        className="block h-full w-full touch-none"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.35) 100%)' }}
      />
      {failed ? (
        <WebGLFallback />
      ) : (
        <Hud
          view={view}
          phase={phase}
          entries={entries}
          rank={rank}
          muted={muted}
          touch={touch}
          lastInitials={lastInitials}
          onToggleSound={toggleSound}
          onSubmitInitials={submitInitials}
        />
      )}
    </div>
  );
}
