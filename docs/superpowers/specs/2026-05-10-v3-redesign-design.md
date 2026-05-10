# v3 Redesign — Design Spec (Brutalist/Terminal)

**Date:** 2026-05-10
**Domain:** arthur.buikis.com (custom domain on GitHub Pages)
**Owner:** Arthur Buikis
**Status:** Approved — see `docs/superpowers/plans/2026-05-10-v3-redesign.md` for implementation

**Reference prototype:** `arthur-site-v3.1.html` (project root)

---

## 1. Design Philosophy

Brutalist/terminal hybrid. The site reads like a developer's terminal — monospace body, serif headlines for authority, 2px hard borders everywhere. No shadows, no gradients, no rounded corners (already the site's convention). The aesthetic is intentionally unpolished: loud typography, visible grid, confident ugliness.

**References:** Are.na, Yale Center for British Art, mschf, Read.cv, terminal emulators (iTerm2, Warp, Ghostty).

**Key departure from existing design:** The current site is editorial/minimal with Fraunces + Inter + gold accent. The redesign replaces:
- Fraunces → Times New Roman / Iowan Old Style
- Inter → monospace (IBM Plex Mono / JetBrains Mono)
- Gold accent → muted rust (`oklch(50% 0.14 22)` light / `oklch(55% 0.16 25)` dark)
- Subtle 1px rules → assertive 2px borders

---

## 2. Design Tokens

### 2.1 Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `oklch(96% 0.004 100)` | `oklch(12% 0.008 100)` | Page background |
| `--surface` | `oklch(100% 0 0)` | `oklch(8% 0.008 100)` | Card / input backgrounds |
| `--fg` | `oklch(15% 0.02 100)` | `oklch(90% 0.004 100)` | Primary text + borders |
| `--muted` | `oklch(40% 0.02 100)` | `oklch(65% 0.008 100)` | Secondary text |
| `--border` | `oklch(15% 0.02 100)` | `oklch(90% 0.004 100)` | All borders (same as `--fg`) |
| `--accent` | `oklch(50% 0.14 22)` | `oklch(55% 0.16 25)` | Accent (muted rust) |
| `--scan` | `oklch(0% 0 0 / 0.04)` | `oklch(100% 0 0 / 0.02)` | Scan-line overlay |

### 2.2 Typography

| Role | Font stack | Weight | Size | Line height |
|---|---|---|---|---|
| Display (h1-h3) | `'Times New Roman', 'Iowan Old Style', Georgia, serif` | 400 | `clamp(48px, 8vw, 120px)` → `clamp(28px, 4.5vw, 56px)` | 0.92–1.0 |
| Body | `ui-monospace, 'IBM Plex Mono', 'JetBrains Mono', Menlo, monospace` | 400 | 16px base, 13px for cards | 1.6 |
| Mono / meta | Same as body | 400 | 10–12px | 1.4 |
| Tags | Same as body | 400 | 9px uppercase | 1.3 |

### 2.3 Spacing & Layout

- Base unit: 4px
- Section padding: 40px vertical mobile → 80px desktop
- Max content width: 1280px
- Asymmetric grid: `3fr 1fr` for content + sidebar
- Project grid: `repeat(auto-fill, minmax(300px, 1fr))`
- Stack grid: `repeat(auto-fill, minmax(240px, 1fr))`
- Stat grid: `repeat(auto-fit, minmax(130px, 1fr))` with 2px gap

### 2.4 Borders

- **All borders:** 2px solid `var(--border)`
- **No radius:** enforced globally (`* { border-radius: 0 !important; }`) — already the case
- **No shadows:** not used anywhere in the v3.1 design

### 2.5 Motion

| Token | Value | Use |
|---|---|---|
| Page transition | 350ms fade + 8px translate | Route changes |
| Scroll-reveal | 500ms per item, 80ms stagger | Section entries |
| Typewriter | 80ms per char, 1500ms pause per phrase | Command bar |
| Count-up | 800ms ease-out | Stats |
| Pulse ring | 2s infinite (CSS animation) | Live timeline dot |
| Cursor blink | 1s step-end infinite | Terminal prompts |
| Border hover | 200ms | Card, button, link borders |

All motion disabled under `prefers-reduced-motion: reduce`.

---

## 3. Page Layouts

### 3.1 `/` Home

1. **Nav** — sticky, `--bg` background, 2px bottom border
   - Left: `ab.` with accent dot on `b`
   - Right: uppercase mono links, active state = filled `--fg` bg + `--bg` text
   - Mobile: hamburger → fullscreen overlay with large serif links
2. **Hero** — no shader backdrop (shader still renders on home via `[data-hero-region]` but the hero layout is clean)
   - Dark mode: `$ whoami --verbose` mono prompt line
   - Large serif headline: "Arthur Buikis" split across two lines
   - Subhead: job title + city
   - Summary: one-line bio
   - **Stat grid:** 4 cells (years, contracts, Py/Rust, Riga) with count-up animation
   - **Typewriter command bar:** cycles through phrases, click opens palette
