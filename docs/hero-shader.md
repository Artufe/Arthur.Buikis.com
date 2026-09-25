# Hero shader

The animated plasma background behind the home hero. Two pieces:

| File | Role |
| --- | --- |
| `public/hero-shader.js` | Framework-free WebGL script. Exposes `window.HeroShader.mount()`. Owns the fragment shader, render loop, pointer/touch input, and pause/reduced-motion handling. |
| `components/hero-shader.tsx` | React wrapper mounted once in `app/layout.tsx`. Loads the script via `next/script`, picks a palette for the current theme, applies the calm/vivid mode, fades the canvas out on scroll, and skips excluded routes. |

## What it draws

Four wave sources orbit slowly and interfere; the cursor is a fifth emitter; clicks and taps drop ringed pulses that decay. Colour is a mix of `deep` → `mid` with `accent` in the highlights, finished with a vignette and a touch of film grain.

## Script API

```ts
HeroShader.mount(canvas, options?) → { set(partial), stop() }
```

| option | standalone default | notes |
| --- | --- | --- |
| `intensity` | `0.55` | how much `accent` bleeds into highlights |
| `speed` | `0.35` | time multiplier; `0` freezes the motion |
| `grain` | `0.012` | film-grain amplitude |
| `seed` | `0` | phase offset so each mount looks different |
| `deep` | `[0.02, 0.025, 0.035]` | background / vignette colour (linear RGB 0–1) |
| `mid` | `[0.06, 0.09, 0.14]` | midtone |
| `accent` | `[0.95, 0.72, 0.35]` | highlight colour |

- `.set(partial)` merges new values into the live state. When the animation is stopped (reduced motion), it re-renders a single static frame.
- `.stop()` cancels the RAF loop and removes every listener.
- Input listeners live on `window`, so the shader still reacts when the cursor is over hero text.
- If WebGL is unavailable, `mount` logs a warning and returns no-op `set`/`stop`.

## How the site configures it

All tunables are at the top of `components/hero-shader.tsx`:

| constant | value | effect |
| --- | --- | --- |
| `PALETTES.dark` | `#0F0F0F` / `#1A1F2E` / `#FFB84D`, intensity `0.30` | dark-theme colours |
| `PALETTES.light` | `#F7F5F1` / `#EBE5DE` / `#B25C0D`, intensity `0.18` | light-theme colours |
| `BASE_SPEED` | `0.18` | passed on mount |
| `BASE_GRAIN` | `0.006` | passed on mount |
| `CALM_FACTOR` | `0.55` | intensity multiplier in `calm` mode |
| `PEAK_OPACITY` | `0.7` | canvas opacity at the top of the page |
| `SHADER_EXCLUDED_ROUTES` | `/cv`, `/contact`, `/snake` | these routes (and their children) render no shader |

These colours are hard-coded for the shader. They are separate from the CSS `--accent` token in `app/globals.css`.

Behaviour:

- **Theme:** `resolvedTheme` from `next-themes` selects the palette; changing theme re-applies it live.
- **Calm / vivid:** the command palette's `plasma calm` / `plasma vivid` commands go through `lib/plasma-bus.ts`, which stores the choice in `localStorage` (`plasma-mode`) and emits `plasma:mode`. The component subscribes and scales intensity by `CALM_FACTOR`.
- **Scroll fade:** opacity goes from `PEAK_OPACITY` to `0` over the height of the element marked `[data-hero-region]` (the home hero `<section>`). Remove that attribute and the fade falls back to the viewport height.
- **Layering:** the canvas is `position: fixed; inset: 0; z-index: -1`, so it paints above the body background and behind everything else. Opaque surfaces hide it; translucent ones let it through.

## Performance

- One `TRIANGLE_STRIP` draw call per frame, no textures, no framebuffers.
- Device pixel ratio capped at 2.
- Rendering pauses while the canvas is off-screen (`IntersectionObserver`) or the tab is hidden (`visibilitychange`).

## Accessibility

- The canvas is `aria-hidden` and `pointer-events: none`.
- `prefers-reduced-motion: reduce` is handled on both sides. The script stops the loop and draws one static frame (redrawn on resize), and follows live changes to the media query. The React wrapper also sets `speed: 0` and clamps intensity to `0.18`.
