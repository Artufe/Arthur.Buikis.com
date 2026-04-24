import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'w-full bg-transparent border-b border-[var(--rule-strong)] px-0 py-2.5 h-11',
        'font-mono text-[14px] text-[var(--fg)]',
        'placeholder:font-serif placeholder:italic placeholder:text-[var(--fg-faint)]',
        'transition-colors duration-[var(--dur-fast)]',
        'focus:outline-none focus-visible:border-[var(--accent)]',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';
