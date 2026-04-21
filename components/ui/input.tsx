import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'w-full bg-transparent border-b border-[var(--fg)] px-0 py-2 h-12',
        'font-sans text-sm text-[var(--fg)]',
        'placeholder:font-serif placeholder:italic placeholder:text-[var(--fg-muted)]',
        'transition-colors duration-[var(--dur-fast)]',
        'focus:outline-none focus-visible:border-[var(--accent)]',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';
