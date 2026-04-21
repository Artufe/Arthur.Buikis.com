import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { ScrollReveal } from '@/components/scroll-reveal';

export function BuildingTeaser() {
  return (
    <section className="mx-auto max-w-[1600px] px-6 py-24 lg:px-16 lg:py-32 border-t border-[var(--fg)]/10">
      <ScrollReveal>
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Currently</p>
            <p className="mt-2 font-serif text-3xl lg:text-4xl leading-tight">Building something<br />of my own.</p>
          </div>
          <div className="lg:col-span-7 lg:col-start-6">
            <Link href="/building" className="block">
              <Card className="border-t border-[var(--fg)]/30">
                <p className="font-mono text-xs text-[var(--accent)]">status: prototype</p>
                <p className="mt-4 text-lg leading-[1.65] max-w-2xl">
                  A product platform for people who want what I want — the short version lives on the building page. Honest updates, no launch-hype.
                </p>
                <p className="mt-6 font-mono text-xs underline underline-offset-4 decoration-[var(--fg)]/30 group-hover:decoration-[var(--accent)] group-hover:text-[var(--accent)] transition-colors">
                  What I&apos;m working on →
                </p>
              </Card>
            </Link>
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}
