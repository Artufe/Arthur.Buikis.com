// The sun / moon button: eases sim time forward to the next evening (moon) or morning (sun) over
// the place you are looking at. A progress ring fills while it warps; pressing again stops.

import { IconMoon, IconSun } from './icons';
import { C } from './theme';

export interface TimeState {
  to: 'evening' | 'morning';
  /** 0..1 while warping, else null. */
  progress: number | null;
  disabled: boolean;
}

const RING_R = 27;
const RING_C = 2 * Math.PI * RING_R;

export function TimeButton({ state, onPress }: { state: TimeState; onPress(viaPointer: boolean): void }) {
  const warping = state.progress !== null;
  const evening = state.to === 'evening';
  const label = warping ? `stop the clock (heading for ${state.to})` : evening ? 'fast-forward to evening' : 'fast-forward to morning';
  return (
    <button
      type="button"
      className="lbh-time"
      aria-label={label}
      aria-pressed={warping}
      disabled={state.disabled}
      data-warp={warping ? '' : undefined}
      onClick={(e) => onPress(e.detail > 0)}
    >
      <span className="lbh-tcap" aria-hidden>
        <small>{warping ? 'warping to' : 'skip to'}</small>
        {state.to}
      </span>
      <span className="lbh-tdisc" style={{ ['--td' as string]: evening ? C.lilac : C.sky }}>
        {warping && (
          <svg className="lbh-ring" viewBox="0 0 62 62" aria-hidden>
            <circle cx="31" cy="31" r={RING_R} fill="none" stroke="rgba(27,21,48,.35)" strokeWidth="5" />
            <circle
              cx="31"
              cy="31"
              r={RING_R}
              fill="none"
              stroke={C.accent}
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={`${(RING_C * Math.max(0.02, state.progress ?? 0)).toFixed(1)} ${RING_C.toFixed(1)}`}
            />
          </svg>
        )}
        {evening ? <IconMoon size={26} /> : <IconSun size={28} />}
      </span>
    </button>
  );
}
