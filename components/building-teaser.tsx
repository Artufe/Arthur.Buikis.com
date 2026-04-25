import Link from 'next/link';
import { ScrollReveal } from '@/components/scroll-reveal';

export function BuildingTeaser() {
  return (
    <section className="mx-auto max-w-[1600px] px-6 py-20 lg:px-16 lg:py-28 border-t border-[var(--rule)]">
      <ScrollReveal>
        <div className="grid gap-14 lg:grid-cols-[1fr_1.5fr] items-start">
          <div>
            <p className="lbl">Currently</p>
            <p className="mt-3 font-serif text-[28px] leading-[1.12] tracking-tight">
              Building something<br />on the side.
            </p>
          </div>
          <div>
            <div
              className="border border-[var(--rule-strong)] bg-[var(--card)] px-4 py-3.5 max-w-[440px] flex flex-col gap-1"
              style={{ boxShadow: 'var(--panel-shadow)' }}
            >
              <span className="flex items-center gap-2 lbl">
                <span className="amber-dot" />
                Status
              </span>
              <span className="font-mono text-[14px] text-[var(--fg)]">prototype · private alpha</span>
              <span className="font-mono text-[10px] text-[var(--fg-faint)]">
                updated 2026-04 · thin on details for now
              </span>
            </div>

            <p className="mt-5 text-[14px] leading-[1.75] text-[var(--fg)]/85 max-w-[58ch]">
              A small product for operators who want what I want — in a space where the existing
              options feel clumsy. I&apos;m keeping the details thin while it&apos;s still
              prototype-stage. Full version lives at{' '}
              <Link href="/building" className="font-mono text-[13px] text-[var(--accent)] hover:underline underline-offset-4">
                /building
              </Link>
              .
            </p>

            <div className="mt-6 pt-5 border-t border-[var(--rule)] max-w-[58ch]">
              <p className="lbl mb-3">Recent updates</p>
              <ul className="font-mono text-[11px] text-[var(--fg-muted)] leading-[1.8] space-y-0.5">
                <li>2026-04-14 · first-run workflow survives a cold boot</li>
                <li>2026-03-28 · pulled redis pub/sub, put a durable queue in its place</li>
              </ul>
            </div>

            <Link
              href="/building"
              className="group mt-6 inline-flex font-mono text-[12px] text-[var(--fg-muted)] underline underline-offset-4 decoration-[var(--rule-strong)] hover:text-[var(--accent)] hover:decoration-[var(--accent)] transition-colors duration-[var(--dur-fast)]"
            >
              What I&apos;m working on →
            </Link>
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}
