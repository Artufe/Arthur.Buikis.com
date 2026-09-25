# Arts-site

Personal site for Arthur Buikis — Next.js 15 (App Router) + Tailwind v4 + MDX, statically exported to GitHub Pages on every push to `master`.

## Commands

```bash
pnpm dev            # local dev — wraps `next dev` via scripts/dev.mjs to force NODE_ENV=development
pnpm build          # static export → ./out, then scripts/postbuild.mjs (OG image rename)
pnpm typecheck      # tsc --noEmit (run before pushing)
pnpm test           # vitest run (tests/{app,components,lib}, components/**/*.spec.ts, .github/scripts)
pnpm test:e2e       # playwright (tests/e2e) — auto-starts `pnpm dev` unless :3000 is already up
```

There is no lint script (no ESLint config in the repo) and no `start` script (`next start` doesn't work with `output: 'export'`; use `npx serve out` to preview a build).

**Use pnpm.** `pnpm-lock.yaml` is the only lockfile (`package-lock.json` is gitignored). CI pins **pnpm 9** and **Node 20** with `--frozen-lockfile`. If your local pnpm is newer, check that it doesn't rewrite the lockfile format before committing, and don't commit a locally generated `pnpm-workspace.yaml`.

## Layout

```
app/            Routes: / (page.tsx), about/, building/, contact/, cv/, work/[slug]/,
                subscribe/, snake/,
                plus sitemap.ts, robots.ts, llms.txt/, llms-full.txt/, opengraph-image.tsx
components/     Page sections + global chrome; ui/ (Input, Textarea), mdx/ (MDX overrides),
                snake/ (PixiJS snake game)
content/        site.ts, cv.ts, about.ts (typed data) + work/*.mdx, building/*.mdx
lib/            Pure helpers: commands.ts (palette commands), fuzzy.ts, utils.ts (cn),
                and window-event buses: palette-bus, plasma-bus, snake-bus, ide-bus
public/         Static assets: CNAME, cv.pdf, favicons, site.webmanifest, hero-shader.js
scripts/        dev.mjs, postbuild.mjs, gen-icons.py (favicons), mcp/ (image server for the Claude bot)
docs/           hero-shader.md
tests/          vitest (app/, components/, lib/) + playwright (e2e/)
.github/        workflows/, scripts/grok-imagine.mjs (PR image bot), agents/ (prompt library)
```

## Deploy

- PRs to `master` → `.github/workflows/ci.yml` runs typecheck, unit tests, and build.
- Push to `master` → `deploy.yml` builds with pnpm, copies `public/CNAME` into `./out`, deploys via `peaceiris/actions-gh-pages@v4` to the `gh-pages` branch. (Deploy does not run unit tests.)
- `next.config.mjs` sets `output: 'export'` + `trailingSlash: true` + `images.unoptimized: true`. **No SSR, no API routes, no `revalidate`** — anything dynamic must run client-side or at build time. Route handlers (`llms.txt`, `sitemap`, OG image) must be `force-static`.
- `scripts/postbuild.mjs` renames the extensionless `out/opengraph-image` to `.png` and rewrites references in the HTML, because GitHub Pages would serve it as `application/octet-stream`.
- `gh-pages` branch is auto-managed; never commit there directly.

## Push policy

Direct `git push origin master` is blocked by the harness ("bypasses pull request review"). For routine work, branch + `gh pr create`. The user can override case-by-case ("push anyway"); take that as scope-of-one approval, not a standing license.

## Global chrome (app/layout.tsx)

Mounted once for every route: `HeroShader`, `ScanLine` (dot grid), `RevealObserver`, `Nav`, `Footer`, `SnakeWindowHost`, `CommandPaletteLazy`, `IdeOverlay`. Also emits Person + WebSite JSON-LD.

- **Command palette** (`components/command-palette*.tsx`, commands in `lib/commands.ts`) — opens on `/` or `Ctrl/⌘+K`. The lazy wrapper listens for the keys and idle-prefetches the real palette.
- **Snake** (`components/snake/`) — floating window opened via the palette (`snake-bus`), expandable to `/snake`. Engine is pure and unit-tested (`snake-engine.spec.ts`).
- **IDE overlay** (`components/ide-overlay.tsx`) — Zed-style "view source" easter egg built from `content/*` data. Opened by the header "open in zed" button, the footer `$EDITOR` link, or the palette (`ide-bus`).
- **Reveal** — elements with a bare `reveal` class start at opacity 0. `RevealObserver` adds `vis` on intersection (including nodes added by client navigation); `ScrollReveal` wraps sections on the home page.

## Hero shader

Full reference: `docs/hero-shader.md`.

- Route-gated in `components/hero-shader.tsx`. The component returns `null` for anything in `SHADER_EXCLUDED_ROUTES` (`/cv`, `/contact`, `/snake`, plus nested children). Add new exclusions there.
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

## Gotchas

- **Multiple lockfiles warning.** Next infers workspace root as `~/` because of a parent `pnpm-lock.yaml`. Harmless; ignore unless setting `outputFileTracingRoot`.
- **`scripts/dev.mjs` exists for a reason** — Next 15 was picking up `NODE_ENV=production` via env layering in this user's shell. Don't replace `pnpm dev` with raw `next dev` without testing.
- **No request-time data fetching.** Static export means everything resolves at build time (the `llms-full.txt` route reads MDX from disk during build).
- **MDX `meta` exports are typed `any`** (`mdx.d.ts`). The consumer declares its own shape (`WorkModule` in `app/work/[slug]/page.tsx`), so keep it in sync with the frontmatter-style `meta` objects.

## When in doubt

- Architecture / layout questions → read the route's `page.tsx` first; data shape lives in `content/`.
- Visual tweaks → start at `app/globals.css` (tokens + layout classes) and the component's Tailwind/inline styles; don't reach for new CSS files.
