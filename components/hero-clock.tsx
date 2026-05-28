'use client';

import { useEffect, useState } from 'react';

function formatCET(date: Date): string {
  // Europe/Riga is CET/CEST — use that as the local timezone.
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Riga',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  // ISO-ish but space-separated, CET suffix appended.
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} CET`;
}

export function HeroClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    setNow(new Date());
    if (reduced) return;

    const tick = () => setNow(new Date());
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span
      className="font-mono text-[11px] text-[var(--muted)] tnum hidden sm:inline whitespace-nowrap"
      aria-hidden
      suppressHydrationWarning
    >
      {now ? formatCET(now) : ''}
    </span>
  );
}
