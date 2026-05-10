import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'relative inline-flex items-center justify-center font-mono tracking-[0.02em] transition-colors duration-[var(--dur)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] overflow-hidden',
        variant === 'primary'
          ? 'h-12 px-6 text-[12px] uppercase tracking-[0.12em] bg-[var(--fg)] text-[var(--bg)] hover:bg-[var(--accent)]'
          : 'h-11 px-5 text-[11px] uppercase tracking-[0.08em] border-2 border-[var(--border)] bg-transparent text-[var(--fg)] hover:bg-[var(--fg)] hover:text-[var(--bg)]',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
);
Button.displayName = 'Button';
