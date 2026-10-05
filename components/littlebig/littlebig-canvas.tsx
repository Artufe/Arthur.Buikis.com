'use client';

import { useEffect, useRef, useState } from 'react';
import type { Engine } from './core/engine';
import { provideHandoff, takeHandoff } from './handoff';

type Phase = 'loading' | 'running' | 'nogl' | 'error';

// Serialise engine boots: React strict mode (or a quick close/reopen) can start a second boot on the
// same canvas while the first is still loading. Each boot waits for the previous one to settle.
let bootChain: Promise<void> = Promise.resolve();

const SPACE = '#070B1A';
const HINT_ORBIT = 'drag to spin · scroll to dive · double-click to fly';
const HINT_STREET = 'wasd walk · drag to look · space jump · scroll out to fly';
const HINT_STREET_PAGE = 'wasd walk · click to look · space jump · scroll out to fly';
const HINT_ORBIT_TOUCH = 'drag to spin · pinch to dive · double-tap to fly';
const HINT_STREET_TOUCH = 'left thumb walks · drag to look · pinch out to fly';
// Hovering low over open water (the zoom's floor there): how to get back to land.
const HINT_SEA = 'scroll out to fly · double-click land to fly there';
const HINT_SEA_TOUCH = 'pinch out to fly · double-tap land to fly there';
/** Idle before the hint first shows, or shows a new line (ms); idle before it repeats one already seen. */
const HINT_IDLE = 2000;
const HINT_REPEAT_IDLE = 9000;
/** Virtual stick geometry (CSS px): travel radius (camera/input.ts STICK_RADIUS) and the resting spot. */
const STICK_R = 46;
const STICK_REST_X = 70; // = camera/input.ts STICK_REST_X / STICK_REST_BOTTOM (the stick zone is anchored on it)
const STICK_REST_BOTTOM = 92;

