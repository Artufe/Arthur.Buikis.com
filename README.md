# arthur.buikis.com

Personal website — engineering portfolio, case studies, CV, and what I'm currently building.

## Stack

- **Next.js 16** (App Router, Turbopack, fully static export)
- **React 19**, TypeScript strict
- **Tailwind CSS v4** + CSS custom-property design tokens (`app/globals.css`)
- **MDX** for case studies (`content/work/*.mdx`) and the building page
- **next-themes** for light/dark persistence
- **Formspree** for the contact form (plain HTML POST, no backend)
- A WebGL plasma hero (`public/hero-shader.js`, see [`docs/hero-shader.md`](docs/hero-shader.md)) and a PixiJS snake game easter egg

## Local dev

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000. Press `/` or `Ctrl/⌘+K` for the command palette.

## Build & test

```bash
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest unit tests
pnpm test:e2e      # playwright smoke tests (starts `pnpm dev` if nothing is on :3000)
pnpm build         # next build + static export → ./out, then scripts/postbuild.mjs
npx serve out      # preview the exported site
```

## Deploy

- **PRs to `master`:** `.github/workflows/ci.yml` runs typecheck, unit tests, and a build.
- **Push to `master`:** `.github/workflows/deploy.yml` builds and publishes `./out` to the `gh-pages` branch. GitHub Pages serves it at https://arthur.buikis.com.

## Structure

- `app/` — App Router routes, root layout, `sitemap.ts`, `robots.ts`, `llms.txt`, OG image
- `components/` — page sections, the command palette, IDE overlay, and snake game (`snake/`); `ui/` form primitives, `mdx/` MDX overrides
- `content/` — site config (`site.ts`), CV and about data, MDX for work and building
- `lib/` — small helpers and the window-event buses (`*-bus.ts`) that connect the easter eggs
- `public/` — static assets: CNAME, `cv.pdf`, favicons, `hero-shader.js`
- `scripts/` — dev wrapper, post-build OG-image fix, favicon generator, MCP image server for the Claude bot
- `tests/` — vitest component/unit tests + playwright e2e (`tests/e2e/`)
- `docs/` — design notes
