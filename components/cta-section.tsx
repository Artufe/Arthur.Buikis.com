import Link from 'next/link';
import { site } from '@/content/site';

export function CtaSection() {
  return (
    <section className="relative mt-24 bg-[var(--fg)] text-[var(--bg)]">
      <div className="mx-auto max-w-[1600px] px-6 py-20 lg:px-16 lg:py-28">
        <p
          className="font-sans text-[9px] uppercase tracking-[0.24em]"
          style={{ color: 'color-mix(in srgb, var(--bg) 55%, transparent)' }}
        >
          Get in touch
        </p>
        <h2 className="mt-6 font-serif text-[44px] lg:text-[52px] leading-[1.05] tracking-tight font-medium max-w-[18ch]">
          Got something<br />that needs to hold up?
        </h2>
        <div className="mt-10 flex flex-wrap items-center gap-x-9 gap-y-5">
          <a
            href={`mailto:${site.email}`}
            className="font-serif text-[22px] underline underline-offset-[6px] decoration-[color-mix(in_srgb,var(--bg)_30%,transparent)] hover:decoration-[var(--accent)] hover:text-[var(--accent)] transition-colors duration-[var(--dur-base)]"
          >
            {site.email}
          </a>
          <Link
            href="/contact"
            className="font-mono text-[12px] px-4 py-2.5 border border-[var(--bg)] hover:bg-[var(--bg)] hover:text-[var(--fg)] transition-colors duration-[var(--dur-fast)]"
          >
            Book a 30-min call →
          </Link>
          <Link
            href="/cv"
            className="font-mono text-[12px] underline underline-offset-4 decoration-[color-mix(in_srgb,var(--bg)_30%,transparent)] hover:text-[var(--accent)] hover:decoration-[var(--accent)] transition-colors duration-[var(--dur-fast)]"
          >
            View the CV →
          </Link>
        </div>
      </div>
    </section>
  );
}
