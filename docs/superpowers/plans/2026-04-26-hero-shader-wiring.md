# Hero shader wiring — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the staged WebGL plasma shader behind the hero so it paints on both themes, fades out on scroll past the hero, respects reduced-motion, varies subtly between visits, and exposes a calm/vivid intensity toggle through the existing command palette.

**Architecture:** Edit `public/hero-shader.js` to expose palette uniforms, add a per-mount phase seed, and fade the vignette to the deep color instead of black. Add a `'use client'` React wrapper that loads the script via `next/script`, mounts on a fixed-positioned canvas, swaps the palette on theme change, applies the calm/vivid factor from a small `lib/plasma-bus.ts` (localStorage + custom event), and tapers opacity by scroll position. Render the wrapper from `app/layout.tsx` so the canvas sits at `z-index: -1` behind every page. Add two commands to the existing palette to drive the bus.

**Tech Stack:** Next.js 15 (App Router, static export), React 19, `next-themes`, vanilla WebGL1.

**Spec:** `docs/superpowers/specs/2026-04-26-hero-shader-wiring-design.md`

**Verification context:** A dev server is already running at `http://localhost:3000` (background task `bc6ndfvll`). All verification is browser-based; this work has no automated tests by design (see spec § Testing).

**Note on `pnpm` in the harness shell:** the project's `pnpm` invocations spawn a cmd.exe child that doesn't see `node` on PATH, so any verification scripts run via this tool must invoke node directly: `"/c/Program Files/nodejs/node" node_modules/typescript/bin/tsc --noEmit` or `"/c/Program Files/nodejs/node" --check public/hero-shader.js`. Not relevant inside a normal terminal.

---

## File map

- **Modify** `public/hero-shader.js` — palette uniforms, vignette mode swap, per-mount phase seed.
- **Create** `lib/plasma-bus.ts` — localStorage-backed pub/sub for the calm/vivid mode.
- **Modify** `lib/commands.ts` — add `plasma` action type and two commands.
- **Modify** `components/command-palette.tsx` — add `case 'plasma'` to the `runAction` switch.
- **Create** `components/hero-shader.tsx` — React client wrapper (script load + mount + theme swap + plasma-bus subscription + scroll fade + cleanup).
- **Modify** `components/hero.tsx:8` — add `data-hero-region` attribute to the existing `<section>`.
- **Modify** `app/layout.tsx` — render `<HeroShader />` as the first child of `<ThemeProvider>`.

Task ordering: Task 1 and Task 2 are independent. Task 3 imports from Task 2's output. Task 4 imports from Task 2 and depends on Task 1's API. Task 5 wires the wrapper into the layout and is the only task with browser verification.

---

### Task 1: Edit shader for dynamic palette + per-mount seed

**Files:**
- Modify: `public/hero-shader.js`

- [ ] **Step 1: Replace the fragment shader source**

The whole `FRAG` template literal in `public/hero-shader.js` becomes:

