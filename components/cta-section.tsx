import Link from 'next/link';
import { site } from '@/content/site';

export function CtaSection() {
  return (
    <section className="relative mt-24 bg-[var(--fg)] text-[var(--bg)]">
      <div className="mx-auto max-w-[1600px] px-6 py-24 lg:px-16 lg:py-32">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-70">Let&apos;s talk</p>
        <h2 className="mt-4 font-serif text-5xl lg:text-7xl leading-[1.02] tracking-tight max-w-4xl">
          Have a project that needs to quietly, reliably work?
        </h2>
        <div className="mt-12 flex flex-wrap items-center gap-8">
          <a href={`mailto:${site.email}`} className="font-serif text-2xl underline underline-offset-4 decoration-[var(--bg)]/40 hover:decoration-[var(--accent)] hover:text-[var(--accent)] transition-colors duration-[var(--dur-base)]">
            {site.email}
          </a>
          <Link href="/cv" className="font-mono text-xs underline underline-offset-4 decoration-[var(--bg)]/40 hover:decoration-[var(--accent)] hover:text-[var(--accent)] transition-colors">
            View the CV →
          </Link>
        </div>
      </div>
    </section>
  );
}
