import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[1600px] px-6 py-24 lg:px-16 lg:py-32 min-h-[60vh] flex flex-col justify-center">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--fg-muted)]">404</p>
      <h1 className="mt-4 font-serif text-6xl lg:text-8xl leading-[1.02]">Not here.</h1>
      <p className="mt-6 max-w-md text-[var(--fg-muted)]">
        Wrong URL, or maybe a page I haven&apos;t written yet. Head back home or take a look at the work.
      </p>
      <div className="mt-10 flex gap-6">
        <Link href="/" className="font-mono text-xs underline underline-offset-4 decoration-[var(--fg)]/30 hover:decoration-[var(--accent)] hover:text-[var(--accent)] transition-colors">
          ← Home
        </Link>
        <Link href="/#work" className="font-mono text-xs underline underline-offset-4 decoration-[var(--fg)]/30 hover:decoration-[var(--accent)] hover:text-[var(--accent)] transition-colors">
          Work →
        </Link>
      </div>
    </div>
  );
}
