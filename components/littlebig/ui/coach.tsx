// The one-time coach mark (a comic speech bubble over the dock), the short notes that reuse its
// bubble ("nobody to ride from up here"), and the restyled hint row.

import { BURST_SMALL } from './icons';
import { C } from './theme';

export function Coach({ touch, onDone }: { touch: boolean; onDone(): void }) {
  return (
    <div className="lbh-coach" role="status">
      <span className="lbh-psst" aria-hidden>
        <svg viewBox="0 0 100 100">
          <path d={BURST_SMALL} fill={C.coral} stroke={C.ink} strokeWidth="5" strokeLinejoin="round" />
        </svg>
        <b>psst!</b>
      </span>
      <p>
        {touch ? 'tap' : 'click'} a car, a plane or a person to ride along
        <small>
          {/* The dock is below (portrait) or on the right (landscape rail): CSS shows the right one. */}
          <span className="lbh-c-below">or pick a ride below</span>
          <span className="lbh-c-side">or pick a ride on the right</span>
          {touch ? '' : <span style={{ whiteSpace: 'nowrap' }}> · keys 1–6</span>}
        </small>
      </p>
      <button type="button" className="lbh-ok" onClick={onDone}>
        got it
      </button>
    </div>
  );
}

export function Note({ text }: { text: string }) {
  return (
    <div className="lbh-coach" role="status" style={{ padding: '10px 16px' }}>
      <p style={{ fontSize: 13.5 }}>{text}</p>
    </div>
  );
}

/**
 * The hint row: segments split on ' · ', each *key* drawn as a chunky ink keycap chip.
 * snap: hide without the fade (the coach mark or a note is taking the stage).
 */
export function Hint({ text, on, snap = false }: { text: string; on: boolean; snap?: boolean }) {
  const parts = text.split(' · ');
  return (
    <div className="lbh-hint" data-off={on ? undefined : ''} data-snap={snap ? '' : undefined} aria-hidden={!on}>
      {parts.map((p, i) => (
        <span key={i} className="lbh-hseg">
          {p.split(/(\*[^*]+\*)/).map((bit, j) =>
            bit.startsWith('*') && bit.endsWith('*') && bit.length > 2 ? <kbd key={j}>{bit.slice(1, -1)}</kbd> : bit && <span key={j}>{bit}</span>,
          )}
        </span>
      ))}
    </div>
  );
}
