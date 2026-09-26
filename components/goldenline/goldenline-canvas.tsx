'use client';

import { useEffect, useRef, useState } from 'react';
import type { Engine } from './core/engine';

type Phase = 'loading' | 'ready' | 'playing' | 'nogpu' | 'error';

export function GoldenlineCanvas({ variant }: { variant: 'window' | 'page' }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [progress, setProgress] = useState(0);
  const [label, setLabel] = useState('loading');
  const [shotMode] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('shot'));

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    (async () => {
      try {
        const { createEngine, NoWebGPUError } = await import('./core/engine');
        let engine: Engine;
        try {
          engine = await createEngine({
            canvas,
            overlayHost: wrap,
            variant,
            reducedMotion,
            search: window.location.search,
            onProgress: (f, l) => {
              if (cancelled) return;
              setProgress(f);
              setLabel(l);
            },
          });
        } catch (e) {
          if (!cancelled) setPhase(e instanceof NoWebGPUError ? 'nogpu' : 'error');
          if (!(e instanceof NoWebGPUError)) console.error('[goldenline]', e);
          return;
        }
        if (cancelled) {
          engine.dispose();
          return;
        }
        engineRef.current = engine;
        const r = wrap.getBoundingClientRect();
        engine.resize(r.width, r.height);
        ro = new ResizeObserver((entries) => {
          const box = entries[0]?.contentRect;
          if (box) engine.resize(box.width, box.height);
        });
        ro.observe(wrap);
        engine.start();
        setPhase(shotMode ? 'playing' : 'ready');
      } catch (e) {
        console.error('[goldenline]', e);
        if (!cancelled) setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [variant, shotMode]);

  const begin = () => {
    engineRef.current?.ctx.input.requestLock();
    if (phase === 'ready') setPhase('playing');
  };

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden" style={{ background: '#0d0a08' }}>
      <canvas
        ref={canvasRef}
        onClick={begin}
        className="block h-full w-full"
        style={{ cursor: phase === 'playing' ? 'crosshair' : 'default', outline: 'none' }}
        aria-label="GOLDENLINE surf demo"
      />
      {phase === 'nogpu' && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center font-mono text-[12px]" style={{ color: '#e9dcc8' }}>
          GOLDENLINE needs WebGPU. Open this page in desktop Chrome.
        </div>
      )}
      {phase === 'error' && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center font-mono text-[12px]" style={{ color: '#e9dcc8' }}>
          The GPU gave up while loading the beach. Reload to try again.
        </div>
      )}
      {!shotMode && (phase === 'loading' || phase === 'ready') && (
        <LoadingScreen progress={progress} label={label} ready={phase === 'ready'} onBegin={begin} compact={variant === 'window'} />
      )}
    </div>
  );
}

function LoadingScreen({
  progress,
  label,
  ready,
  onBegin,
  compact,
}: {
  progress: number;
  label: string;
  ready: boolean;
  onBegin: () => void;
  compact: boolean;
}) {
  return (
    <div
      onClick={ready ? onBegin : undefined}
      className="absolute inset-0 flex flex-col items-center justify-center font-mono"
      style={{
        cursor: ready ? 'pointer' : 'progress',
        color: '#f3e4cc',
        background:
          'radial-gradient(120% 90% at 50% 110%, rgba(255,160,70,0.28) 0%, rgba(120,60,30,0.18) 35%, rgba(13,10,8,0) 70%), linear-gradient(180deg, #0d0a08 0%, #1a110b 100%)',
        transition: 'opacity 900ms var(--ease, ease)',
      }}
    >
      <div className={compact ? 'text-[20px]' : 'text-[34px]'} style={{ letterSpacing: '0.5em', fontWeight: 300, marginRight: '-0.5em' }}>
        GOLDENLINE
      </div>
      <div className="mt-3 text-[10px] uppercase" style={{ letterSpacing: '0.35em', color: 'rgba(243,228,204,0.55)' }}>
        golden hour · reef break · webgpu
      </div>
      <div className="mt-8" style={{ width: compact ? 180 : 260, height: 1, background: 'rgba(243,228,204,0.12)' }}>
        <div style={{ width: `${Math.round(progress * 100)}%`, height: 1, background: '#ffb84d', transition: 'width 300ms ease' }} />
      </div>
      <div className="mt-3 h-4 text-[10px]" style={{ letterSpacing: '0.2em', color: 'rgba(243,228,204,0.5)' }}>
        {ready ? 'click to paddle out' : label}
      </div>
      {ready && (
        <div className="mt-6 text-[10px]" style={{ letterSpacing: '0.15em', color: 'rgba(243,228,204,0.4)' }}>
          mouse look · wasd · shift · space · f1 settings
        </div>
      )}
    </div>
  );
}
