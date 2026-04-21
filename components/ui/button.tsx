import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonStyles = cva(
  'relative inline-flex items-center justify-center font-sans font-medium tracking-[0.02em] transition-[background-color,color,box-shadow,border-color] duration-[var(--dur-base)] ease-[var(--ease-luxury)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--fg)] overflow-hidden group',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--fg)] text-[var(--bg)] shadow-[0_4px_16px_rgba(0,0,0,0.15)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.25)]',
        secondary:
          'border border-[var(--fg)] bg-transparent text-[var(--fg)] hover:bg-[var(--fg)] hover:text-[var(--bg)]',
        link:
          'text-[var(--fg)] underline decoration-[var(--fg)]/30 underline-offset-4 hover:text-[var(--accent)] hover:decoration-[var(--accent)] bg-transparent shadow-none',
      },
      size: {
        sm: 'h-10 px-5 text-xs',
        md: 'h-12 px-6 text-xs',
        lg: 'h-14 px-8 text-sm',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonStyles> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, children, ...props }, ref) => (
    <button ref={ref} className={cn(buttonStyles({ variant, size }), className)} {...props}>
      {variant === 'primary' && (
        <span
          aria-hidden
          className="absolute inset-0 translate-x-[-100%] bg-[var(--accent)] transition-transform duration-[var(--dur-base)] ease-[var(--ease-luxury)] group-hover:translate-x-0"
        />
      )}
      <span className="relative z-10">{children}</span>
    </button>
  )
);
Button.displayName = 'Button';
