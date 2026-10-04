// Quality tiers. `low` for phones, ≤4-core machines and coarse pointers; `high` otherwise.
// `?q=low|high` overrides. Settings are fixed for the session (no runtime recompiles).
// `antialias` is the canvas MSAA flag and a context attribute (fixed at creation): B4 sets it false
// on any tier whose post chain renders the scene into its own targets (they bring their own AA).

import type { Quality, QualitySettings } from './contracts';

export function detectQuality(search: string): Quality {
  const q = new URLSearchParams(search).get('q');
  if (q === 'low' || q === 'high') return q;
  if (typeof window === 'undefined') return 'high';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  return coarse || cores <= 4 || mem <= 4 ? 'low' : 'high';
}

export const QUALITY: Record<Quality, QualitySettings> = {
  high: { maxDpr: 2, shadowMapSize: 2048, terrainDetail: 6, antialias: true, density: 1, post: true },
  low: { maxDpr: 1.5, shadowMapSize: 1024, terrainDetail: 6, antialias: false, density: 0.45, post: false },
};
