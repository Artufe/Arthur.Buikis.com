import type { ReactNode } from 'react';

export function Callout({ children }: { children: ReactNode }) {
  return (
    <aside className="my-8 border-l border-[var(--accent)] bg-[var(--bg-muted)]/50 p-6 text-sm leading-relaxed">
      {children}
    </aside>
  );
}
