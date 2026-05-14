import Link from 'next/link';
import { ScrollReveal } from '@/components/scroll-reveal';

export function BuildingTeaser() {
  return (
    <section
      className="mx-auto max-w-[1600px] px-6 py-20 lg:px-16 lg:py-28"
      style={{ borderTop: '2px solid var(--border)' }}
    >
      <ScrollReveal>
        <div className="grid gap-14 lg:grid-cols-[1fr_1.5fr] items-start">
          <div>
            <p className="mono" style={{ marginBottom: 12 }}>Currently</p>
            <h2 className="font-display text-[28px] leading-[1.12] tracking-tight" style={{ margin: 0 }}>
              Building something <br />on the side.
            </h2>
          </div>
          <div>
            <div className="card" style={{ padding: '14px 18px', maxWidth: 440, marginBottom: 0 }}>
              <span className="mono" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span className="inline-block h-[6px] w-[6px]" style={{ background: 'var(--accent)' }} />
                Status
              </span>
              <span className="font-mono text-[14px]" style={{ color: 'var(--fg)' }}>prototype · private alpha</span>
              <span className="font-mono text-[10px] dim" style={{ display: 'block', marginTop: 2 }}>
                updated 2026-04 · thin on details for now
              </span>
            </div>

            <p className="mt-5 text-[14px] leading-[1.75] max-w-[58ch]" style={{ color: 'var(--fg)' }}>
              A small product for operators who want what I want — in a space where the existing
              options feel clumsy. I&apos;m keeping the details thin while it&apos;s still
              prototype-stage. Full version lives at{' '}
              <Link href="/building" className="font-mono text-[13px] ch hover:underline underline-offset-4">
                /building
              </Link>
              .
            </p>

            <div className="mt-6 pt-5 max-w-[58ch]" style={{ borderTop: '2px solid var(--border)' }}>
              <p className="mono" style={{ marginBottom: 8 }}>Recent updates</p>
              <ul className="font-mono text-[11px] dim leading-[1.8] space-y-0.5">
                <li>2026-04-14 · first-run workflow survives a cold boot</li>
                <li>2026-03-28 · pulled redis pub/sub, put a durable queue in its place</li>
              </ul>
            </div>

            <Link
              href="/building"
              className="group mt-6 inline-flex font-mono text-[12px] dim underline underline-offset-4 decoration-[var(--border)] hover:text-[var(--accent)] hover:decoration-[var(--accent)] transition-colors duration-[var(--dur)]"
            >
              What I&apos;m working on →
            </Link>
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}
