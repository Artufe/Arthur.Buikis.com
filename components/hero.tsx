'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { MetaRow } from '@/components/ui/meta-row';

export function Hero() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <section className="relative mx-auto max-w-[1600px] px-6 pt-16 pb-24 lg:px-16 lg:pt-24 lg:pb-32">
      {isDark && (
        <div className="font-mono text-xs text-[var(--fg-muted)] mb-4" aria-hidden>
          <span className="text-[var(--accent)] mr-2">$</span>whoami --verbose
        </div>
      )}
      <h1 className="font-serif text-[clamp(40px,5.5vw,72px)] leading-[1.02] tracking-tight max-w-4xl font-medium">
        Senior engineer.<br />
        Ships systems<br />
        that don&apos;t break.
      </h1>
      <p className="mt-6 max-w-md text-[var(--fg-muted)] leading-[1.65]">
        Twelve years of Python, data, and infrastructure — the unshowy kind of work that keeps things running.
      </p>
      <MetaRow
        className="mt-8 max-w-3xl"
        items={[
          { label: 'Focus', value: 'backend · data · infra' },
          { label: 'Stack', value: 'python · django · docker' },
          { label: 'Based in', value: 'latvia · remote' },
        ]}
      />
      <div className="mt-10 flex flex-wrap items-center gap-4">
        <Link href="/#work"><Button>View work</Button></Link>
        <a href="/cv.pdf" download className="font-mono text-xs underline underline-offset-4 decoration-[var(--fg)]/30 hover:decoration-[var(--accent)] hover:text-[var(--accent)] transition-colors">
          download_cv.pdf →
        </a>
      </div>
    </section>
  );
}
