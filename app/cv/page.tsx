import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import { cvHeadline, cvExperience, cvProjects, cvLanguages } from '@/content/cv';
import { stackGroups } from '@/content/about';
import { site } from '@/content/site';

export const metadata: Metadata = {
  title: 'CV',
  description: 'Senior backend / platform engineer — Python, Rust, data pipelines, Kubernetes.',
};

export default function CVPage() {
  return (
    <div className="mx-auto max-w-[1100px] px-6 py-16 lg:px-16 lg:py-24 print:py-8">
      <div className="flex items-start justify-between gap-8 flex-wrap">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--fg-muted)]">Curriculum Vitae</p>
          <h1 className="mt-3 font-serif text-5xl lg:text-6xl leading-[1.02]">{site.name}</h1>
          <p className="mt-5 text-[var(--fg-muted)] max-w-2xl leading-[1.7]">{cvHeadline}</p>
        </div>
        <a href="/cv.pdf" download className="print:hidden">
          <Button variant="secondary">Download PDF</Button>
        </a>
      </div>

      <div className="mt-12 pt-8 border-t border-[var(--fg)]/10 grid gap-3 md:grid-cols-3 font-mono text-xs">
        <div>
          <span className="text-[var(--fg-muted)]">Email: </span>
          <a href={`mailto:${site.email}`} className="underline hover:text-[var(--accent)]">{site.email}</a>
        </div>
        <div>
          <span className="text-[var(--fg-muted)]">Based: </span>
          Riga, LV · Remote · EU-time
        </div>
        <div>
          {site.socials.map((s, i) => (
            <span key={s.href}>
              {i > 0 && ' · '}
              <a href={s.href} target="_blank" rel="noreferrer" className="underline hover:text-[var(--accent)]">{s.label}</a>
            </span>
          ))}
        </div>
      </div>

      <section className="mt-16">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Experience</p>
        <ul className="mt-8 space-y-14">
          {cvExperience.map((job) => (
            <li key={`${job.period}-${job.company}`}>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h2 className="font-serif text-2xl leading-tight">{job.role}</h2>
                <span className="font-mono text-xs text-[var(--fg-muted)]">— {job.company}</span>
                <span className="font-mono text-xs text-[var(--fg-muted)] ml-auto">{job.period}</span>
              </div>

              {job.blurb && (
                <p className="mt-4 text-[15px] leading-[1.7] text-[var(--fg-muted)] max-w-3xl">{job.blurb}</p>
              )}

              {job.bullets.length > 0 && (
                <ul className="mt-5 space-y-2.5 text-[14px] leading-[1.7] text-[var(--fg-muted)] max-w-3xl">
                  {job.bullets.map((b, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="text-[var(--accent)] flex-none select-none">—</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}

              {job.stack && (
                <p className="mt-5 font-mono text-[11px] leading-[1.7] text-[var(--fg-faint)] max-w-3xl">
                  <span className="lbl mr-2">Stack</span>{job.stack}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-20 pt-8 border-t border-[var(--rule)]">
        <p className="lbl">Selected projects</p>
        <ul className="mt-6 grid gap-8 md:grid-cols-3">
          {cvProjects.map((p) => (
            <li key={p.name}>
              <p className="font-serif text-xl leading-tight">
                {p.link ? (
                  <a
                    href={p.link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-[var(--fg)]/20 underline-offset-4 hover:text-[var(--accent)] hover:decoration-[var(--accent)]"
                  >
                    {p.name}
                  </a>
                ) : (
                  p.name
                )}
              </p>
              <p className="mt-3 text-sm leading-[1.65] text-[var(--fg-muted)]">{p.body}</p>
              {p.meta && <p className="mt-3 font-mono text-[10px] text-[var(--fg-faint)]">{p.meta}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-20 pt-8 border-t border-[var(--rule)]">
        <p className="lbl">Stack</p>
        <div className="mt-6 grid gap-6 md:grid-cols-4">
          {stackGroups.map((g) => (
            <div key={g.title}>
              <p className="font-serif text-lg mb-2">{g.title}</p>
              <p className="font-mono text-xs text-[var(--fg-muted)] leading-[1.7]">{g.items.join(' · ')}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-20 pt-8 border-t border-[var(--rule)]">
        <p className="lbl">Languages</p>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 md:grid-cols-4 font-mono text-xs">
          {cvLanguages.map((l) => (
            <li
              key={l.name}
              className="flex items-baseline justify-between gap-3 border-b border-[var(--rule)] pb-2"
            >
              <span>{l.name}</span>
              <span className="text-[var(--fg-muted)]">{l.level}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
