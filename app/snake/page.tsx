import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'snake.py',
  description: 'Easter egg.',
};

export default function SnakePage() {
  return (
    <div className="min-h-[80vh] flex items-center justify-center font-mono text-[12px] text-[var(--fg-muted)]">
      &gt; snake.py — coming online
    </div>
  );
}
