import type { ReactNode } from 'react';

export function Callout({ children }: { children: ReactNode }) {
  return (
    <aside className="my-8 border-l-2 border-[var(--accent)] p-6 text-sm leading-relaxed" style={{ background: 'color-mix(in srgb, var(--bg) 95%, var(--accent))' }}>
      {children}
    </aside>
  );
}
