import { ScrollReveal } from '@/components/scroll-reveal';

const stats = [
  { value: '30–800×', label: 'Hot-path\nlatency wins' },
  { value: '12', label: 'ML clients\nplumbed in' },
  { value: '43 TB', label: 'One scraping\npipeline’s output' },
];

export function Snapshot() {
  return (
    <section className="mx-auto max-w-[1600px] px-6 py-20 lg:px-16 lg:py-28 border-t border-[var(--rule)]">
      <ScrollReveal>
        <div className="grid gap-10 md:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label}>
              <p className="font-serif text-[60px] leading-[0.9] tracking-tight">{s.value}</p>
              <div className="mt-3 h-px w-full bg-[var(--accent)]" style={{ height: 2 }} />
              <p className="mt-4 font-sans text-[10px] uppercase tracking-[0.22em] text-[var(--fg-muted)] leading-[1.5] whitespace-pre-line">
                {s.label}
              </p>
            </div>
          ))}
        </div>
      </ScrollReveal>
    </section>
  );
}
