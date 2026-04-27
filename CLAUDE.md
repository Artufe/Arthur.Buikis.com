# Arts-site

Personal site for Arthur Buikis — Next.js 15 (App Router) + Tailwind v4 + MDX, statically exported to GitHub Pages on every push to `master`.

## Commands

```bash
npm run dev         # local dev — wraps `next dev` via scripts/dev.mjs to force NODE_ENV=development
npm run build       # static export → ./out
npm run typecheck   # tsc --noEmit (run before pushing)
npm run lint        # next lint
npm test            # vitest run
npm run test:e2e    # playwright (smoke tests in tests/)
```

CI (`.github/workflows/deploy.yml`) uses **pnpm** with a frozen lockfile. Locally either `npm` or `pnpm` works, but be aware both `package-lock.json` and `pnpm-lock.yaml` exist — don't churn one without the other.

## Layout

```
app/            App Router routes — page.tsx, cv/, contact/, work/, building/, about/
components/     React components; ui/ for primitives, mdx/ for MDX overrides
content/        Structured data (cv.ts, site.ts, about.ts, work/*) + building/*.mdx
lib/            Pure helpers (git-stats.ts, plasma-bus.ts, commands.ts, utils.ts)
public/         Static assets, including hero-shader.js and CNAME
scripts/        Build / dev helpers (dev.mjs, test-live-form.mjs)
docs/           Internal design + planning notes (superpowers/plans, superpowers/specs)
tests/          Playwright + vitest specs
```

## Deploy

- Push to `master` → CI builds with pnpm, copies `public/CNAME` into `./out`, deploys via `peaceiris/actions-gh-pages@v4` to the `gh-pages` branch.
- `next.config.mjs` sets `output: 'export'` + `trailingSlash: true` + `images.unoptimized: true`. **No SSR, no API routes, no `revalidate`** — anything dynamic must run client-side or at build time.
- `gh-pages` branch is auto-managed; never commit there directly.

## Push policy

Direct `git push origin master` is blocked by the harness ("bypasses pull request review"). For routine work, branch + `gh pr create`. The user can override case-by-case ("push anyway"); take that as scope-of-one approval, not a standing license.

## Hero shader

- Mounted globally in `app/layout.tsx` via `<HeroShader />`, but **route-gated** in `components/hero-shader.tsx` — `usePathname()` returns `null` for `/cv` and `/contact` (and any nested children). Add new exclusions to `SHADER_EXCLUDED_ROUTES`.
- Tunables live at the top of `components/hero-shader.tsx`: `PALETTES` (per-theme intensity), `BASE_SPEED`, `BASE_GRAIN`, `PEAK_OPACITY`, `CALM_FACTOR`. The fragment-shader constants live in `public/hero-shader.js`.
- `lib/plasma-bus.ts` is a tiny localStorage + custom-event bus driving a `calm` / `vivid` toggle from the command palette; the shader subscribes via `onPlasmaModeChange`.
- Hero opacity ties to scroll: it fades to 0 by the time `[data-hero-region]` (set on the home hero `<section>`) scrolls out. If you remove that attribute, the shader stops fading.

## Surface tokens

`app/globals.css` deliberately keeps card surfaces **opaque**:

- `--card` (light: `#F0EBE4`, dark: `#13110F`) and dark `--bg-muted: #171614` are solid. They used to be translucent, but the shader paints above the body background (negative-z-index trick), so any alpha lets it bleed through. Don't reintroduce alpha on these without compensating elsewhere.
- Global `* { border-radius: 0 !important }` is intentional — the design is hard-edged. Don't add `rounded-*` utilities expecting them to win.

## Content sources

- `content/site.ts` — name, email, socials. Single source of truth for the contact details rendered across the site.
- `content/cv.ts` — typed CV (`CVExperience`, `CVProject`, `CVLanguage`). `app/cv/page.tsx` renders it; PDF at `public/cv.pdf` is generated separately and committed.
- `content/about.ts` — `stackGroups` (rendered on /about *and* /cv).
- `content/work/*.ts` and `content/building/*.mdx` — case studies and active-project log.
- The contact form posts to **Formspree** (replaced the old EmailJS integration). Live-form smoke test: `node scripts/test-live-form.mjs`.

## Theming

- `next-themes` (`components/theme-provider.tsx`) with `class="dark"` strategy.
- Dark is the default visual feel; light mode uses lower shader intensity (`PALETTES.light.intensity = 0.18`).
- Accent tokens differ per theme: `--accent` is `#B25C0D` (light) / `#FFB84D` (dark). Always read accent via the var, not hardcoded.

## Reduced motion

Honored in two places:

- Global CSS in `app/globals.css` collapses `animation-duration`/`transition-duration` for `prefers-reduced-motion: reduce`.
- The shader's `applyState` (in `components/hero-shader.tsx`) sets `speed: 0` and clamps intensity when reduced-motion is on. The script side (`public/hero-shader.js`) renders a single static frame in this mode.

## Gotchas

- **Multiple lockfiles warning.** Next infers workspace root as `~/` because of a parent `pnpm-lock.yaml`. Harmless; ignore unless setting `outputFileTracingRoot`.
- **`scripts/dev.mjs` exists for a reason** — Next 15 was picking up `NODE_ENV=production` via env layering in this user's shell. Don't replace `npm run dev` with raw `next dev` without testing.
- **No server components doing dynamic data fetching at request time.** Static export means everything resolves at build time. `lib/git-stats.ts` reads git locally during build.
- **Playwright tests need the dev server running**; `npm run dev` first, then `npm run test:e2e` in another shell.

## When in doubt

- Architecture / layout questions → read the route's `page.tsx` first; data shape lives in `content/`.
- Visual tweaks → start at `app/globals.css` (tokens) and the component's Tailwind classes; don't reach for new CSS files.
- Plans and specs for in-flight work live in `docs/superpowers/plans/` and `docs/superpowers/specs/`.
