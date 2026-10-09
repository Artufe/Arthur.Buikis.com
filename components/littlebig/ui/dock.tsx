// The mode dock: explore · bird · plane · drive · space · people. Real buttons (aria-pressed for
// the active one), number-key badges, a comic burst behind the active disc.

import { useState } from 'react';
import { BURST, ModeIcon } from './icons';
import { MODES, type ModeId } from './modes';
import { C } from './theme';

export function Dock({
  active,
  avail,
  onPick,
}: {
  active: ModeId;
  avail: Record<ModeId, boolean>;
  onPick(id: ModeId, viaPointer: boolean): void;
}) {
  // The button just clicked keeps its tooltip down until the pointer leaves it (the tip is for
  // finding a mode, and would otherwise hang over the view the mode just opened).
  const [quiet, setQuiet] = useState<ModeId | null>(null);
  return (
    <nav className="lbh-dock" aria-label="ways to see the planet">
      {MODES.map((m) => {
        const on = m.id === active;
        const ok = avail[m.id];
        return (
          <button
            key={m.id}
            type="button"
            className="lbh-mode"
            aria-pressed={on}
            aria-label={ok ? m.aria : `${m.aria} (nothing to ride yet)`}
            aria-keyshortcuts={m.key}
            disabled={!ok}
            style={{ ['--mc' as string]: m.color }}
            data-quiet={quiet === m.id ? '' : undefined}
            onClick={(e) => {
              if (e.detail > 0) setQuiet(m.id);
              onPick(m.id, e.detail > 0);
            }}
            onPointerLeave={() => setQuiet((q) => (q === m.id ? null : q))}
          >
            <span className="lbh-dwrap">
              <svg className="lbh-pow" viewBox="0 0 100 100" aria-hidden>
                <path d={BURST} fill={C.accent} stroke={C.ink} strokeWidth="3.5" strokeLinejoin="round" />
              </svg>
              <span className="lbh-disc">
                <ModeIcon id={m.id} size={m.id === 'explore' ? 26 : 25} />
              </span>
            </span>
            <span className="lbh-cap">{m.label}</span>
            <span className="lbh-key" aria-hidden>
              {m.key}
            </span>
            <span className="lbh-tip" aria-hidden>
              {m.aria}
              <kbd>{m.key}</kbd>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
