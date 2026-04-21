import type { Metadata } from 'next';
import { timeline, skills, beliefs } from '@/content/about';

export const metadata: Metadata = {
  title: 'About',
  description: 'Twelve years of Python, infra, and product work.',
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-[1600px] px-6 py-16 lg:px-16 lg:py-24">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--fg-muted)]">About</p>
      <h1 className="mt-4 font-serif text-[clamp(40px,5vw,64px)] leading-[1.02] tracking-tight max-w-3xl">
        The unshowy kind<br />of engineer.
      </h1>

      <section className="mt-20 max-w-2xl">
        <p className="text-lg leading-[1.75]">
          <span className="float-left font-serif text-7xl leading-[0.8] mr-3 mt-1">B</span>
          orn in Latvia, got my first computer at fourteen, and immediately started breaking things. Static sites, Minecraft servers, scripts to automate homework &mdash; by the time I left school I&apos;d self-taught Python and was running my first paid projects on Upwork.
        </p>
        <p className="mt-6 text-lg leading-[1.75]">
          Twelve years later, the itch is the same &mdash; figure out how a system works, then make it work better. The surface changes (Django monoliths, real-estate scrapers, ML pipelines, DevOps) but the job doesn&apos;t: ship something that quietly does its work, and keep doing that.
        </p>
      </section>

      <section className="mt-24 pt-12 border-t border-[var(--fg)]/10">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Where I&apos;ve been</p>
        <ul className="mt-8 space-y-6">
          {timeline.map((t) => (
            <li key={`${t.years}-${t.where}`} className="grid gap-2 md:grid-cols-12 md:items-baseline">
              <span className="font-mono text-xs text-[var(--fg-muted)] md:col-span-2">{t.years}</span>
              <span className="font-serif text-xl md:col-span-4">{t.role}</span>
              <span className="font-mono text-xs md:col-span-2">{t.where}</span>
              <span className="text-sm text-[var(--fg-muted)] md:col-span-4">{t.note}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-24 pt-12 border-t border-[var(--fg)]/10">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Stack</p>
        <div className="mt-8 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
          {Object.entries(skills).map(([group, items]) => (
            <div key={group}>
              <p className="font-serif text-lg mb-3">{group}</p>
              <ul className="space-y-1.5 font-mono text-xs text-[var(--fg-muted)]">
                {items.map((i) => <li key={i}>{i}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-24 pt-12 border-t border-[var(--fg)]/10">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">What I believe</p>
        <ul className="mt-8 grid gap-8 md:grid-cols-2 max-w-5xl">
          {beliefs.map((b, i) => (
            <li key={i} className="font-serif text-xl leading-[1.4] italic">
              <span className="text-[var(--accent)] mr-2 not-italic">&mdash;</span>{b}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