```js
  const FRAG = `
    precision highp float;
    uniform vec2  uRes;
    uniform float uTime;
    uniform vec2  uMouse;
    uniform float uClick;
    uniform vec2  uClickPos;
    uniform float uIntensity;
    uniform float uGrain;
    uniform float uSpeed;
    uniform float uSeed;
    uniform vec3  uDeep;
    uniform vec3  uMid;
    uniform vec3  uAccent;

    #define PI 3.14159265359

    float hash21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }

    void main(){
      vec2 uv = gl_FragCoord.xy / uRes.xy;
      vec2 p = (uv - 0.5);
      p.x *= uRes.x/uRes.y;

      float t = uTime * 0.6 * uSpeed;

      float v = 0.0;
      for(int i=0;i<4;i++){
        float fi = float(i);
        vec2 s = vec2(cos(t*0.4 + fi*1.7 + uSeed), sin(t*0.5 + fi*2.3 + uSeed*1.3)) * 0.35;
        v += sin(length(p - s)*14.0 - t*2.0 + fi);
      }

      vec2 m = uMouse;
      m.x = (m.x - 0.5) * (uRes.x/uRes.y);
      m.y -= 0.5;
      v += sin(length(p - m)*22.0 - t*3.0) * 1.4;

      vec2 cp = vec2((uClickPos.x-0.5)*uRes.x/uRes.y, uClickPos.y-0.5);
      v += sin(length(p - cp)*30.0 - uTime*8.0) * uClick * 1.6;

      v /= 6.0;

      float a = 0.5 + 0.5*sin(v*PI*2.0 + t);
      float b = 0.5 + 0.5*cos(v*PI*2.0 - t*0.7);

      vec3 col = mix(uDeep, uMid, a);
      col = mix(col, uAccent, pow(b, 3.0) * 0.85 * uIntensity);
      col += exp(-length(p-m)*length(p-m)*10.0) * uAccent * 0.2 * uIntensity;

      vec2 q = uv - 0.5;
      col = mix(uDeep, col, smoothstep(0.95, 0.25, dot(q,q)));

      float n = hash21(uv*uRes + uTime*60.0) - 0.5;
      col += n * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `;
```

Changes from the prior version: three new vec3 uniforms (`uDeep`, `uMid`, `uAccent`), one new float uniform (`uSeed`), removed `uHue`, removed the `hueShift(...)` helper, vignette uses `mix(uDeep, col, ...)` instead of multiplying, and the wave emitter phases now include `+ uSeed` and `+ uSeed*1.3`.

- [ ] **Step 2: Update the uniform-locations array in `mount()`**

Find:

```js
    ['uRes','uTime','uMouse','uClick','uClickPos','uIntensity','uGrain','uHue','uSpeed']
      .forEach(k => u[k] = gl.getUniformLocation(prog, k));
```

Replace with:

```js
    ['uRes','uTime','uMouse','uClick','uClickPos','uIntensity','uGrain','uSpeed','uSeed','uDeep','uMid','uAccent']
      .forEach(k => u[k] = gl.getUniformLocation(prog, k));
```

- [ ] **Step 3: Update state defaults in `mount()`**

Find:

```js
    const state = {
      intensity: opts.intensity ?? 0.55,
      speed:     opts.speed     ?? 0.35,
      grain:     opts.grain     ?? 0.012,
      hue:       opts.hue       ?? 18,
      mouse: [0.5, 0.5],
      click: 0,
      clickPos: [0.5, 0.5],
    };
```

Replace with:

```js
    const state = {
      intensity: opts.intensity ?? 0.55,
      speed:     opts.speed     ?? 0.35,
      grain:     opts.grain     ?? 0.012,
      seed:      opts.seed      ?? 0,
      deep:   opts.deep   ?? [0.02, 0.025, 0.035],
      mid:    opts.mid    ?? [0.06, 0.09, 0.14],
      accent: opts.accent ?? [0.95, 0.72, 0.35],
      mouse: [0.5, 0.5],
      click: 0,
      clickPos: [0.5, 0.5],
    };
```

The default `deep`/`mid`/`accent` are the prior hardcoded values (with the prior `hue=18` shift baked into `accent` so `mount(canvas)` with no opts still looks identical to before). `seed` defaults to `0` — same.

- [ ] **Step 4: Update per-frame uniform writes in `frame()`**

Find:

```js
      gl.uniform1f(u.uIntensity, state.intensity);
      gl.uniform1f(u.uGrain, state.grain);
      gl.uniform1f(u.uHue, state.hue);
      gl.uniform1f(u.uSpeed, state.speed);
```

Replace with:

```js
      gl.uniform1f(u.uIntensity, state.intensity);
      gl.uniform1f(u.uGrain, state.grain);
      gl.uniform1f(u.uSpeed, state.speed);
      gl.uniform1f(u.uSeed, state.seed);
      gl.uniform3fv(u.uDeep, state.deep);
      gl.uniform3fv(u.uMid, state.mid);
      gl.uniform3fv(u.uAccent, state.accent);
```

- [ ] **Step 5: Verify the file parses as JavaScript**

Run: `"/c/Program Files/nodejs/node" --check public/hero-shader.js`
Expected: no output (exit 0). Any parse error means a typo in one of the previous steps.

- [ ] **Step 6: Commit**

```bash
git add public/hero-shader.js
git commit -m "Hero shader · palette to uniforms + vignette to deep + per-mount seed"
```

---

### Task 2: Create the plasma-bus

**Files:**
- Create: `lib/plasma-bus.ts`

- [ ] **Step 1: Write the bus**

Create `lib/plasma-bus.ts` with:

```ts
export type PlasmaMode = 'calm' | 'vivid';

const STORAGE_KEY = 'plasma-mode';
const EVENT = 'plasma:mode';

export function getPlasmaMode(): PlasmaMode {
  if (typeof window === 'undefined') return 'vivid';
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'calm' ? 'calm' : 'vivid';
}

export function setPlasmaMode(mode: PlasmaMode) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

export function onPlasmaModeChange(handler: (mode: PlasmaMode) => void) {
  if (typeof window === 'undefined') return () => {};
  const wrapped = (e: Event) => handler((e as CustomEvent<PlasmaMode>).detail);
  window.addEventListener(EVENT, wrapped);
  return () => window.removeEventListener(EVENT, wrapped);
}
```

Mirrors `lib/palette-bus.ts`. SSR-safe via the `typeof window` guards. `getPlasmaMode` defaults to `'vivid'` for first-time visitors.

- [ ] **Step 2: Type-check**

Run: `"/c/Program Files/nodejs/node" node_modules/typescript/bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/plasma-bus.ts
git commit -m "Plasma bus · localStorage + custom event for calm/vivid"
```

---

### Task 3: Wire the calm/vivid commands into the palette

**Files:**
- Modify: `lib/commands.ts`
- Modify: `components/command-palette.tsx`

- [ ] **Step 1: Extend `CommandAction` and add the commands**

In `lib/commands.ts`, find the `CommandAction` type:

```ts
export type CommandAction =
  | { type: 'navigate'; href: string }
  | { type: 'external'; href: string }
  | { type: 'download'; href: string; filename?: string }
  | { type: 'theme'; value: 'light' | 'dark' | 'system' }
  | { type: 'copy'; value: string }
  | { type: 'whoami' }
  | { type: 'help' };
```

Replace with:

```ts
export type CommandAction =
  | { type: 'navigate'; href: string }
  | { type: 'external'; href: string }
  | { type: 'download'; href: string; filename?: string }
  | { type: 'theme'; value: 'light' | 'dark' | 'system' }
  | { type: 'copy'; value: string }
  | { type: 'whoami' }
  | { type: 'help' }
  | { type: 'plasma'; value: 'calm' | 'vivid' };
```

In the same file, find the `commands` array and the `Meta` group section (currently ends at the `help` command, line ~40). Add these two entries at the end of the Meta block — before the `// Theme` comment:

```ts
  { id: 'plasma-calm',  label: 'plasma calm',  group: 'Meta', arrow: '◌', hint: 'low intensity',     action: { type: 'plasma', value: 'calm'  }, keywords: ['shader', 'background'] },
  { id: 'plasma-vivid', label: 'plasma vivid', group: 'Meta', arrow: '●', hint: 'default intensity', action: { type: 'plasma', value: 'vivid' }, keywords: ['shader', 'background'] },
```

The result should look like:

```ts
  { id: 'whoami', label: 'whoami', group: 'Meta', arrow: '?', hint: 'inline', action: { type: 'whoami' } },
  { id: 'help', label: 'help', group: 'Meta', arrow: '?', hint: 'shortcut keys', action: { type: 'help' } },
  { id: 'plasma-calm',  label: 'plasma calm',  group: 'Meta', arrow: '◌', hint: 'low intensity',     action: { type: 'plasma', value: 'calm'  }, keywords: ['shader', 'background'] },
  { id: 'plasma-vivid', label: 'plasma vivid', group: 'Meta', arrow: '●', hint: 'default intensity', action: { type: 'plasma', value: 'vivid' }, keywords: ['shader', 'background'] },

  // Theme
```

- [ ] **Step 2: Handle the action in `command-palette.tsx`**

In `components/command-palette.tsx`, add this import near the existing `palette-bus` import:

```ts
import { setPlasmaMode } from '@/lib/plasma-bus';
```

Find the `runAction` `switch (cmd.action.type)` block. Add this case before the closing brace of the switch (after `case 'help':`):

```ts
        case 'plasma':
          setPlasmaMode(cmd.action.value);
          close();
          break;
```

- [ ] **Step 3: Type-check**

Run: `"/c/Program Files/nodejs/node" node_modules/typescript/bin/tsc --noEmit`
Expected: no errors. The discriminated union on `CommandAction` should narrow `cmd.action.value` to `'calm' | 'vivid'` automatically inside the case body.

- [ ] **Step 4: Commit**

```bash
git add lib/commands.ts components/command-palette.tsx
git commit -m "Command palette · plasma calm/vivid commands"
```

---

### Task 4: Create the React wrapper

**Files:**
- Create: `components/hero-shader.tsx`

- [ ] **Step 1: Write the component**

Create `components/hero-shader.tsx` with:

```tsx
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

  // Re-apply when theme changes (handle may not exist yet — onLoad covers first paint)
  useEffect(() => {
    if (handleRef.current) applyState(handleRef.current, resolvedTheme, modeRef.current);
  }, [resolvedTheme]);

  // Subscribe to plasma-bus
  useEffect(() => {
    modeRef.current = getPlasmaMode();
    if (handleRef.current) applyState(handleRef.current, resolvedTheme, modeRef.current);
    const unsub = onPlasmaModeChange((mode) => {
      modeRef.current = mode;
      if (handleRef.current) applyState(handleRef.current, resolvedTheme, mode);
    });
    return unsub;
  }, [resolvedTheme]);

  // Scroll fade
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

  // Tear down WebGL on unmount
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
          // Read persisted plasma mode BEFORE mount so the very first frame uses the right factor.
          modeRef.current = getPlasmaMode();
          handleRef.current = window.HeroShader.mount(canvasRef.current, {
            seed: Math.random() * 6.2831853, // 2π — unique drift trajectory per visit
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
```

Notes for the implementer:
- `applyState` is the single point of truth for "what should the shader look like right now." Theme effect, plasma-bus effect, and `onLoad` all funnel through it.
- Reduced-motion check lives inside `applyState` and runs AFTER any palette/intensity change, so a user toggling `plasma vivid` while reduced-motion is set won't re-enable motion.
- `modeRef` (not state) holds the current plasma mode — we don't need a re-render when it changes, only a shader update.
- `pointerEvents: 'none'` is critical — without it the fixed canvas would intercept clicks meant for the page below.

- [ ] **Step 2: Type-check**

Run: `"/c/Program Files/nodejs/node" node_modules/typescript/bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/hero-shader.tsx
git commit -m "Hero shader · client wrapper with theme + plasma-bus + scroll + a11y"
```

---

### Task 5: Layout integration, hero region attribute, and browser verification

**Files:**
- Modify: `components/hero.tsx`
- Modify: `app/layout.tsx`

- [ ] **Step 1: Add `data-hero-region` to the hero section**

In `components/hero.tsx`, find:

```tsx
    <section className="relative mx-auto max-w-[1600px] px-6 pt-16 pb-20 lg:px-16 lg:pt-24 lg:pb-28">
```

Replace with:

```tsx
    <section data-hero-region className="relative mx-auto max-w-[1600px] px-6 pt-16 pb-20 lg:px-16 lg:pt-24 lg:pb-28">
```

- [ ] **Step 2: Render `<HeroShader />` in the root layout**

In `app/layout.tsx`, find the import block:

```tsx
import { ThemeProvider } from '@/components/theme-provider';
import { Nav } from '@/components/nav';
import { Footer } from '@/components/footer';
import { Gridlines } from '@/components/gridlines';
import { Grain } from '@/components/grain';
```

Add a new import line below the `Grain` import:

```tsx
import { HeroShader } from '@/components/hero-shader';
```

Then find the `ThemeProvider` block:

```tsx
        <ThemeProvider>
          <Gridlines />
          <Grain />
          <Nav />
          <main className="relative z-10 pt-20">{children}</main>
          <Footer />
          <CommandPaletteLazy />
        </ThemeProvider>
```

Replace with:

```tsx
        <ThemeProvider>
          <HeroShader />
          <Gridlines />
          <Grain />
          <Nav />
          <main className="relative z-10 pt-20">{children}</main>
          <Footer />
          <CommandPaletteLazy />
        </ThemeProvider>
```

- [ ] **Step 3: Type-check**

Run: `"/c/Program Files/nodejs/node" node_modules/typescript/bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Browser verification at http://localhost:3000**

Implementer note: a dev server is already running. Walk through every check below before step 5. If any check fails, fix the underlying issue (or report DONE_WITH_CONCERNS if the fix isn't obvious) — do NOT commit a broken state.

- **Default load (dark theme).** A subtle plasma is visible behind the hero text and the system monitor panel. The headline "Senior engineer." is fully legible. Corners fade toward `#0F0F0F`, not pure black.
- **Theme toggle.** Use the existing toggle in the nav. The shader palette swaps live (cream + rust replace near-black + amber). No flash of wrong palette. Body text remains comfortable to read against the brightest plasma spots — if it doesn't, lower light-mode `intensity` from `0.32` toward `0.25` in `components/hero-shader.tsx` and re-check.
- **Plasma calm/vivid.** Open the command palette (`/` or `cmd+K`). Run `plasma calm` — the plasma noticeably softens. Run `plasma vivid` — back to default. Reload the page — last chosen mode persists.
- **Reduced-motion takes precedence.** With reduced-motion enabled (DevTools → Rendering → emulate `prefers-reduced-motion: reduce`), running `plasma vivid` does NOT re-enable drift or jump to full intensity. Plasma stays static.
- **Scroll fade.** Scroll down past the hero. Canvas opacity tapers smoothly to 0 by the time the work section is in view. Scrolling back up brings it back.
- **Per-mount randomness.** Hard-reload the page (Ctrl+Shift+R) two or three times. The plasma drift trajectories should look subtly different each time.
- **Console.** No errors, no warnings about WebGL or hydration mismatches.
- **Click-through.** Click "View work" and "download_cv.pdf" in the hero. Both still work — the canvas isn't intercepting events.

- [ ] **Step 5: Commit**

```bash
git add app/layout.tsx components/hero.tsx
git commit -m "Hero shader · render behind the hero with scroll-out fade"
```

---

## Spec coverage check

Mapping spec requirements to tasks:

- Atmospheric shader behind the hero on both themes → Task 1 (palette uniforms) + Task 4 (theme swap) + Task 5 (layout render).
- Vignette fades to bg, not black → Task 1 step 1.
- `next-themes` palette handoff → Task 4 (`applyState` + `resolvedTheme` effect).
- `prefers-reduced-motion` respected; reduced-motion overrides calm/vivid → Task 4 (`applyState` runs reduced-motion last).
- Per-mount randomness → Task 1 (`uSeed` uniform) + Task 4 (`Math.random() * 2π` in `onLoad`).
- Calm/vivid via command palette, persisted → Task 2 (bus) + Task 3 (palette commands) + Task 4 (subscription + factor).
- Scroll fade out below hero → Task 4 (scroll-fade effect) + Task 5 (`data-hero-region` attribute).
- z-stacking: canvas at `-1`, gridlines `0`, grain `1`, main `10` → Task 4 (canvas inline style) + Task 5 (render order).
- No FCP impact → Task 4 (`next/script` `afterInteractive`).
- Static export compatibility → no changes to `next.config.mjs`; `next/script` afterInteractive works in static export, file lives in `public/`.
- First-paint correct mode → Task 4 (read `getPlasmaMode()` BEFORE first `applyState` in `onLoad`).
- Manual verification → Task 5 step 4.

No gaps.

---

## Out of scope (per spec)

- Other shader presets (aurora, field, lattice, caustics).
- Stopping the WebGL RAF when the canvas opacity hits 0 (a perf follow-up if it ever matters).
- Subscribing to `MediaQueryList` changes for runtime reduced-motion toggles.
- A "current mode" badge on the plasma commands in the palette.
