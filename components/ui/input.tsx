import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'w-full bg-transparent border-2 border-[var(--border)] px-3 py-2.5 h-11',
        'font-mono text-[14px] text-[var(--fg)]',
        'placeholder:font-mono placeholder:text-[var(--muted)]',
        'transition-colors duration-[var(--dur)]',
        'focus:outline-none focus-visible:border-[var(--accent)]',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';
