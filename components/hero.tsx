import Link from 'next/link';
import { HeroMonitor } from '@/components/hero-monitor';
import { getGitStats } from '@/lib/git-stats';

export function Hero() {
  const gitStats = getGitStats();
  return (
    <section data-hero-region className="relative mx-auto max-w-[1600px] px-6 pt-20 pb-24 lg:px-16 lg:pt-28 lg:pb-32">
      <div className="grid gap-16 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-20">
        <div className="stagger">
          <div className="font-mono text-[11px] text-[var(--fg-muted)] tracking-wide" aria-hidden>
            <span className="text-[var(--accent)] mr-2">$</span>whoami --verbose
          </div>
          <h1 className="mt-6 font-serif text-[clamp(56px,7.2vw,108px)] leading-[0.96] font-medium max-w-[16ch] text-wrap-balance">
            Senior engineer.<br />
            Ships systems<br />
            that don&apos;t{' '}
            <em className="italic text-[var(--accent)]">break</em>
            <span className="text-[var(--accent)]">.</span>
          </h1>
          <p className="mt-8 font-serif italic text-[clamp(17px,2.2vw,24px)] leading-[1.35] text-[var(--fg)] max-w-[32ch] text-wrap-pretty">
            Python backend for about twelve years, with a bit of Rust lately. Currently working on a
            media-processing platform — the kind of place where things need to keep moving.
          </p>

          <dl className="mt-10 flex flex-wrap gap-x-10 gap-y-4 pt-5 border-t border-[var(--rule-strong)] font-mono text-[11px]">
            <div>
              <dt className="lbl mb-1.5">Focus</dt>
              <dd>backend · platform · perf</dd>
            </div>
            <div>
              <dt className="lbl mb-1.5">Stack</dt>
              <dd>python · rust (pyo3) · celery · k8s</dd>
            </div>
            <div>
              <dt className="lbl mb-1.5">Based</dt>
              <dd>riga · remote · eu-time</dd>
            </div>
          </dl>

          <div className="mt-10 flex flex-wrap items-center gap-6">
            <Link
              href="/#work"
              className="inline-flex h-12 items-center px-6 bg-[var(--fg)] text-[var(--bg)] font-sans text-[12px] tracking-wide uppercase hover:bg-[var(--accent)] hover:text-[var(--bg)] transition-colors duration-[var(--dur-base)]"
            >
              View work
            </Link>
            <a
              href="/cv.pdf"
              download
              className="font-mono text-[12px] text-[var(--fg-muted)] underline underline-offset-4 decoration-[var(--fg)]/30 hover:text-[var(--accent)] hover:decoration-[var(--accent)] transition-colors duration-[var(--dur-fast)]"
            >
              download_cv.pdf →
            </a>
          </div>
        </div>

        <div className="lg:pt-6 fade-in-late">
          <HeroMonitor gitStats={gitStats} />
        </div>
      </div>
    </section>
  );
}
