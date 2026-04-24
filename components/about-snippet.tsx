import { ScrollReveal } from '@/components/scroll-reveal';

const doList = [
  'Python backend. Rust in the hot spots where it earns it (PyO3, maturin, not everywhere).',
  'ML pipeline plumbing — getting models in, keeping the queue honest when things spike.',
  'Performance work when it matters. Indexes, rewrites, the kind of wins nobody notices.',
];

export function AboutSnippet() {
  return (
    <section className="mx-auto max-w-[1600px] px-6 py-20 lg:px-16 lg:py-28 border-t border-[var(--rule)]">
      <ScrollReveal>
        <div className="font-mono text-[11px] text-[var(--fg-muted)] mb-10">
          <span className="text-[var(--accent)] mr-2">$</span>cat about.md
        </div>
        <div className="grid gap-16 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <p className="text-[15px] leading-[1.85] max-w-[58ch] text-[var(--fg)]/90">
              <span className="float-left font-serif text-[72px] leading-[0.82] mr-3 mt-1">E</span>
              ight-ish years of Python backend, lately with a bit of Rust. I&apos;m at a
              media-processing platform right now, mostly working on performance and how the
              pipeline handles load. Before that: <em className="not-italic font-mono text-[13px] text-[var(--accent)]">strange-logic</em> (a SaaS called TDN — a lot
              of crawling, and a PHP-to-Python migration I pushed through), <em className="not-italic font-mono text-[13px] text-[var(--accent)]">lethub</em> (a scraping
              pipeline), and Upwork contracts on and off the whole time.
            </p>
          </div>
          <div>
            <p className="lbl">What I do</p>
            <ul className="mt-5 space-y-4">
              {doList.map((item, i) => (
                <li key={i} className="flex gap-3 text-[13px] leading-[1.6] text-[var(--fg)]/88">
                  <span className="font-mono text-[11px] text-[var(--fg-faint)] mt-0.5 min-w-[24px]">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}
