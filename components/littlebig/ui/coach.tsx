// The one-time coach mark (a comic speech bubble), the short notes that reuse its bubble ("nobody
// to ride from up here"), and the restyled hint row.

import { forwardRef, useLayoutEffect, useRef } from 'react';
import { BURST_SMALL } from './icons';
import { C } from './theme';

/** Where the coach bubble sits (hud.tsx picks the one clear of the planet; styles.ts places it). */
export type CoachPos = 'bc' | 'bl' | 'tl';

export const Coach = forwardRef<HTMLDivElement, { touch: boolean; pos: CoachPos; onDone(): void }>(function Coach({ touch, pos, onDone }, ref) {
  return (
    <div ref={ref} className="lbh-coach" role="status" data-cpos={pos}>
      <span className="lbh-psst" aria-hidden>
        <svg viewBox="0 0 100 100">
          <path d={BURST_SMALL} fill={C.coral} stroke={C.ink} strokeWidth="5" strokeLinejoin="round" />
        </svg>
        <b>psst!</b>
      </span>
      <p className="lbh-c-main">{touch ? 'tap' : 'click'} a car, a plane or a person to ride along</p>
      <p className="lbh-c-sub">
        {/* The dock is below (portrait) or on the right (landscape rail): CSS shows the right one. */}
        <span className="lbh-c-below">or pick a ride below</span>
        <span className="lbh-c-side">or pick one on the right</span>
        {touch ? '' : <span className="lbh-c-keys"> · keys 1–6</span>}
      </p>
      <button type="button" className="lbh-ok" onClick={onDone}>
        got it
      </button>
    </div>
  );
});

export const Note = forwardRef<HTMLDivElement, { text: string; pos: CoachPos }>(function Note({ text, pos }, ref) {
  return (
    <div ref={ref} className="lbh-coach lbh-note" role="status" data-cpos={pos}>
      <p className="lbh-c-main">{text}</p>
    </div>
  );
});

/** A hint row: segments, each with how long it is kept when the row must shrink (higher = kept longer). */
export type HintDef = readonly (readonly [text: string, keep: number])[];

/** Where the hint row sits (hud.tsx; styles.ts): under the card, bottom left, top centre, above the dock. */
export type HintSlot = 'stack' | 'bl' | 'top' | 'bottom';

/**
 * The hint row: one paper pill, each *key* drawn as a chunky ink keycap chip. When the pill is wider
 * than its slot, the least important segments are left out (never cut mid-word): `fitKey` re-fits it
 * after a layout change. snap: hide without the fade (the coach mark or a note is taking the stage).
 */
export function Hint({ hint, on, slot, fitKey, snap = false }: { hint: HintDef; on: boolean; slot: HintSlot; fitKey: string; snap?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const segs = Array.from(el.children) as HTMLElement[];
    const mark = () => {
      let first = true;
      for (const s of segs) {
        if (s.hidden) continue;
        s.toggleAttribute('data-first', first);
        first = false;
      }
    };
    for (const s of segs) s.hidden = false;
    mark();
    let shown = segs.length;
    while (shown > 1 && el.scrollWidth > el.clientWidth + 0.5) {
      // The least kept one goes (the later one on a tie).
      let drop = -1;
      for (let i = 0; i < segs.length; i++) if (!segs[i].hidden && (drop < 0 || (hint[i]?.[1] ?? 0) <= (hint[drop]?.[1] ?? 0))) drop = i;
      segs[drop].hidden = true;
      shown--;
      mark();
    }
  }, [hint, fitKey]);
  return (
    <div ref={ref} className="lbh-hint" data-slot={slot} data-off={on ? undefined : ''} data-snap={snap ? '' : undefined} aria-hidden={!on}>
      {hint.map(([p], i) => (
        <span key={i} className="lbh-hseg">
          {p.split(/(\*[^*]+\*)/).map((bit, j) =>
            bit.startsWith('*') && bit.endsWith('*') && bit.length > 2 ? <kbd key={j}>{bit.slice(1, -1)}</kbd> : bit && <span key={j}>{bit}</span>,
          )}
        </span>
      ))}
    </div>
  );
}