3. **About snippet** — asymmetric layout, serif drop-cap, "What I do" mono bullets
4. **Featured work** — single large card for Lethub/scraping/ML case study
5. **Building teaser** — compact card with status callout
6. **Footer** — compact monospace, bordered social tiles, 2px top border

### 3.2 `/about`

- **Timeline:** 2px left-accent line with 16px dots. Live dot = accent fill + pulse ring animation
- **Stack grid:** bordered group blocks, mono items, italic notes
- **Beliefs / Anti-list:** mono text with `→` accent bullets, bottom-border separated
- **Sidebar:** "At a glance" bordered block, sticky

### 3.3 `/cv`

- **Headline:** serif `Curriculum Vitae` + PDF download link
- **Experience:** 2px card borders per role, mono meta tags, bullet points
- **Side projects:** card grid, same format
- **Languages:** mono inline block with border

### 3.4 `/work/[slug]`

- MDX-rendered case study
- Serif headings, monospace body (not Inter — monospace)
- 2px accent left border on callouts
- 2px bordered code blocks

### 3.5 `/building`

- Asymmetric layout: 3fr content + 1fr sidebar
- Status callout with 2px accent border
- Mono labels throughout, serif section headings

### 3.6 `/contact`

- Form with 2px bordered inputs (already inherits from globals)
- Social links as bordered tile buttons
- Direct contact card sidebar (sticky)

### 3.7 `/notes`

- Card-based post list with 2px borders
- Mono date + serif title
- Subscribe form with 2px border

### 3.8 `/snake`

- Full-page snake game (already exists — no visual changes needed beyond new accent color)

---

## 4. Signature Visual Elements

### 4.1 Scan-line overlay
Fixed `::after` pseudo-element on `body`:
```css
background: repeating-linear-gradient(
  0deg,
  transparent,
  transparent 2px,
  var(--scan) 2px,
  var(--scan) 4px
);
```
Pointer-events none, z-index 9999. Only visible on desktop (subtlest at 4px cycle).

### 4.2 Dot-grid texture
Fixed `::before` or separate component:
```css
background-image: radial-gradient(circle, var(--border) 1px, transparent 1px);
background-size: 24px 24px;
```
Opacity 0.04–0.06. Pointer-events none.

### 4.3 Typewriter command bar
Home page widget cycling through phrases:
```
backend · platform · rust
observability > tests
ships systems that don't break
Riga · remote · EU time
```
80ms per character, 1500ms display pause, backspace at 30ms/char. Click opens command palette.

### 4.4 Pulse ring on live dot
```css
@keyframes pulse-ring {
  0% { box-shadow: 0 0 0 0 var(--accent); }
  70% { box-shadow: 0 0 0 8px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
```

### 4.5 Command palette overlay
- Dark backdrop `oklch(0% 0 0 / 0.88)`
- Panel: `--bg` bg, 2px `--border` border
- `$` prompt with cursor blink
- Grouped results: accent left-border on selection, `color-mix` tinted bg
- Footer key hints

---

## 5. What Stays the Same

| Feature | Status | Reason |
|---|---|---|
| Route structure | Unchanged | All routes work identically |
| MDX content pipeline | Unchanged | `content/work/*.mdx`, `content/building/index.mdx` |
| Command palette behavior | Unchanged | Keyboard, fuzzy-search, all actions |
| Snake game | Unchanged | Only accent color changes (CSS var) |
| Hero shader | Unchanged | Route-gating, dark/light palettes |
| Theme provider | Unchanged | next-themes, class strategy |
| Theme toggle | Unchanged | Icon button, position |
| Contact form + Formspree | Unchanged | Form logic, endpoint |
| Build/deploy pipeline | Unchanged | static export, GitHub Pages |
| Content modules | Unchanged | `site.ts`, `cv.ts`, `about.ts` |

## 6. What Changes

| Component | Change |
|---|---|
| `app/globals.css` | Complete token rewrite |
| `components/nav.tsx` | Brand, link styles, mobile overlay |
| `components/hero.tsx` | Typewriter, stat grid, no monitor |
| `components/footer.tsx` | Compact monospace, bordered socials |
| `components/grain.tsx` | Replaced by scan-line + dot-grid |
| `components/scroll-reveal.tsx` | Timing adjustment |
| `components/command-palette.tsx` | Visual-only (terminal borders, blink) |
| `mdx-components.tsx` | Body font to monospace, borders to 2px |
| All page components | Wrapped in scroll-reveal where missing |

## 7. Removed

| Component | Replaced by |
|---|---|
| `components/snapshot.tsx` | Stats merged into hero component |
| `components/cta-section.tsx` | Footer + contact page |
| `components/hero-monitor.tsx` | Stat grid in hero |
| `components/gridlines.tsx` | Dot-grid background (or keep if non-conflicting) |
