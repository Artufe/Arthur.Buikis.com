# Site Rework — Design Spec

**Date:** 2026-04-21
**Domain:** arthur.buikis.com (custom domain on GitHub Pages)
**Owner:** Arthur Buikis
**Status:** Approved for implementation planning

---

## 1. Context & Goals

The current site (`artufe.github.io`) is a 2018-era Create React App portfolio template. It has dependency rot (77 Dependabot alerts), stale content ("currently between jobs", "RedBull is my spirit animal"), and a thin portfolio section (three link cards). It doesn't match the positioning of a senior engineer with 12 years of shipping experience who is actively job-hunting via `career-ops` while also taking freelance work and building a personal product.

The rework replaces the site end-to-end on a modern stack, with a design language and content narrative that serves three audiences simultaneously.

### Audience (in priority order)
1. **FTE recruiters / hiring managers** — senior/staff full-stack roles. Site must pass the 8-second recruiter scan and deliver a downloadable CV.
2. **Freelance / consulting clients** — continuation of Upwork work. Needs a clear "what I can do" path and a low-friction contact mechanism.
3. **Builder-brand audience** — people interested in Arthur as a person shipping his own product. Less transactional; supports the long game.

### Positioning
"Senior full-stack engineer who ships systems that actually hold up." Pragmatic generalist (A) with a systems/optimization flavor (D). Broad enough to catch FTE traffic, sharp enough to not read as generic.

### Non-goals
- Not a blog. No writing section.
- Not multilingual. English only.
- Not a content-managed system. MDX files in git are the CMS.
- Not an availability billboard — no "Open to work" pills. Positioning stays neutral on employment status.

---

## 2. Information Architecture

```
/                      Home — hero, about-snippet, featured work, building, CTA
/work/[slug]           Case study detail (MDX). One entry at launch:
                         lethub-scraping-ml (combined Lethub + real-estate + ML + perf)
/building              "Currently building" — personal product platform
/about                 Full bio, skills, timeline
/cv                    HTML-formatted CV summary + PDF download
/contact               Form + direct email + socials
```

