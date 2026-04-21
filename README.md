# arthur.buikis.com

Personal website — engineering portfolio, case studies, and what I'm currently building.

## Stack

- **Next.js 15** (App Router, static export)
- **React 19**, TypeScript strict
- **Tailwind CSS v4** + CSS custom-property design tokens
- **MDX** for case studies (`content/work/*.mdx`) and the building page
- **next-themes** for light/dark persistence
- **EmailJS** for the contact form (client-side)

## Local dev

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000.

## Build & test

```bash
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest unit tests
pnpm test:e2e      # playwright smoke test
pnpm build         # next build + static export → ./out
```

## Deploy

Automated on push to `master` via `.github/workflows/deploy.yml`. Publishes `./out` to the `gh-pages` branch; GitHub Pages serves it at https://arthur.buikis.com.

## Structure

- `app/` — Next.js App Router pages and layout
- `components/` — UI primitives and composed page sections
- `content/` — site config, CV data, MDX content
- `lib/` — small utilities
- `public/` — static assets (CNAME, cv.pdf, fonts if needed)
- `tests/` — vitest unit tests + playwright e2e
- `docs/superpowers/` — design spec and implementation plan
