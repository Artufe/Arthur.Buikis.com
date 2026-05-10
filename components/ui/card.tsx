import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'group border-t border-[var(--fg)]/20 p-8 lg:p-12',
        'transition-colors duration-[var(--dur)]',
        className
      )}
      {...props}
    />
  );
}