export function LittlebigCanvas({ variant }: { variant: 'window' | 'page' }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [slow, setSlow] = useState(false);
  const [hint, setHint] = useState<{ text: string; on: boolean }>({ text: HINT_ORBIT, on: false });
  const [debug, setDebug] = useState<string | null>(null);
  // Touch input seen (or a coarse pointer): mounts the virtual stick overlay.
  const [touchUi, setTouchUi] = useState(false);
  const [shotMode] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('shot'));
  // Bumped when the browser restores a lost WebGL context: remounts the canvas (fresh context) and
  // reboots the engine (~150 ms warm).
  const [generation, setGeneration] = useState(0);
  // Where the player was when the context was lost: the rebooted engine carries on from there.
  const resumeRef = useRef<{ view: ReturnType<Engine['ctx']['services']['camera']['getView']>; t: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    let offHandoff = () => {};
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const onRestored = () => !cancelled && setGeneration((g) => g + 1);
    // (Registered before the engine's own listener, which releases the engine on loss.)
    const onLost = () => {
      const e = engineRef.current;
      if (e && !cancelled) resumeRef.current = { view: e.ctx.services.camera.getView(), t: e.ctx.time.t };
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    const slowTimer = window.setTimeout(() => !cancelled && setSlow(true), 450);

    const prevBoot = bootChain;
    let releaseBoot: () => void = () => {};
    bootChain = new Promise<void>((r) => (releaseBoot = r));

    (async () => {
      try {
        await prevBoot;
        if (cancelled) return;
        const t0 = performance.now();
        const { createEngine, NoWebGLError } = await import('./core/engine');
        const chunkMs = performance.now() - t0;
        if (cancelled) return;
        let engine: Engine;
        try {
          // After a context loss: where the player was. On /planet: where the window's player was
          // when they pressed ↗ (handoff.ts).
          const resume = resumeRef.current ?? (variant === 'page' ? takeHandoff() : null) ?? undefined;
          resumeRef.current = null;
          engine = await createEngine({ canvas, variant, reducedMotion, search: window.location.search, resume });
        } catch (e) {
          if (!cancelled) setPhase(e instanceof NoWebGLError ? 'nogl' : 'error');
          if (!(e instanceof NoWebGLError)) console.error('[littlebig]', e);
          return;
        }
        if (cancelled) {
          engine.dispose();
          return;
        }
        engine.ctx.boot.entries.unshift({ stage: 'engine chunk (import)', ms: Math.round(chunkMs), at: 0 });
        engineRef.current = engine;
        const r = wrap.getBoundingClientRect();
        engine.resize(r.width, r.height);
        ro = new ResizeObserver((entries) => {
          const box = entries[0]?.contentRect;
          if (box && box.width > 0 && box.height > 0) engine.resize(box.width, box.height);
        });
        ro.observe(wrap);
        engine.start();
        if (variant === 'window') offHandoff = provideHandoff(() => ({ view: engine.ctx.services.camera.getView(), t: engine.ctx.time.t }));
        setPhase('running');
      } catch (e) {
        console.error('[littlebig]', e);
        if (!cancelled) setPhase('error');
      } finally {
        releaseBoot();
      }
    })();

    return () => {
      cancelled = true;
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      window.clearTimeout(slowTimer);
      ro?.disconnect();
      offHandoff();
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [variant, generation]);

  // Hint row: fades in after 2 s without input (from the first frame), fades out on interaction.
  // A line already shown comes back only after a longer idle, so it never nags.
  useEffect(() => {
    if (shotMode || phase !== 'running') return;
    const since = performance.now();
    let lastShown = '';
    let showing = false;
    const id = window.setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      const cam = e.ctx.services.camera;
      const touch = cam.stick?.().touch ?? false;
      if (touch) setTouchUi(true);
      const v = e.ctx.view;
      const street = v.street;
      const sea = !street && v.alt < 14 && e.ctx.world.planet.heightAt(v.focus) < -0.3;
      const text = street
        ? touch
          ? HINT_STREET_TOUCH
          : variant === 'page'
            ? HINT_STREET_PAGE
            : HINT_STREET
        : sea
          ? touch
            ? HINT_SEA_TOUCH
            : HINT_SEA
          : touch
            ? HINT_ORBIT_TOUCH
            : HINT_ORBIT;
      const idle = performance.now() - Math.max(since, cam.lastInputAt());
      const on = idle > (text === lastShown && !showing ? HINT_REPEAT_IDLE : HINT_IDLE);
      if (on) lastShown = text;
      showing = on;
      setHint((h) => (h.on === on && h.text === text ? h : { text, on }));
    }, 250);
    return () => window.clearInterval(id);
  }, [phase, shotMode, variant]);

  // Touch UI: the left-thumb stick, shown only on touch and only at street level. Driven straight
  // from the camera's live stick state each frame (no React renders).
  const stickRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shotMode || phase !== 'running' || !touchUi) return;
    let raf = 0;
    let shown = false;
    const last = [NaN, NaN, NaN, NaN];
    let lastActive = false;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const base = stickRef.current;
      const knob = knobRef.current;
      const st = engineRef.current?.ctx.services.camera.stick?.();
      if (!base || !knob || !st) return;
      if (st.visible !== shown) {
        shown = st.visible;
        base.style.opacity = shown ? '1' : '0';
      }
      if (!shown) return;
      const h = base.parentElement?.clientHeight ?? 0;
      const cx = st.active ? st.ox : STICK_REST_X;
      const cy = st.active ? st.oy : h - STICK_REST_BOTTOM;
      const kx = st.x * STICK_R;
      const ky = st.y * STICK_R;
      if (cx === last[0] && cy === last[1] && kx === last[2] && ky === last[3] && st.active === lastActive) return;
      last[0] = cx;
      last[1] = cy;
      last[2] = kx;
      last[3] = ky;
      lastActive = st.active;
      base.style.transform = `translate(${cx - STICK_R}px, ${cy - STICK_R}px)`;
      base.style.borderColor = st.active ? 'rgba(255,184,77,0.75)' : 'rgba(240,244,255,0.32)';
      knob.style.transform = `translate(${kx}px, ${ky}px)`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, shotMode, touchUi]);

  // F1: debug readout (altitude, position, frame time).
  useEffect(() => {
    if (phase !== 'running') return;
    let on = false;
    let id = 0;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'F1') return;
      ev.preventDefault();
      on = !on;
      window.clearInterval(id);
      if (!on) return setDebug(null);
      id = window.setInterval(() => {
        const e = engineRef.current;
        if (!e) return;
        const v = e.ctx.view;
        const p = e.ctx.perf.summarize();
        setDebug(
          `alt ${v.alt.toFixed(1)} m · ${v.lat.toFixed(2)}°, ${v.lon.toFixed(2)}° · hdg ${((v.heading * 180) / Math.PI).toFixed(0)}° · ` +
            `fov ${v.fov.toFixed(0)}° · ${p.median.toFixed(1)} ms · ${e.ctx.renderer.info.render.calls} calls · ${e.ctx.quality}`,
        );
      }, 250);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearInterval(id);
    };
  }, [phase]);

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden" style={{ background: SPACE }}>
      <canvas
        key={generation}
        ref={canvasRef}
        data-littlebig=""
        className="block h-full w-full"
        style={{ outline: 'none', cursor: 'grab' }}
        aria-label="LITTLEBIG, a tiny cartoon planet"
      />
      {phase === 'loading' && slow && !shotMode && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center font-mono text-[11px] tracking-[0.2em]" style={{ color: 'rgba(225,232,255,0.55)' }}>
          landing on the planet
        </div>
      )}
      {phase === 'nogl' && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center font-mono text-[12px]" style={{ color: '#dfe6ff' }}>
          This little planet needs WebGL 2, and this browser does not have it.
        </div>
      )}
      {phase === 'error' && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center font-mono text-[12px]" style={{ color: '#dfe6ff' }}>
          The planet failed to load. Reload to try again.
        </div>
      )}
      {phase === 'running' && !shotMode && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-3 px-4 text-center font-mono text-[11px] tracking-[0.12em]"
          style={{ opacity: hint.on ? 1 : 0, transition: 'opacity 600ms ease' }}
        >
          {/* A faint backing keeps the line legible over pale pavement and sky alike. */}
          <span className="inline-block px-2.5 py-1 whitespace-nowrap max-[460px]:px-1.5 max-[460px]:text-[10px] max-[460px]:tracking-[0.02em]" style={{ color: 'rgba(240,244,255,0.86)', background: 'rgba(7,11,26,0.34)', textShadow: '0 1px 4px rgba(7,11,26,0.7)' }}>
            {hint.text}
          </span>
        </div>
      )}
      {phase === 'running' && !shotMode && touchUi && (
        <div
          ref={stickRef}
          aria-hidden
          className="pointer-events-none absolute top-0 left-0"
          style={{
            width: STICK_R * 2,
            height: STICK_R * 2,
            border: '1.5px solid rgba(240,244,255,0.32)',
            background: 'rgba(7,11,26,0.18)',
            opacity: 0,
            transition: 'opacity 400ms ease, border-color 200ms ease',
          }}
        >
          <div
            ref={knobRef}
            className="absolute"
            style={{
              left: STICK_R - 20,
              top: STICK_R - 20,
              width: 40,
              height: 40,
              background: 'rgba(240,244,255,0.55)',
              boxShadow: '0 1px 6px rgba(7,11,26,0.5)',
            }}
          />
        </div>
      )}
      {debug && (
        <div className="pointer-events-none absolute top-2 right-2 font-mono text-[10px]" style={{ color: '#ffb84d', textShadow: '0 1px 4px #000' }}>
          {debug}
        </div>
      )}
    </div>
  );
}
