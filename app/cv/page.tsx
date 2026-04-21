import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import { cvHeadline, cvExperience } from '@/content/cv';
import { skills } from '@/content/about';
import { site } from '@/content/site';

export const metadata: Metadata = {
  title: 'CV',
  description: 'Senior full-stack engineer — Python, backend, data, DevOps.',
};

export default function CVPage() {
  return (
    <div className="mx-auto max-w-[1100px] px-6 py-16 lg:px-16 lg:py-24 print:py-8">
      <div className="flex items-start justify-between gap-8 flex-wrap">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--fg-muted)]">Curriculum Vitae</p>
          <h1 className="mt-3 font-serif text-5xl lg:text-6xl leading-[1.02]">{site.name}</h1>
          <p className="mt-4 text-[var(--fg-muted)] max-w-xl leading-[1.65]">{cvHeadline}</p>
        </div>
        <a href="/cv.pdf" download className="print:hidden">
          <Button variant="secondary">Download PDF</Button>
        </a>
      </div>

      <div className="mt-12 pt-8 border-t border-[var(--fg)]/10 grid gap-3 md:grid-cols-3 font-mono text-xs">
        <div><span className="text-[var(--fg-muted)]">Email: </span><a href={`mailto:${site.email}`} className="underline hover:text-[var(--accent)]">{site.email}</a></div>
        <div><span className="text-[var(--fg-muted)]">Location: </span>Latvia · Remote</div>
        <div>{site.socials.map((s, i) => <span key={s.href}>{i > 0 && ' · '}<a href={s.href} target="_blank" rel="noreferrer" className="underline hover:text-[var(--accent)]">{s.label}</a></span>)}</div>
      </div>

      <section className="mt-16">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Experience</p>
        <ul className="mt-6 space-y-10">
          {cvExperience.map((job) => (
            <li key={`${job.period}-${job.company}`}>
              <div className="flex flex-wrap items-baseline gap-x-4">
                <h2 className="font-serif text-2xl leading-tight">{job.role}</h2>
                <span className="font-mono text-xs text-[var(--fg-muted)]">&mdash; {job.company}</span>
                <span className="font-mono text-xs text-[var(--fg-muted)] ml-auto">{job.period}</span>
              </div>
              <ul className="mt-3 space-y-1.5 text-sm leading-[1.65] text-[var(--fg-muted)] max-w-3xl">
                {job.bullets.map((b, i) => (
                  <li key={i} className="flex gap-3"><span className="text-[var(--accent)]">&mdash;</span><span>{b}</span></li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-16 pt-8 border-t border-[var(--fg)]/10">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Stack</p>
        <div className="mt-6 grid gap-6 md:grid-cols-4">
          {Object.entries(skills).map(([group, items]) => (
            <div key={group}>
              <p className="font-serif text-lg mb-2">{group}</p>
              <p className="font-mono text-xs text-[var(--fg-muted)] leading-[1.7]">{items.join(' · ')}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
