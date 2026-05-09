'use client';

import type { ConsoleLine } from './snake-types';

export function SnakeConsole({ lines }: { lines: ConsoleLine[] }) {
  return (
    <div className="hidden md:flex flex-col gap-1 px-3 py-2 border-l border-[var(--rule)] bg-[var(--bg)]/40 font-mono text-[11px] min-w-[200px] max-h-full overflow-hidden">
      {lines.length === 0 && <div className="text-[var(--fg-faint)]">&gt;&gt;&gt;</div>}
      {lines.map((l) => (
        <div key={l.id} className={l.level === 'panic' ? 'text-[#ff7070]' : 'text-[var(--fg)]/85'}>
          {l.text}
        </div>
      ))}
    </div>
  );
}
