import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface MetaItem {
  label: string;
  value: ReactNode;
}

export function MetaRow({ items, className }: { items: MetaItem[]; className?: string }) {
  return (
    <dl
      className={cn(
        'flex flex-wrap gap-x-10 gap-y-6 pt-4 border-t border-[var(--fg)]/12 font-mono text-xs',
        className
      )}
    >
      {items.map((item) => (
        <div key={item.label}>
          <dt className="block font-sans text-[9px] uppercase tracking-[0.2em] text-[var(--fg-muted)] mb-1.5">
            {item.label}
          </dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
