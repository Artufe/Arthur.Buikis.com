'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface StatItem {
  value: string;
  label: string;
}

function isNumeric(v: string) {
  return /^\d+$/.test(v);
}

function StatCell({ item }: { item: StatItem }) {
  const [display, setDisplay] = useState(item.value);
  const [counted, setCounted] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isNumeric(item.value)) return;

    const el = ref.current;
    if (!el) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const target = parseInt(item.value, 10);
    if (isNaN(target)) return;

    setDisplay('0');
    setCounted(false);

    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        obs.disconnect();
        let current = 0;
        const step = () => {
          current++;
          setDisplay(String(current));
          if (current >= target) {
            setDisplay(item.value);
            setCounted(true);
            return;
          }
          setTimeout(step, 30 + Math.random() * 40);
        };
        step();
      },
      { threshold: 0.3 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [item.value]);

  return (
    <div ref={ref} className="stat">
      <div className={cn('num tnum', counted && 'counted')} data-target={item.value}>
        {display}
      </div>
      <div className="lbl">{item.label}</div>
    </div>
  );
}

export function AnimatedStats({ items }: { items: StatItem[] }) {
  return (
    <div className="stats">
      {items.map((item, i) => (
        <StatCell key={item.label + i} item={item} />
      ))}
    </div>
  );
}
