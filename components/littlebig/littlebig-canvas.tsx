'use client';

import { useEffect, useRef, useState } from 'react';
import type { Engine } from './core/engine';

type Phase = 'loading' | 'running' | 'nogl' | 'error';

// Serialise engine boots: React strict mode (or a quick close/reopen) can start a second boot on the
// same canvas while the first is still loading. Each boot waits for the previous one to settle.
let bootChain: Promise<void> = Promise.resolve();

const SPACE = '#070B1A';
const HINT_ORBIT = 'drag to spin · scroll to dive · double-click to fly';
const HINT_STREET = 'wasd walk · space jump · scroll out to fly';

export function LittlebigCanvas({ variant }: { variant: 'window' | 'page' }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [slow, setSlow] = useState(false);
  const [hint, setHint] = useState<{ text: string; on: boolean }>({ text: HINT_ORBIT, on: false });
  const [debug, setDebug] = useState<string | null>(null);
  const [shotMode] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('shot'));
  // Bumped when the browser restores a lost WebGL context: remounts the canvas (fresh context) and
  // reboots the engine (~150 ms warm).
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const onRestored = () => !cancelled && setGeneration((g) => g + 1);
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
          engine = await createEngine({ canvas, variant, reducedMotion, search: window.location.search });
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
      canvas.removeEventListener('webglcontextrestored', onRestored);
      window.clearTimeout(slowTimer);
      ro?.disconnect();
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [variant, generation]);

  // Hint row: fades in after 2 s without input, fades out on interaction.
  useEffect(() => {
    if (shotMode || phase !== 'running') return;
    const id = window.setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      const idle = performance.now() - e.ctx.services.camera.lastInputAt() > 2000;
      const text = e.ctx.view.street ? HINT_STREET : HINT_ORBIT;
      setHint((h) => (h.on === idle && h.text === text ? h : { text, on: idle }));
    }, 250);
    return () => window.clearInterval(id);
  }, [phase, shotMode]);

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
          className="pointer-events-none absolute inset-x-0 bottom-3 text-center font-mono text-[11px] tracking-[0.12em]"
          style={{ color: 'rgba(240,244,255,0.78)', textShadow: '0 1px 6px rgba(7,11,26,0.8)', opacity: hint.on ? 1 : 0, transition: 'opacity 600ms ease' }}
        >
          {hint.text}
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
