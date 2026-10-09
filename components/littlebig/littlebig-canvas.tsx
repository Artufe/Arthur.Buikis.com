'use client';

import { useEffect, useRef, useState } from 'react';
import type { Engine } from './core/engine';
import type { PlanetSession } from './core/session';
import { provideHandoff, takeHandoff } from './handoff';
import { Hud } from './ui/hud';

type Phase = 'loading' | 'running' | 'nogl' | 'error';

// Serialise engine boots: React strict mode (or a quick close/reopen) can start a second boot on the
// same canvas while the first is still loading. Each boot waits for the previous one to settle.
let bootChain: Promise<void> = Promise.resolve();

const SPACE = '#070B1A';
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
  // The running engine, for the HUD (set once it is up).
  const [engine, setEngine] = useState<Engine | null>(null);
  const [debug, setDebug] = useState<string | null>(null);
  // Touch input seen (or a coarse pointer): mounts the virtual stick overlay.
  const [touchUi, setTouchUi] = useState(false);
  const [shotMode] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('shot'));
  // ?shot=1 hides the HUD for clean review frames; ?hud=1 brings it back (scripts/littlebig-shot.mjs --hud).
  const [hudInShots] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('hud'));
  const showHud = !shotMode || hudInShots;
  // Bumped when the browser restores a lost WebGL context: remounts the canvas (fresh context) and
  // reboots the engine (~150 ms warm).
  const [generation, setGeneration] = useState(0);
  // Where the player was when the context was lost: the rebooted engine carries on from there.
  const resumeRef = useRef<PlanetSession | null>(null);

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
      if (e && !cancelled) resumeRef.current = { view: e.ctx.services.camera.getView(), t: e.ctx.time.t, camera: e.ctx.services.camera.snapshot?.() };
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
        if (variant === 'window') offHandoff = provideHandoff(() => ({ view: engine.ctx.services.camera.getView(), t: engine.ctx.time.t, camera: engine.ctx.services.camera.snapshot?.() }));
        setEngine(engine);
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
      setEngine(null);
    };
  }, [variant, generation]);

  // Touch seen (or a coarse pointer): mounts the virtual stick overlay. (The hint row lives in the HUD.)
  useEffect(() => {
    if (shotMode || phase !== 'running' || touchUi || !engine) return;
    return engine.subscribeFrame(() => {
      if (engineRef.current?.ctx.services.camera.stick?.().touch) setTouchUi(true);
    });
  }, [engine, phase, shotMode, touchUi]);

  // Touch UI: the left-thumb stick, shown only on touch and only at street level. Driven straight
  // from the camera's live stick state each frame (no React renders).
  const stickRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  useEffect(() => {
    if (shotMode || phase !== 'running' || !touchUi || !engine) return;
    let shown = false;
    const last = [NaN, NaN, NaN, NaN];
    let lastActive = false;
    const tick = () => {
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
      ringRef.current?.setAttribute('stroke', st.active ? '#FFB84D' : 'rgba(255,248,232,0.6)');
      knob.style.transform = `translate(${kx}px, ${ky}px)`;
    };
    return engine.subscribeFrame(tick);
  }, [engine, phase, shotMode, touchUi]);

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
      {phase === 'running' && showHud && engine && <Hud engine={engine} variant={variant} shotHud={shotMode} />}
      {phase === 'running' && !shotMode && touchUi && (
        // The left-thumb stick (POP: ink ring, paper knob with a hard shadow). SVG circles: the site's
        // global square corners apply to every box.
        <div
          ref={stickRef}
          aria-hidden
          className="pointer-events-none absolute top-0 left-0"
          style={{ width: STICK_R * 2, height: STICK_R * 2, opacity: 0, transition: 'opacity 400ms ease', zIndex: 4 }}
        >
          <svg width={STICK_R * 2} height={STICK_R * 2} viewBox={`0 0 ${STICK_R * 2} ${STICK_R * 2}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
            <circle cx={STICK_R} cy={STICK_R} r={STICK_R - 2} fill="rgba(27,21,48,0.28)" stroke="#1B1530" strokeWidth="3" />
            <circle ref={ringRef} cx={STICK_R} cy={STICK_R} r={STICK_R - 5.5} fill="none" stroke="rgba(255,248,232,0.6)" strokeWidth="2" strokeDasharray="5 6" />
          </svg>
          <div ref={knobRef} className="absolute" style={{ left: STICK_R - 21, top: STICK_R - 21, width: 42, height: 42 }}>
            <svg width="42" height="42" viewBox="0 0 42 42" style={{ overflow: 'visible' }}>
              <circle cx="23.5" cy="23.5" r="18" fill="#1B1530" />
              <circle cx="21" cy="21" r="18" fill="#FFF8E8" stroke="#1B1530" strokeWidth="3" />
              <circle cx="21" cy="21" r="7" fill="#FFB84D" stroke="#1B1530" strokeWidth="2" />
            </svg>
          </div>
        </div>
      )}
      {debug && (
        <div className="pointer-events-none absolute right-3 font-mono text-[10px]" style={{ top: 68, zIndex: 5, color: '#ffb84d', textShadow: '0 1px 4px #000' }}>
          {debug}
        </div>
      )}
    </div>
  );
}