No `/work` index route at launch (one case study doesn't warrant a list page). Add when a second case study lands.

---

## 3. Visual Language

### 3.1 Principles
- Editorial structure with developer soul. Luxury-editorial discipline (grid, typography, whitespace) without the fashion-magazine flourishes.
- Dark mode leans into terminal aesthetic (monospace prompts, `$` accents) without becoming retro.
- 0px border-radius everywhere. Strict.
- Motion is deliberate and slow. No snap, no bounce.
- Images default to grayscale, reveal color on hover (1500ms).

### 3.2 Design Tokens

Exposed as CSS custom properties and Tailwind v4 config. Named semantically, not by color.

**Colors (light mode):**
| Token | Value | Use |
|---|---|---|
| `--bg` | `#F9F8F6` (Warm Alabaster) | Page background |
| `--bg-muted` | `#EBE5DE` (Pale Taupe) | Elevated surfaces, hover backgrounds |
| `--fg` | `#1A1A1A` (Rich Charcoal) | Primary text, borders |
| `--fg-muted` | `#6C6863` (Warm Grey) | Secondary text, captions |
| `--accent` | `#D4AF37` (Metallic Gold) | Hover states, `$` prompt, focus outlines |

**Colors (dark mode):** inverted — `--bg: #1A1A1A`, `--bg-muted: #242220`, `--fg: #F9F8F6`, `--fg-muted: rgba(249,248,246,0.55)`. `--accent` stays gold (readable on both backgrounds).

**Typography:**
- `--font-serif` — **Fraunces** (variable font, opsz 9-144, weights 400-600). Headlines only.
- `--font-sans` — **Inter** (weights 300-700). Body, nav, UI.
- `--font-mono` — **JetBrains Mono** (weights 400-500). Meta rows, labels, code, terminal prompts.

All three loaded from Google Fonts via Next.js `next/font/google` for self-hosting + zero layout shift.

**Scale (clamp-based, responsive):**
| Role | Value | Line height |
|---|---|---|
| Hero headline | `clamp(40px, 5.5vw, 72px)` | 1.02 |
| Section headline | `clamp(28px, 3.5vw, 44px)` | 1.1 |
| Subsection title | `clamp(20px, 2vw, 28px)` | 1.2 |
| Body | 16px (18px on reading pages) | 1.65 |
| Meta / mono | 11-12px | 1.5 |
| Overline labels | 10-11px, uppercase, tracking 0.15-0.2em | 1.4 |

**Spacing:** 4px base unit. Section padding: `py-24` mobile → `py-32` desktop.

**Borders:** 1px only. `var(--fg)` at full opacity for strong borders; `rgba(fg, 0.08-0.12)` for subtle dividers.

**Shadows:**
- Card default: `0 2px 8px rgba(0,0,0,0.02)`
- Card hover: `0 8px 24px rgba(0,0,0,0.06)`
- Primary button default: `0 4px 16px rgba(0,0,0,0.15)`
- Primary button hover: `0 8px 24px rgba(0,0,0,0.25)`

**Motion:**
| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 300ms | Text color, link underlines |
| `--dur-base` | 500ms | Buttons, backgrounds |
| `--dur-slow` | 700ms | Section fades, scroll-reveal |
| `--dur-cinematic` | 1500ms | Image grayscale → color |
| `--ease-luxury` | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` | Default easing |

All motion tokens respect `prefers-reduced-motion` (durations collapse to 0ms for transforms; color transitions remain).

**Grid:** 12 columns, `max-w-[1600px]`, centered. Horizontal padding `px-6` mobile → `px-16` desktop.

**Signature details:**
- **Visible gridlines** — 4 fixed vertical 1px lines at viewport percentages `16.67%`, `33.33%`, `66.67%`, `83.33%` (container edges and middle thirds of the 12-column grid). Color `rgba(var(--fg), 0.08)`, pointer-events-none. Hidden on mobile (`< 1024px`). Mounted once in root layout.
- **Grain overlay** — fixed SVG fractal noise, 1.5% opacity, pointer-events-none. Mounted once.

---

## 4. Components

All components live in `components/ui/`. Variant systems via `class-variance-authority`.

### 4.1 Button
Props: `variant: primary | secondary | link`, `size: sm | md | lg`, standard button attrs.

- **Primary:** `--fg` background, `--bg` text. On hover: gold `--accent` overlay slides in from left (`translateX(-100%)` → `translateX(0)`, 500ms, `--ease-luxury`). Shadow deepens. Internal DOM: `<button><span class="overlay"/><span class="content">...</span></button>` with z-indexing.
- **Secondary:** transparent bg, 1px `--fg` border. On hover: bg fills to `--fg`, text inverts to `--bg`, 500ms.
- **Link:** text with underline on hover, gold color on hover.

Uppercase, mono font for CTA labels in some contexts (e.g., `./work`, `./cv.pdf`).

### 4.2 Nav
Sticky top. `bg-[var(--bg)]/80` + `backdrop-blur-md`. Contains: `ab.` mono brand (left), route links (center/right), theme toggle (right), CV download button (right). Active link uses `--fg` weight 500; inactive uses `--fg-muted`. Collapses to hamburger drawer on mobile (< 768px).

### 4.3 Card
For case-study teasers, building project, related work.
- No full border. `border-t-[1px] border-[var(--fg)]/20` on top.
- Hover: `bg-[var(--bg-muted)]/50` slight fill, 500ms.
- Contains optional grayscale thumbnail (aspect-[4/5]) with 1500ms color-on-hover transition.
- Meta row at bottom (mono font): `year · stack · role`.
- Wrap in `group` for coordinated child hovers.

### 4.4 MetaRow
Reusable label-over-value component. Used on hero, case-study header, CV page. Columns separated by `border-t border-[var(--fg)]/12`. Each cell: mono uppercase label (9px, 0.2em tracking), then value (11-12px mono regular).

### 4.5 MDX components
For case-study and building pages.
- `<Callout>` — subtle `--bg-muted` background, optional icon, 1px left border in gold. For pull-outs.
- `<CodeBlock>` — mono, `--bg-muted` background, optional language label. Syntax highlighting via `shiki` (Next.js recommended).
- `<Figure>` — image + italic-serif caption. Grayscale default, color on hover 1500ms.

### 4.6 ThemeToggle
Icon-only button. Sun / moon from lucide-react. Uses `next-themes`. Defaults to system preference on first visit; persists to localStorage. Fade crossover between modes (250ms).

### 4.7 Input / Textarea
Bottom-border only. Transparent bg. Placeholder in italic Fraunces, color `--fg-muted`. On focus: border changes to `--accent` gold. No ring.

### 4.8 Gridlines & GrainOverlay
Global fixed overlays, mounted once in `app/layout.tsx`. Both have `pointer-events: none`. Can be disabled via a single CSS variable for users who opt out in some future accessibility switch (out of scope for v1).

### 4.9 Footer
Three-column horizontal layout (stacks on mobile). Left: one-sentence bio. Middle: sitemap. Right: socials + direct email. Separator `border-t` above; smaller copyright line below.

---

## 5. Page Specifications

### 5.1 `/` Home

1. **Nav** (sticky, transparent-to-solid on scroll)
2. **Hero**
   - Light mode: headline only, mono meta-row, two CTAs ("View work" primary, "download_cv.pdf →" link).
   - Dark mode: adds a `$ whoami --verbose` mono prompt line above the headline.
   - Headline (placeholder): "Senior engineer. Ships systems that don't break."
   - Meta row: Focus (backend · data · infra) / Stack (python · django · docker) / Based in (latvia · remote).
3. **About-snippet** — asymmetric two-column. Left: one-paragraph intro with Fraunces drop-cap on the first letter. Right: three-item mono bullet list ("What I do").
4. **Featured work** — single large card for the Lethub/scraping/ML case study. Full-width on mobile, 7-column asymmetric on desktop (cols 1-7). Placeholder grayscale graphic (SVG or illustration) since screenshots are not available. Title in Fraunces. Meta row. Two-line tease. "Read the story →" link to `/work/lethub-scraping-ml`.
5. **Currently building** — compact section. Single card for the personal product. Status line in mono (e.g. `status: prototype`). Pitch paragraph. Link to `/building`.
6. **Snapshot** — large Fraunces numerals + mono captions (e.g. "12" / "years shipping", "6" / "companies", "∞" / "lines of Python"). Only include numbers that are factually correct and meaningful. If unclear, omit.
7. **CTA footer section** — inverted section (dark in light mode). Large Fraunces "Let's talk." + mailto link + "View the CV →".

### 5.2 `/work/[slug]` Case study detail

Rendered from MDX files in `content/work/*.mdx`. At launch: `lethub-scraping-ml.mdx` (combined Lethub + real-estate scraping + ML + optimization).

**Layout:**
- Header block: mono overline (`CASE STUDY · 2024`), Fraunces title, two-line subtitle, horizontal rule, MetaRow (role · stack · duration · outcome).
- Body: long-form MDX content in a single reading column (`max-w-[680px]`). Fraunces drop-cap on first paragraph. Scroll-reveal fade per block.
- Standard sections: Context, What I built, Challenges, What I'd do differently, Outcome.
- Inline MDX components: `<Callout>`, `<CodeBlock>`, `<Figure>`.
- Footer: "Back to all work →" link (goes to `/` until `/work` index exists).

### 5.3 `/building`

Similar structure to a case study but forward-looking.
- Header: overline (`BUILDING — 2026`), Fraunces title (product name), one-line positioning.
- Sections: What it is, Why, Where it's at now (live status — prototype / alpha / etc.), What's next, How to follow.
- Reuses `<Figure>` and `<Callout>` components.

### 5.4 `/about`

- Short bio paragraph (updated — drop the 2017 Upwork framing and the RedBull line).
- Timeline: mono row per role. Format: `YEAR — YEAR | ROLE | COMPANY` + one-line context.
- Skills: grouped into Languages / Frameworks / Infra / Data+ML. Mono tags. **No 0-100 skill bars** — they read as amateur.
- "What I care about": 3-4 short paragraphs (craft, shipping, code that doesn't become a problem later). Personality lives here.
- Links: GitHub, LinkedIn, Upwork.

### 5.5 `/cv`

HTML-formatted summary of the career-ops-generated CV, keyword-scannable for recruiters who don't open PDFs.

- Top: name, one-line positioning, download button (serves `/cv.pdf`).
- Sections mirror a traditional resume: Experience, Skills, Education.
- Fraunces headlines, mono dates and company names, Inter descriptions.
- Print-friendly CSS (so `/cv` can itself be printed to PDF if someone does that).

### 5.6 `/contact`

- Left column: direct email `arthur@buikis.com` as a prominent mailto link, socials (GitHub, LinkedIn, Upwork).
- Right column: contact form (name, email, message), EmailJS-wired.
- Inputs use underline-only styling. Submit button uses primary variant.
- Success/error messages inline in same type system (italic Fraunces for success message).

---

## 6. Motion & Interaction

- **Page transitions:** 400ms fade between routes. Replaces the current CSSTransition slide.
- **Scroll-reveal:** content blocks fade + translate-up 12px on IntersectionObserver entry (700ms). Single utility hook used everywhere.
- **Images:** grayscale → color on hover, 1500ms, combined with `scale(1.03)` and shadow deepening.
- **Buttons:** gold overlay slides on hover (500ms), shadow deepens.
- **Nav links:** gold underline animates from left on hover (300ms).
- **Theme toggle:** fade crossover between modes (250ms), no layout shift.
- **Removed:** the existing `AnimatedCursor` hook — distracting on desktop, broken on mobile.
- `prefers-reduced-motion`: disables transforms and long durations, keeps color transitions. Enforced via media-query scoped utility classes.

---

## 7. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | **Next.js 15** (App Router) | Current standard, recognized by recruiters, good SSG story |
| Build mode | `output: 'export'` (static HTML) | Works with GitHub Pages, no backend needed |
| Styling | **Tailwind CSS v4** + CSS custom properties | Fast, maintainable, aligns with the token system |
| Content | **MDX** via `@next/mdx` | Case studies as files in git |
| Fonts | `next/font/google` (Fraunces, Inter, JetBrains Mono) | Self-hosted, zero layout shift |
| Theming | `next-themes` | Dark/light persistence + system preference |
| Icons | `lucide-react` | Thin, consistent, small bundle |
| Forms | `emailjs-com` (kept from current) | Already works, client-side, $0 |
| Syntax highlighting | `shiki` | Next.js recommended, server-side, themeable |
| Utilities | `clsx`, `tailwind-merge`, `class-variance-authority` | Standard for variant-based components |

**Package manager:** `pnpm` (switch from `yarn`). Faster installs, stricter dependency resolution, smaller disk footprint. Lockfile change is a one-time cost absorbed by the migration.

**Node version:** bump workflow from 18.16.1 to 20.x LTS.

---

## 8. Migration Plan

Performed in discrete commits to keep diffs reviewable.

1. **Add Next.js scaffold** in the same repo, parallel to existing CRA under `src/`. Don't delete CRA yet. New code lives in `app/`, `components/`, `content/`, root-level Next.js config files.
2. **Build design tokens + primitives** — global CSS, Tailwind v4 config, Button, Card, MetaRow, Nav, Footer, ThemeToggle, Gridlines, GrainOverlay.
3. **Build pages** in order: layout + nav + home → about → contact → cv → work case study → building.
4. **Migrate content** from `src/content_option.js` into `content/site.ts` + MDX files. Rewrite copy (drop stale phrases). Reference career-ops data for CV content.
5. **Swap the deploy workflow** — build Next.js, deploy `./out` instead of CRA `./build`.
6. **Delete CRA** — remove `src/`, CRA-era deps in `package.json`, old config files. Resolves the 77 Dependabot alerts by eliminating the vulnerable packages.
7. **Preserve `public/CNAME`** so the custom domain continues working.
8. **Remove obsolete fields:** `homepage` in package.json (Next.js doesn't use it).

---

## 9. Deploy Pipeline

`.github/workflows/deploy.yml` — updated:

- Trigger: `push` to `master`, `workflow_dispatch`.
- Node: 20.x.
- Install: `pnpm install --frozen-lockfile` (or `yarn` if retained).
- Build: `pnpm build` → produces `./out/` via `next build` + static export.
- Deploy: `peaceiris/actions-gh-pages@v4` (bumped from v3), `publish_dir: ./out`.
- CNAME file in `public/CNAME` is copied to `./out` by Next.js automatically.

No changes to DNS. No changes to the GitHub Pages settings.

---

## 10. Testing

Minimal, pragmatic. This is a portfolio site, not a product.

- **Type-check** in CI: `tsc --noEmit`.
- **Lint** in CI: `next lint`.
- **Build** in CI: `next build` catches broken imports, MDX issues, static export incompatibilities.
- **Visual regression:** one Playwright screenshot test per mode (home page, light + dark). Run locally on design changes. Not enforced in CI for v1.
- No unit tests for UI components at this stage — presentational, low-risk.

---

## 11. Accessibility

- WCAG AA minimum. Contrast ratios:
  - Charcoal on Alabaster: 12.6:1 (AAA)
  - Warm Grey on Alabaster: 4.8:1 (AA)
  - Gold on Charcoal: 5.2:1 (AA)
- Focus states: `focus-visible:ring-1 focus-visible:ring-[var(--fg)]` for buttons; gold border on focused inputs.
- Touch targets: minimum 48x48px (buttons are `h-12`).
- `prefers-reduced-motion` respected globally.
- Semantic HTML: proper heading hierarchy, `<nav>`, `<main>`, `<article>` for case studies.
- Alt text required on all images. Figure captions describe the image, not the caption.
- Keyboard navigation: all interactions reachable without mouse.

---

## 12. Out of Scope (YAGNI)

Explicitly excluded from v1 to keep scope tight:

- Blog / writing section
- Internationalization (English only)
- Analytics (can be added in 5 minutes later with Plausible or Vercel Analytics)
- Search
- RSS feed
- Content management system (MDX in git is the CMS)
- Comments or newsletter
- AI chatbot or "ask my CV" features
- `/projects` index for GitHub experiments
- Second case study (add when content is ready)
- `/work` index route (single case study doesn't need it)

---

## 13. Success Criteria

- Site loads on `arthur.buikis.com` and `buikis.com` (redirect) over HTTPS.
- Lighthouse Performance ≥ 95, Accessibility ≥ 95, Best Practices ≥ 95 on home and case study pages.
- Zero Dependabot critical/high alerts after migration.
- Dark/light toggle persists across page navigations and reloads.
- Case study content is rendered from MDX, editable without touching component code.
- CV PDF is downloadable and matches the career-ops-generated file.
- Contact form submits successfully via EmailJS to `arthur@buikis.com`.
- Works on mobile (< 640px), tablet (640-1024px), and desktop (≥ 1024px) without layout breaking.
- No reference to "RedBull", "currently between jobs", or any stale 2017-era phrasing remains.

---

## 14. Open Questions for Implementation Phase

- **Hero illustration/thumbnail:** no real screenshots for the Lethub case study (anonymized). What visual goes in the featured card? Options: abstract SVG placeholder, a simple code-styled graphic, a stylized architecture diagram. To be decided during implementation.
- **Snapshot numbers:** confirm the exact factual numbers ("12 years", "6 companies", etc.) match the CV before hardcoding.
- **Case study copy:** the actual prose for the Lethub/scraping/ML case study is content work, not design. Drafted separately during implementation, reviewed before shipping.
- **Building project name and status:** confirm what to call the personal product and how much to disclose publicly.
- **EmailJS template recipient:** the existing template (`template_hs71nnn`) needs its "To Email" field updated to `arthur@buikis.com` in the EmailJS dashboard. External, manual action required before the contact form ships.
