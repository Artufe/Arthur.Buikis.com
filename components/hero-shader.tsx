'use client';

import { useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';
import Script from 'next/script';
import { getPlasmaMode, onPlasmaModeChange, type PlasmaMode } from '@/lib/plasma-bus';

type Vec3 = [number, number, number];
type ShaderOpts = Partial<{
  intensity: number;
  speed: number;
  grain: number;
  seed: number;
  deep: Vec3;
  mid: Vec3;
  accent: Vec3;
}>;
type HeroShaderHandle = { set(opts: ShaderOpts): void; stop(): void };

declare global {
  interface Window {
    HeroShader?: { mount(canvas: HTMLCanvasElement, opts?: ShaderOpts): HeroShaderHandle };
  }
}

const PALETTES = {
  dark: {
    deep:      [0.059, 0.059, 0.059] as Vec3, // #0F0F0F
    mid:       [0.102, 0.122, 0.180] as Vec3, // #1A1F2E
    accent:    [1.000, 0.722, 0.302] as Vec3, // #FFB84D
    intensity: 0.55,
  },
  light: {
    deep:      [0.969, 0.961, 0.945] as Vec3, // #F7F5F1
    mid:       [0.922, 0.898, 0.871] as Vec3, // #EBE5DE
    accent:    [0.698, 0.361, 0.051] as Vec3, // #B25C0D
    intensity: 0.32,
  },
} as const;

const CALM_FACTOR = 0.55;

function applyState(handle: HeroShaderHandle, theme: string | undefined, mode: PlasmaMode) {
  const palette = theme === 'light' ? PALETTES.light : PALETTES.dark;
  const factor = mode === 'calm' ? CALM_FACTOR : 1;
  handle.set({
    deep: palette.deep,
    mid: palette.mid,
    accent: palette.accent,
    intensity: palette.intensity * factor,
  });
  // Reduced-motion override runs LAST so it always wins, regardless of theme/plasma changes.
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    handle.set({ speed: 0, intensity: 0.35 });
  }
}

export function HeroShader() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<HeroShaderHandle | null>(null);
  const modeRef = useRef<PlasmaMode>('vivid');
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (handleRef.current) applyState(handleRef.current, resolvedTheme, modeRef.current);
  }, [resolvedTheme]);

  useEffect(() => {
    modeRef.current = getPlasmaMode();
    if (handleRef.current) applyState(handleRef.current, resolvedTheme, modeRef.current);
    const unsub = onPlasmaModeChange((mode) => {
      modeRef.current = mode;
      if (handleRef.current) applyState(handleRef.current, resolvedTheme, mode);
    });
    return unsub;
  }, [resolvedTheme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let heroH = 0;
    const measure = () => {
      const hero = document.querySelector<HTMLElement>('[data-hero-region]');
      heroH = hero?.getBoundingClientRect().height ?? window.innerHeight;
    };
    measure();

    let raf: number | null = null;
    const onScroll = () => {
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        const r = Math.max(0, Math.min(1, 1 - window.scrollY / heroH));
        canvas.style.opacity = String(r);
        raf = null;
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);
    onScroll();

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    return () => {
      handleRef.current?.stop();
      handleRef.current = null;
    };
  }, []);

  return (
    <>
      <Script
        src="/hero-shader.js"
        strategy="afterInteractive"
        onLoad={() => {
          if (handleRef.current || !canvasRef.current || !window.HeroShader) return;
          modeRef.current = getPlasmaMode();
          handleRef.current = window.HeroShader.mount(canvasRef.current, {
            seed: Math.random() * 6.2831853,
          });
          applyState(handleRef.current, resolvedTheme, modeRef.current);
        }}
      />
      <canvas
        ref={canvasRef}
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          zIndex: -1,
          pointerEvents: 'none',
          transition: 'opacity 200ms ease',
        }}
      />
    </>
  );
}
