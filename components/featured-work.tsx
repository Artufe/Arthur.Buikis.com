import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { MetaRow } from '@/components/ui/meta-row';
import { ScrollReveal } from '@/components/scroll-reveal';

export function FeaturedWork() {
  return (
    <section id="work" className="mx-auto max-w-[1600px] px-6 py-24 lg:px-16 lg:py-32 border-t border-[var(--fg)]/10">
      <ScrollReveal>
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Selected work</p>
            <p className="mt-2 font-serif text-3xl lg:text-4xl leading-tight">One case,<br />many systems.</p>
          </div>
          <div className="lg:col-span-8 lg:col-start-5">
            <Link href="/work/lethub-scraping-ml" className="block">
              <Card className="border-t border-[var(--fg)]/30">
                <div className="aspect-[4/3] w-full mb-8 overflow-hidden relative bg-[var(--bg-muted)] flex items-center justify-center">
                  {/* Placeholder geometric graphic — replace with real illustration later */}
                  <svg viewBox="0 0 400 300" className="w-2/3 opacity-60 grayscale transition-all duration-[var(--dur-cinematic)] group-hover:grayscale-0 group-hover:opacity-100" fill="none" stroke="currentColor" strokeWidth="1">
                    <rect x="40" y="40" width="120" height="80" />
                    <rect x="80" y="60" width="120" height="80" />
                    <rect x="120" y="80" width="120" height="80" />
                    <line x1="240" y1="120" x2="340" y2="120" />
                    <line x1="240" y1="140" x2="340" y2="140" />
                    <line x1="240" y1="160" x2="340" y2="160" />
                    <circle cx="200" cy="240" r="6" />
                    <circle cx="230" cy="240" r="6" />
                    <circle cx="260" cy="240" r="6" />
                  </svg>
                </div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)]">Case study · 2022–2024</p>
                <h3 className="mt-3 font-serif text-4xl lg:text-5xl leading-[1.05]">
                  Scraping, ML, and the cost of running quietly.
                </h3>
                <p className="mt-5 text-[var(--fg-muted)] leading-[1.65] max-w-2xl">
                  Anonymized lessons from Lethub and real-estate data work — where the hard part wasn&apos;t the ML model, it was the ten other systems that had to hold up around it.
                </p>
                <MetaRow
                  className="mt-8"
                  items={[
                    { label: 'Role', value: 'Lead dev' },
                    { label: 'Stack', value: 'python · playwright · postgres · ml' },
                    { label: 'Duration', value: '2 years' },
                    { label: 'Outcome', value: '10x throughput, <1% error' },
                  ]}
                />
                <p className="mt-8 font-mono text-xs underline underline-offset-4 decoration-[var(--fg)]/30 group-hover:decoration-[var(--accent)] group-hover:text-[var(--accent)] transition-colors">
                  Read the story →
                </p>
              </Card>
            </Link>
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}
