# Arts-site

Personal site for Arthur Buikis — Next.js 16 (App Router, Turbopack) + Tailwind v4 + MDX, statically exported to GitHub Pages on every push to `master`.

## Commands

```bash
pnpm dev            # local dev — wraps `next dev` via scripts/dev.mjs to force NODE_ENV=development
pnpm build          # static export → ./out, then scripts/postbuild.mjs (OG image rename)
pnpm typecheck      # tsc --noEmit (run before pushing)
pnpm test           # vitest run (tests/{app,components,content,lib}, components/**/*.spec.ts, .github/scripts)
pnpm test:e2e       # playwright (tests/e2e) — auto-starts `pnpm dev` unless :3000 is already up
```

There is no lint script (no ESLint config in the repo) and no `start` script (`next start` doesn't work with `output: 'export'`; use `npx serve out` to preview a build).

**Use pnpm.** `pnpm-lock.yaml` is the only lockfile (`package-lock.json` is gitignored). The pnpm version is pinned by `packageManager` in `package.json` (**pnpm 12**): a local pnpm 10+ or corepack switches to it automatically, and CI's `pnpm/action-setup` reads the same field, so there's no need to `npx pnpm@<n>`. CI runs **Node 24** (Active LTS) with `--frozen-lockfile`; vitest 5, jsdom 30 and pnpm 12 need Node ≥22. `pnpm-workspace.yaml` is committed and holds pnpm's settings (pnpm 11+ reads only auth/registry from `.npmrc`). pnpm's supply-chain defaults are on: versions published less than 24h ago aren't resolved (`minimumReleaseAge`), and dependency install scripts run only when `allowBuilds` says so (`esbuild` and `sharp` are deliberately `false`: they ship prebuilt binaries, and images are unoptimized). If an update fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, wait a day instead of relaxing the policy. A `node_modules` linked by a different pnpm major must be deleted before reinstalling.

## Layout

```
app/            Routes: / (page.tsx), about/, building/, play/, contact/, cv/, work/[slug]/,
                subscribe/, snake/, surf/, planet/,
                plus sitemap.ts, robots.ts, llms.txt/, llms-full.txt/, opengraph-image.tsx
components/     Page sections + global chrome; ui/ (Input, Textarea), mdx/ (MDX overrides),
                snake/ (three.js 3D snake game), goldenline/ (WebGPU surf demo),
                littlebig/ (three.js WebGL tiny-planet game), play/ (GameClip, GameCard,
                PlayMethod, GamePrefetch), floating-window.tsx (shared game window)
content/        site.ts, cv.ts, about.ts, play.ts (typed data) + work/*.mdx, building/*.mdx
lib/            Pure helpers: commands.ts (palette commands), fuzzy.ts, utils.ts (cn),
                and window-event buses: palette-bus, plasma-bus, snake-bus, surf-bus, planet-bus, ide-bus
public/         Static assets: CNAME, cv.pdf, favicons, site.webmanifest, hero-shader.js,
                play/ (game clips + posters)
scripts/        dev.mjs, postbuild.mjs, github-pulse.mjs (header stats), gen-icons.py (favicons),
                goldenline-shot.mjs (GOLDENLINE review shots / perf / boot timing), littlebig-shot.mjs
                (LITTLEBIG review shots / dive / perf / boot timing), glsl-minify.cjs (LITTLEBIG shader
                loader), play-media/
                (capture helpers for the /play clips), mcp/ (image server for the Claude bot)
docs/           hero-shader.md, play-media.md, goldenline/ (brief, agent task list, decisions, perf, assets),
                littlebig/ (brief, agent task list, decisions, perf)
tests/          vitest (app/, components/, content/, lib/) + playwright (e2e/)
.github/        workflows/, scripts/grok-imagine.mjs (PR image bot), agents/ (prompt library)
```

## Deploy

- PRs to `master` → `.github/workflows/ci.yml` runs typecheck, unit tests, and build.
- Push to `master` (and a daily 05:17 UTC schedule) → `deploy.yml` refreshes the GitHub pulse (`scripts/github-pulse.mjs`), builds with pnpm, copies `public/CNAME` into `./out`, deploys via `peaceiris/actions-gh-pages@v4` to the `gh-pages` branch. (Deploy does not run unit tests.)
- `next.config.mjs` sets `output: 'export'` + `trailingSlash: true` + `images.unoptimized: true`. **No SSR, no API routes, no `revalidate`** — anything dynamic must run client-side or at build time. Route handlers (`llms.txt`, `sitemap`, OG image) must be `force-static`.
- `scripts/postbuild.mjs` renames the extensionless `out/opengraph-image` to `.png` and rewrites references in the HTML, because GitHub Pages would serve it as `application/octet-stream`.
- `gh-pages` branch is auto-managed; never commit there directly.

## Push policy

Direct `git push origin master` is blocked by the harness ("bypasses pull request review"). For routine work, branch + `gh pr create`. The user can override case-by-case ("push anyway"); take that as scope-of-one approval, not a standing license.

## Global chrome (app/layout.tsx)

Mounted once for every route: `HeroShader`, `ScanLine` (dot grid), `RevealObserver`, `Nav` (with the GitHub pulse), `Footer`, `SnakeWindowHost`, `GoldenlineWindowHost`, `LittlebigWindowHost`, `CommandPaletteLazy`, `IdeOverlay`. Also emits Person + WebSite JSON-LD.

- **GitHub pulse** (`components/github-pulse.tsx`): the card beside the brand. It shows one bar per month for the last 12 months, with "hot" months (≥ 2× the average) in the accent, plus the headline numbers. The data is `content/github-pulse.json`: a committed snapshot that `deploy.yml` refreshes before every build, including the daily scheduled one, via `scripts/github-pulse.mjs` (GraphQL, falls back to the snapshot). Aggregation helpers live in `lib/github-pulse.ts`, which has no imports so the script can load it with Node's type stripping. The breakpoints in `globals.css` are measured: full card ≥ 1024px, bars only 820–1023, hidden 769–819, short copy on phones.
- **Command palette** (`components/command-palette*.tsx`, commands in `lib/commands.ts`) — opens on `/` or `Ctrl/⌘+K`. The lazy wrapper listens for the keys and idle-prefetches the real palette.
- **Snake** (`components/snake/`) — floating window opened via the palette (`snake-bus`), expandable to `/snake`. Engine (`engine/`) is pure and unit-tested; specs sit next to the code they cover.
- **GOLDENLINE** (`components/goldenline/`): a first-person golden-hour reef-break surf demo on three.js `WebGPURenderer` + TSL. The palette's `go surfing` opens it in a `FloatingWindow` (`surf-bus`), expandable to the full-viewport `/surf` (the nav hides there). WebGPU only: without it the canvas shows one line of text. One directory per system, wired in `systems.ts` against `core/contracts.ts`; the engine chunk loads only when opened. The lagoon, shore break and swash are one GPU shallow-water simulation (`ocean/surfzone/`, CPU reference + tests in `scheme.ts`); the reef breakers are `ocean/breaking/`. Start at `docs/goldenline/TASKS.md` and each system's README. Review with `node scripts/goldenline-shot.mjs` (headless Chromium with real WebGPU; `--shot`, `--seq`, `--perf`, `--boot`) against the dev server. F1 opens the settings/perf overlay. Per-agent evidence shots under `docs/goldenline/shots/` are gitignored except `milestones/`.
- **LITTLEBIG** (`components/littlebig/`): a tiny cartoon planet on three.js WebGL (not WebGPU, so it runs on phones and Safari). Orbit and spin it, then dive through the clouds to a street-level first-person walk: a seeded city with traffic, people, planes and balloons, and a day/night cycle. Everything is procedural, with zero asset downloads. The palette's `visit planet` opens it in a `FloatingWindow` (`planet-bus`), expandable to the full-viewport `/planet` (the nav hides there). The engine chunk loads only when opened; it is warmed on the palette keys and once a LITTLEBIG card or home tile is in view and its clip has a frame (`components/play/game-prefetch.tsx`). `/planet/` is in the sitemap and llms routes; its metadata (title, canonical) lives in `app/planet/layout.tsx` because the page is a client component. Start at `docs/littlebig/BRIEF.md` and `TASKS.md`. Review with `node scripts/littlebig-shot.mjs` (`--list`, `--shot`, `--dive`, `--perf`, `--boot`) against the dev server. F1 toggles a debug readout (altitude, position, frame time). Budgets and measurements live in `docs/littlebig/PERF.md`. Per-agent evidence shots under `docs/littlebig/shots/` are gitignored.
- **IDE overlay** (`components/ide-overlay.tsx`) — Zed-style "view source" easter egg built from `content/*` data. Opened by the header "open in zed" button, the footer `$EDITOR` link, or the palette (`ide-bus`).
- **Reveal** — elements with a bare `reveal` class start at opacity 0. `RevealObserver` adds `vis` on intersection (including nodes added by client navigation); `ScrollReveal` wraps sections on the home page.

## Hero shader

Full reference: `docs/hero-shader.md`.

- Route-gated in `components/hero-shader.tsx`. The component returns `null` for anything in `SHADER_EXCLUDED_ROUTES` (`/cv`, `/contact`, `/snake`, `/surf`, `/planet`, plus nested children). Add new exclusions there.
- Tunables live at the top of that file: `PALETTES` (per-theme colours + intensity), `BASE_SPEED`, `BASE_GRAIN`, `PEAK_OPACITY`, `CALM_FACTOR`. The fragment shader and standalone defaults live in `public/hero-shader.js`.
- `lib/plasma-bus.ts` is a tiny localStorage + custom-event bus driving a `calm` / `vivid` toggle from the command palette; the shader subscribes via `onPlasmaModeChange`.
- Opacity ties to scroll: it fades to 0 over the height of `[data-hero-region]` (set on the home hero `<section>`). Without that element the fade falls back to the viewport height.

## Design tokens

All in `app/globals.css`, defined on `:root` (light) and overridden on `.dark`:

- `--bg`, `--surface`, `--fg`, `--muted`, `--border`, `--accent`, `--scan` (all `oklch()`), plus `--dur`, `--dur-fast`, `--ease`, `--font-display`, `--font-body`.
- `--font-display` / `--font-body` are also in `@theme`, so the `font-display` / `font-body` Tailwind utilities exist. Use them, not `font-serif`.
- Always read colours via the vars (e.g. `text-[var(--muted)]`). Before using a token, check it exists in `globals.css`; an undefined var fails silently.
- The shader palettes, OG image, favicons, and snake renderer hard-code amber `#FFB84D`. They don't read `--accent`.
- Global `* { border-radius: 0 !important }` is intentional — the design is hard-edged. Don't add `rounded-*` utilities expecting them to win.
- The shader paints above the body background (negative z-index). Any translucent surface lets it bleed through.
- Most page layout uses the plain CSS classes in `globals.css` (`.page`, `.section-header`, `.l-asym`, `.card`, `.tl`, `.stack-grid`, …) with inline styles, and Tailwind for one-off tweaks.

## Content sources

- `content/site.ts` — name, email, URL, nav, socials, bio (`knowsAbout` feeds JSON-LD, OG image, llms.txt), Formspree + newsletter endpoints. Single source of truth for contact details.
- `content/cv.ts` — typed CV (`CVExperience`, `CVProject`, `CVLanguage`). `app/cv/page.tsx` renders it; `public/cv.pdf` is generated separately and committed.
- `content/about.ts` — timeline, beliefs, anti-list, `stackGroups` (rendered on /about *and* /cv), `sideThings` (home hero sidebar).
- `content/play.ts` — the three games (Snake, GOLDENLINE, LITTLEBIG), receipts and "How these were built" data for `/play`, the home Play strip and `llms.txt`. Every claim is sourced in the Facts table of `docs/superpowers/specs/2026-10-04-play-page-design.md`. A new game is another entry (extend the `slug`/`href` unions); an odd last card spans the `/play` grid as a landscape card. Media lives in `public/play/` (MP4 + JPG posters, Snake has dark/light variants; budgets in `tests/content/play-media.test.ts`). Regenerate it with `docs/play-media.md` (scripts in `scripts/play-media/`, run against the dev server). `GameClip` (`components/play/game-clip.tsx`) owns all video behaviour: in-view autoplay, off-screen/hidden-tab pause, a pause toggle outside the card link, poster only under reduced motion.
- `content/work/*.mdx` — case studies. Each exports a `meta` object. To add one, register the slug in the `works` map in `app/work/[slug]/page.tsx` **and** in `WORK_SLUGS` in `app/sitemap.ts` and `app/llms-full.txt/route.ts`, and add a line to `app/llms.txt/route.ts`.
- Notes: the `/notes` section (hidden since #38) was removed along with its only post. `/subscribe` still pitches a future notes newsletter. If you bring notes back, restore `app/notes/` and `lib/notes.ts` from git. Note that `output: 'export'` fails the build if a dynamic route's `generateStaticParams()` returns `[]`, so don't ship the `[slug]` route without at least one post.
- `content/building/index.mdx` — imported by `/building` (its `meta.updated` drives the header).
- The home page's featured cases (`components/featured-work.tsx`) and building teaser (`components/building-teaser.tsx`) have their copy inline.
- Contact: `/contact` is a plain HTML `<form>` POSTing to `site.formspreeEndpoint`, with an off-screen `_gotcha` honeypot (Formspree silently drops submissions that fill it; covered by `tests/app/contact-page.test.tsx`). `components/contact-form.tsx` is an AJAX version with its own tests, but no page currently mounts it.
- Newsletter: `components/subscribe-form.tsx` posts to `site.subscribeEndpoint`. It is empty for now, so the form renders a "coming soon" CTA.

## Theming

- `next-themes` (`components/theme-provider.tsx`) with `attribute="class"`, `defaultTheme="dark"`, `enableSystem`.
- Dark is the default visual feel; light mode uses lower shader intensity (`PALETTES.light.intensity = 0.18`).

## Reduced motion

Honored in several places:

- Global CSS in `app/globals.css` collapses `animation-duration` to ~0, caps `transition-duration` at 200ms, and shows `.reveal` content immediately.
- The shader's `applyState` (in `components/hero-shader.tsx`) sets `speed: 0` and clamps intensity. The script side (`public/hero-shader.js`) renders a single static frame in this mode.
- `RevealObserver`, `ScrollReveal`, `AnimatedStats`, `TypewriterBar`, the snake renderer, and the IDE overlay each check the media query too.
- LITTLEBIG reads it once at boot (`littlebig-canvas.tsx` → `ctx.reducedMotion`): the camera damps inertia harder and flies slower, and the toon kit drops the reveal fade.

## Gotchas

- **Parent lockfile.** There's a stray `~/pnpm-lock.yaml` on this machine. Next 15 warned about it; Next 16 is silent. Only matters if you set `outputFileTracingRoot` / `turbopack.root`.
- **`scripts/dev.mjs` exists for a reason** — Next 15 was picking up `NODE_ENV=production` via env layering in this user's shell. Don't replace `pnpm dev` with raw `next dev` without testing.
- **`agentRules: false` in `next.config.mjs` is deliberate.** Next 16.3+ otherwise appends a managed block to this file whenever `next dev` runs under an AI agent. Version-matched Next docs ship in `node_modules/next/dist/docs/`; check them before assuming Next 15 APIs.
- **`data-scroll-behavior="smooth"` on `<html>`** (in `app/layout.tsx`) keeps route changes jumping to the top instead of smooth-scrolling, since `globals.css` sets `scroll-behavior: smooth`. Next 16 only suppresses smooth scroll during navigation when that attribute is present.
- **TypeScript 7** (native `tsgo`) is the compiler. `tsc` and Next's build type-check both run on it. The `next` language-service plugin in `tsconfig.json` may not load in editors using TS 7's native language server; if editor-only Next hints go missing, that's why.
- **LITTLEBIG's shaders are minified by a Turbopack loader.** `turbopack.rules['*.ts']` in `next.config.mjs` runs `scripts/glsl-minify.cjs` over `components/littlebig/**` files containing `/* glsl */` template literals, in dev and in the build. It strips comments and whitespace from the static parts; a literal with backslash escapes is left alone. `components/littlebig/core/glsl-minify.spec.ts` checks the output is token-for-token the same shader. Editing `next.config.mjs` restarts the dev server.
- **No request-time data fetching.** Static export means everything resolves at build time (the `llms-full.txt` route reads MDX from disk during build).
- **MDX `meta` exports are typed `any`** (`mdx.d.ts`). The consumer declares its own shape (`WorkModule` in `app/work/[slug]/page.tsx`), so keep it in sync with the frontmatter-style `meta` objects.

## When in doubt

- Architecture / layout questions → read the route's `page.tsx` first; data shape lives in `content/`.
- Visual tweaks → start at `app/globals.css` (tokens + layout classes) and the component's Tailwind/inline styles; don't reach for new CSS files.
