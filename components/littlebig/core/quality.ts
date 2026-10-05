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

/**
 * The session's settings: the tier's, with `low` on a coarse pointer (a phone or tablet, DPR 2-3)
 * capped at DPR 1.25: −30 % pixels against 1.5 for a frame that is mostly flat toon colour and ink.
 */
export function qualitySettings(quality: Quality): QualitySettings {
  const q = QUALITY[quality];
  const coarse = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
  return quality === 'low' && coarse ? { ...q, maxDpr: Math.min(q.maxDpr, 1.25) } : q;
}

// high caps DPR at 1.5: the frame cost is mostly per pixel (the post chain runs at full resolution),
// so DPR 2 on a retina laptop doubled it (1280×800: 15 → 33 ms over the city) for edges FXAA and the
// ink line already keep clean. The engine also steps the ratio down (adaptive resolution) when
// frames are missed (down to 0.85, core/engine.ts `adaptResolution`).
export const QUALITY: Record<Quality, QualitySettings> = {
  high: { maxDpr: 1.5, shadowMapSize: 2048, terrainDetail: 6, antialias: false, density: 1, post: true },
  low: { maxDpr: 1.5, shadowMapSize: 1024, terrainDetail: 5, antialias: false, density: 0.45, post: false },
};
