# Hero shader redesign — design

Issue: [#25 Change hero shader](https://github.com/Artufe/Arts-site/issues/25)

The current hero shader is a muted dark-amber plasma that — per the issue — feels boring in motion and ugly when static (reduced-motion users see a muddy gradient with one stray smudge of orange). This spec captures four candidate directions, mood-references them via `@grok-imagine`, and lands one of them.

## Constraints carried over from today

- Full-bleed `<canvas>` at `z-index: -1`, fixed to viewport.
- Opaque card surfaces (`--card`, `--bg-muted` dark) stay opaque — the canvas paints behind them. Don't reintroduce alpha.
- Route-gated via `SHADER_EXCLUDED_ROUTES` (`/cv`, `/contact`, `/snake`).
- Scroll fade tied to `[data-hero-region]` — opacity goes 0 by the time the hero scrolls out.
- Reduced motion: render exactly one static frame; the static frame must look composed, not muddy.
- Plasma bus (`calm` / `vivid`) still toggleable via the command palette.
- Theme-aware: dark default, light variant with lower intensity.
- Hard-edged aesthetic (no rounded corners, no soft halos as the only feature).

## Candidate directions

### A — Aurora curtains
Slow vertical drifts of teal / violet / cool-green; nordic, calm, composed even when static. Cooler palette than today; subtle warm spark survives as the dark-mode accent.

### B — Blueprint / topo flow
Animated topographic contour lines over a faint engineering grid (32px); cyan or cool-amber on near-black. Matches the hard-edged design language and the senior-engineer identity.

### C — Punchy plasma 2.0
Keep the orbiting-wave-source technique but reset the palette: deep indigo base + hot magenta + warm orange accent. Minimal architectural change, maximal mood change.

### D — Starfield drift
Hundreds of slow-drifting points with a soft mouse-warp; minimalist, ambient, looks intentional even when fully static. Hard-edged compatible because it's points-on-black rather than blurry gradients.

## Mood references

Generated in this PR via `@grok-imagine` — see PR comments.

## Decision

**B — Blueprint / topo flow.** It's the only direction that fits the existing hard-edged, terminal-with-scanlines aesthetic; it lets us keep the warm amber accent as a recognizable continuity signal; and it's the most composed when fully static, which is the explicit complaint in the issue. A goes too soft; C is too loud and organic; D is minimal but generic.

## Implementation

Single-file shader rewrite — palette plumbing in `components/hero-shader.tsx` and the fragment shader in `public/hero-shader.js`. Behavior:

- **Contour field** — two octaves of value-noise FBM, slightly domain-warped, evolved by `uTime`. Render contours via `fract(field * BANDS)` with `fwidth`-based AA so lines stay crisp at any DPR.
- **Grid underlay** — 64px engineering grid; just bright enough to read on dark mode, suppressed almost entirely in light mode (`gridIntensity` token).
- **Accent crests** — narrow exponential falloff where `field` peaks, painted in `uAccent` (kept warm amber so we don't throw away brand continuity).
- **Mouse interaction** — warps the noise locally toward the cursor; click drops a transient ring centered on the click point. Both use the same uniforms the old shader exposed, so no JS surgery beyond renaming.
- **Reduced motion** — `uSpeed = 0` already paints a single static frame; with the new shader that frame is a composed grid + contour map (not a muddy gradient).
- **Plasma bus / theme** — `calm` halves accent + contour intensity; light mode swaps to near-white deep, cool-grey mid, low-saturation amber accent, lower overall intensity.

## Out of scope

- Replacing WebGL with CSS-only effects (current setup is fine; we're changing the visual, not the tech).
- Touching the route gating, plasma bus, or scroll-fade plumbing.
- Re-tuning light mode beyond per-direction palette parity.
