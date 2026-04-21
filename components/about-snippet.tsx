import { ScrollReveal } from '@/components/scroll-reveal';

export function AboutSnippet() {
  return (
    <section className="mx-auto max-w-[1600px] px-6 py-24 lg:px-16 lg:py-32 border-t border-[var(--fg)]/10">
      <ScrollReveal>
        <div className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <p className="font-sans text-xl leading-[1.6] max-w-2xl">
              <span className="float-left font-serif text-7xl leading-[0.8] mr-3 mt-1">T</span>
              welve years of building software — starting with Python scripts on Upwork, growing into full-stack product work at Bridge Media, Lethub, and Strange Logic, and lately back to freelance consulting while building something of my own. The throughline: unshowy code that keeps running.
            </p>
          </div>
          <div className="lg:col-span-4 lg:col-start-9">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted)] mb-4">What I do</p>
            <ul className="space-y-3 text-sm">
              <li className="flex gap-3"><span className="text-[var(--accent)]">—</span>Backend services that carry real load</li>
              <li className="flex gap-3"><span className="text-[var(--accent)]">—</span>Data pipelines &amp; scraping at scale</li>
              <li className="flex gap-3"><span className="text-[var(--accent)]">—</span>Performance &amp; ML-adjacent integration</li>
            </ul>
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}
