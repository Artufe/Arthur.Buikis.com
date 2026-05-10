import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full bg-transparent border-2 border-[var(--border)] px-3 py-2.5',
        'font-mono text-[14px] text-[var(--fg)] resize-none leading-[1.5]',
        'placeholder:font-mono placeholder:text-[var(--muted)]',
        'transition-colors duration-[var(--dur)]',
        'focus:outline-none focus-visible:border-[var(--accent)]',
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = 'Textarea';
