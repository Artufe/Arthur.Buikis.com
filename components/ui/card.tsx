import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'group border-t border-[var(--fg)]/20 p-8 lg:p-12',
        'transition-[background-color,box-shadow] duration-[var(--dur-base)] ease-[var(--ease-luxury)]',
        'hover:bg-[var(--bg-muted)]/50 hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)]',
        className
      )}
      {...props}
    />
  );
}
