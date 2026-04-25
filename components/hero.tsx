import Link from 'next/link';
import { HeroMonitor } from '@/components/hero-monitor';

export function Hero() {
  return (
    <section className="relative mx-auto max-w-[1600px] px-6 pt-16 pb-20 lg:px-16 lg:pt-24 lg:pb-28">
      <div className="grid gap-14 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-16">
        <div className="stagger">
          <div className="font-mono text-[11px] text-[var(--fg-muted)] tracking-wide" aria-hidden>
            <span className="text-[var(--accent)] mr-2">$</span>whoami --verbose
          </div>
          <h1 className="mt-6 font-serif text-[clamp(40px,5.4vw,60px)] leading-[1.02] tracking-tight font-medium">
            Senior engineer.<br />
            Ships systems<br />
            that don&apos;t break.
          </h1>
          <p className="mt-6 max-w-[44ch] text-[15px] leading-[1.75] text-[var(--fg-muted)]">
            Python backend for about twelve years, with a bit of Rust lately. Currently working on a
            media-processing platform — the kind of place where things need to keep moving.
          </p>

          <dl className="mt-8 flex flex-wrap gap-x-8 gap-y-4 pt-4 border-t border-[var(--rule-strong)] font-mono text-[11px]">
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

          <div className="mt-8 flex flex-wrap items-center gap-5">
            <Link
              href="/#work"
              className="inline-flex h-11 items-center px-5 bg-[var(--fg)] text-[var(--bg)] font-sans text-[11px] tracking-wide uppercase hover:bg-[var(--accent)] hover:text-[var(--bg)] transition-colors duration-[var(--dur-base)]"
            >
              View work
            </Link>
            <a
              href="/cv.pdf"
              download
              className="font-mono text-[11px] text-[var(--fg-muted)] underline underline-offset-4 decoration-[var(--fg)]/30 hover:text-[var(--accent)] hover:decoration-[var(--accent)] transition-colors duration-[var(--dur-fast)]"
            >
              download_cv.pdf →
            </a>
          </div>
        </div>

        <div className="lg:pt-2 fade-in-late">
          <HeroMonitor />
        </div>
      </div>
    </section>
  );
}
