import type { Metadata } from 'next';
import {
  timeline,
  throughline,
  atAGlance,
  stackGroups,
  sideThings,
  antiList,
  beliefs,
} from '@/content/about';

export const metadata: Metadata = {
  title: 'About',
  description: 'Backend & platform engineer · Riga · twelve-ish years in.',
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-[1600px]">
      {/* HEADER */}
      <header className="grid gap-14 lg:grid-cols-[1.3fr_1fr] lg:items-end px-6 pt-14 pb-12 lg:px-16 lg:pt-20 lg:pb-16">
        <div>
          <div className="font-mono text-[11px] text-[var(--fg-muted)]">
            <span className="text-[var(--accent)] mr-2">$</span>cat about.md
          </div>
          <h1 className="mt-5 font-serif text-[clamp(48px,7vw,80px)] leading-[0.96] tracking-[-0.03em] font-medium">
            The quiet end<br />of the stack.
          </h1>
          <p className="mt-5 font-mono text-[11px] text-[var(--fg-muted)] max-w-[50ch] leading-[1.75]">
            Arthur Buikis · Riga, LV · backend &amp; platform engineer · twelve-ish years in
          </p>
        </div>
        <div>
          <div className="aspect-[4/5] border border-[var(--rule-strong)] bg-[var(--card)] grayscale flex items-center justify-center">
            <div className="px-8 text-center font-mono text-[10px] text-[var(--fg-muted)] leading-[1.7]">
              <span className="text-[var(--accent)] font-medium">PORTRAIT · 4:5 crop</span>
              <br />
              <br />
              — desaturated b&amp;w
              <br />
              — natural light, no studio
              <br />
              — matte finish
            </div>
          </div>
          <div className="mt-2.5 flex justify-between font-mono text-[10px] text-[var(--fg-muted)]">
            <span>riga · 2026</span>
            <span>—</span>
          </div>
        </div>
      </header>

      {/* INTRO */}
      <section className="grid gap-16 lg:grid-cols-[1.4fr_1fr] px-6 py-14 lg:px-16 lg:py-16 border-t border-[var(--rule)]">
        <div className="text-[16px] leading-[1.8] text-[var(--fg)]/90 max-w-[62ch]">
          <p>
            <span className="float-left font-serif text-[80px] leading-[0.82] mr-3.5 mt-1">B</span>
            orn in Latvia, first computer at fourteen, immediately started breaking things. Static
            sites, Minecraft servers, scripts to skip homework — by the time school was done,
            I&apos;d self-taught Python well enough that people on Upwork were paying me to write
            it.
          </p>
          <p className="mt-6">
            Twelve-ish years later, the itch is the same. Figure out how a system works, then make
            it work better. The surface changes — Django monoliths, scraping pipelines, ML
            integrations, the occasional Rust extension — the job doesn&apos;t. Ship something that
            quietly does its work, and keep doing that.
          </p>
        </div>
        <div>
          <p className="lbl">At a glance</p>
          <ul className="mt-4 font-mono text-[12px] text-[var(--fg)]/80">
            {atAGlance.map((row) => (
              <li
                key={row.k}
                className="flex justify-between gap-3 py-2 border-b border-[var(--rule)] last:border-b-0"
              >
                <span className="text-[var(--fg-muted)]">{row.k}</span>
                <span>{row.v}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* TIMELINE */}
      <section className="px-6 py-14 lg:px-16 lg:py-16 border-t border-[var(--rule)]">
        <p className="lbl">Where I&apos;ve been</p>

        <div className="mt-7 border border-[var(--rule-strong)] px-4 py-3.5 flex flex-wrap gap-x-7 gap-y-3 font-mono text-[11px]">
          <div>
            <span className="lbl block mb-1">constant since</span>
            <span>{throughline.since}</span>
          </div>
          <div>
            <span className="lbl block mb-1">delivered</span>
            <span>{throughline.delivered}</span>
          </div>
          <div>
            <span className="lbl block mb-1">role</span>
            <span>{throughline.role}</span>
          </div>
        </div>

        <ul className="mt-6">
          {timeline.map((t, i) => (
            <li
              key={`${t.years}-${t.where}`}
              className={`grid gap-6 lg:grid-cols-[130px_1.1fr_1.1fr_1.6fr] py-5 border-t border-[var(--rule)] ${
                i === timeline.length - 1 ? 'border-b' : ''
              }`}
            >
              <span className="font-mono text-[11px] text-[var(--fg-muted)] flex items-center gap-2">
                <span
                  className={
                    t.dot === 'live'
                      ? 'live-dot'
                      : 'inline-block h-[6px] w-[6px] rounded-full bg-[var(--fg-faint)]'
                  }
                />
                {t.years}
              </span>
              <span className="font-serif text-[19px] tracking-tight">{t.role}</span>
              <span className="font-mono text-[11px] text-[var(--fg)]/80">{t.where}</span>
              <span className="text-[13px] leading-[1.6] text-[var(--fg-muted)]">{t.note}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* STACK */}
      <section className="px-6 py-14 lg:px-16 lg:py-16 border-t border-[var(--rule)]">
        <p className="lbl">Stack · what I actually reach for</p>
        <div className="mt-8 grid gap-10 md:grid-cols-2 lg:grid-cols-4">
          {stackGroups.map((g) => (
            <div key={g.title}>
              <h4 className="font-serif text-[19px] tracking-tight font-medium mb-3">{g.title}</h4>
              <ul className="font-mono text-[12px] text-[var(--fg)]/80 leading-[1.9]">
                {g.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] italic text-[var(--fg-faint)] max-w-[24ch] leading-[1.55]">
                {g.note}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* SIDE THINGS */}
      <section className="px-6 py-14 lg:px-16 lg:py-16 border-t border-[var(--rule)]">
        <p className="lbl">Side things · what I&apos;ve built on my own time</p>
        <div className="mt-8 grid gap-8 md:grid-cols-3">
          {sideThings.map((p) => (
            <div key={p.title} className="border-t border-[var(--rule-strong)] pt-5">
              <p className="font-mono text-[10px] text-[var(--fg-muted)] mb-3">{p.kind}</p>
              <h5 className="font-serif text-[22px] tracking-tight font-medium mb-3">{p.title}</h5>
              <p className="text-[13px] leading-[1.65] text-[var(--fg-muted)] mb-3.5">{p.body}</p>
              <p className="font-mono text-[10px] text-[var(--fg-muted)]">{p.meta}</p>
              {p.link && (
                <p className="mt-3.5">
                  <a
                    href={p.link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[11px] text-[var(--fg)]/80 underline underline-offset-4 decoration-[var(--rule-strong)] hover:text-[var(--accent)] hover:decoration-[var(--accent)] transition-colors duration-[var(--dur-fast)]"
                  >
                    {p.link.label}
                  </a>
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* WHAT I DON'T DO */}
      <section className="px-6 py-14 lg:px-16 lg:py-16 border-t border-[var(--rule)] bg-[var(--card)]">
        <div className="grid gap-14 lg:grid-cols-[1fr_2fr]">
          <div>
            <p className="lbl">What I don&apos;t do</p>
            <p className="mt-3 font-serif text-[28px] leading-[1.15] tracking-tight">A short anti-list.</p>
          </div>
          <ul>
            {antiList.map((item, i) => (
              <li
                key={i}
                className="flex gap-4 py-3.5 border-t border-[var(--rule)] last:border-b text-[14px] leading-[1.55] text-[var(--fg)]/80"
              >
                <span className="font-mono text-[var(--fg-faint)] min-w-[18px]">—</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* BELIEFS */}
      <section className="px-6 py-14 lg:px-16 lg:py-16 border-t border-[var(--rule)]">
        <p className="lbl">What I believe</p>
        <div className="mt-8 grid gap-8 md:grid-cols-2 max-w-[1100px]">
          {beliefs.map((b, i) => (
            <p
              key={i}
              className="font-serif italic text-[20px] leading-[1.4] text-[var(--fg)]/92"
            >
              <span className="text-[var(--accent)] not-italic font-mono text-[14px] mr-2.5">—</span>
              {b}
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}
