import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full bg-transparent border-b border-[var(--fg)] px-0 py-2',
        'font-sans text-sm text-[var(--fg)] resize-none',
        'placeholder:font-serif placeholder:italic placeholder:text-[var(--fg-muted)]',
        'transition-colors duration-[var(--dur-fast)]',
        'focus:outline-none focus-visible:border-[var(--accent)]',
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = 'Textarea';
