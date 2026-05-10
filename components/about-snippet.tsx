import { ScrollReveal } from '@/components/scroll-reveal';

const doList = [
  'Python backend. Rust in the hot spots where it earns it (PyO3, maturin, not everywhere).',
  'ML pipeline plumbing — getting models in, keeping the queue honest when things spike.',
  'Performance work when it matters. Indexes, rewrites, the kind of wins nobody notices.',
];

export function AboutSnippet() {
  return (
    <section className="mx-auto max-w-[1600px] px-6 py-20 lg:px-16 lg:py-28" style={{ borderTop: '2px solid var(--border)' }}>
      <ScrollReveal>
        <div className="font-mono text-[12px] text-[var(--muted)] mb-10">
          <span className="ch mr-2">$</span>cat about.md
        </div>
        <div className="grid gap-16 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <p className="text-[15px] leading-[1.85] max-w-[58ch]" style={{ color: 'var(--fg)' }}>
              <span className="float-left font-display text-[72px] leading-[0.82] mr-3 mt-1">E</span>
              ight-ish years of Python backend, lately with a bit of Rust. I&apos;m at a
              media-processing platform right now, mostly working on performance and how the
              pipeline handles load. Before that: <em className="not-italic font-mono text-[13px] ch">strange-logic</em> (a SaaS called TDN — a lot
              of crawling, and a PHP-to-Python migration I pushed through), <em className="not-italic font-mono text-[13px] ch">lethub</em> (a scraping
              pipeline), and Upwork contracts on and off the whole time.
            </p>
          </div>
          <div>
            <p className="mono" style={{ marginBottom: 12 }}>What I do</p>
            <ul className="space-y-4">
              {doList.map((item, i) => (
                <li key={i} className="flex gap-3 text-[13px] leading-[1.6]" style={{ color: 'var(--fg)' }}>
                  <span className="font-mono text-[11px] dim mt-0.5 min-w-[24px]">
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
