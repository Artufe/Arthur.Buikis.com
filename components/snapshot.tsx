import { ScrollReveal } from '@/components/scroll-reveal';

const stats = [
  { value: '12', label: 'years shipping' },
  { value: '6', label: 'companies' },
  { value: '2015', label: 'first line of python' },
];

export function Snapshot() {
  return (
    <section className="mx-auto max-w-[1600px] px-6 py-24 lg:px-16 lg:py-32 border-t border-[var(--fg)]/10">
      <ScrollReveal>
        <div className="grid gap-12 md:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label}>
              <p className="font-serif text-6xl lg:text-7xl leading-none">{s.value}</p>
              <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--fg-muted)]">{s.label}</p>
            </div>
          ))}
        </div>
      </ScrollReveal>
    </section>
  );
}
