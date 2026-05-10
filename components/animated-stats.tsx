'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface StatItem {
  value: string;
  label: string;
}

function isNumeric(v: string) {
  return /^\d+$/.test(v);
}

function StatCell({ item, index }: { item: StatItem; index: number }) {
  const [display, setDisplay] = useState('0');
  const [counted, setCounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isNumeric(item.value)) {
      setDisplay(item.value);
      return;
    }

    const el = ref.current;
    if (!el) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(item.value);
      setCounted(true);
      return;
    }

    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        obs.disconnect();
        const target = parseInt(item.value, 10);
        if (isNaN(target)) {
          setDisplay(item.value);
          setCounted(true);
          return;
        }
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
      <div className={cn('num tnum', counted && 'counted')}>{display}</div>
      <div className="lbl">{item.label}</div>
    </div>
  );
}

export function AnimatedStats({ items }: { items: StatItem[] }) {
  return (
    <div className="stats">
      {items.map((item, i) => (
        <StatCell key={item.label + i} item={item} index={i} />
      ))}
    </div>
  );
}
