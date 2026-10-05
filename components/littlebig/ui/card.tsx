// The follow card: what you are riding (kind badge in a comic burst, name, route, a live line at
// ≤ 4 Hz), prev / next of the same kind, and the way out.

import { useEffect, useRef } from 'react';
import type { TrackKind } from '../core/contracts';
import { BURST_SMALL, IconChevron, IconClose, KindIcon } from './icons';
import { C, KIND_COLOR, KIND_NAME } from './theme';

export interface CardInfo {
  /** Changes with the ride: the card pops in again. */
  key: string;
  kind: TrackKind | 'bird';
  title: string;
  sub?: string;
  detail: string;
  /** Prev / next available (more than one of the kind, or of its mode). */
  canCycle: boolean;
}

/**
 * 'a · b · c' with a no-break space before each dot (a wrap never starts a line with '·') and
 * short segments held together ('53 km/h', 'over land' never split across lines).
 */
function dots(text: string): string {
  return text
    .split(' · ')
    .map((seg) => (seg.length <= 22 ? seg.replace(/ /g, '\u00a0') : seg))
    .join('\u00a0· ');
}

export function FollowCard({
  info,
  leaving = false,
  onCycle,
  onExit,
}: {
  info: CardInfo;
  /** Playing its exit (the ride just ended): inert. */
  leaving?: boolean;
  onCycle(dir: 1 | -1, viaPointer: boolean): void;
  onExit(): void;
}) {
  // A new ride pops the card again. (It stays mounted, so a focused prev / next keeps its focus.)
  const ref = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (first.current) {
      first.current = false;
      return;
    }
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }, [info.key]);
  const color = info.kind === 'bird' ? C.grass : KIND_COLOR[info.kind];
  const kindName = info.kind === 'bird' ? 'you' : KIND_NAME[info.kind];
  return (
    <section
      ref={ref}
      className="lbh-card"
      aria-label={`riding: ${info.title}`}
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      data-out={leaving ? '' : undefined}
      style={{ ['--kc' as string]: color }}
    >
      <div className="lbh-badge" aria-hidden>
        <svg viewBox="0 0 100 100">
          <path d={BURST_SMALL} fill={color} stroke={C.ink} strokeWidth="4" strokeLinejoin="round" />
        </svg>
        <KindIcon kind={info.kind} size={30} />
      </div>
      <div className="lbh-head">
        <span className="lbh-kind">{kindName}</span>
        <h2 className="lbh-title" style={{ margin: 0 }}>
          {info.title}
        </h2>
        {info.sub && <span className="lbh-sub">{dots(info.sub)}</span>}
      </div>
      <div className="lbh-row">
        {info.canCycle && (
          <button type="button" className="lbh-btn" aria-label="previous ride" aria-keyshortcuts="[" onClick={(e) => onCycle(-1, e.detail > 0)}>
            <IconChevron dir="left" />
          </button>
        )}
        <div className="lbh-live" aria-live="off">
          <i aria-hidden />
          <span>{dots(info.detail)}</span>
        </div>
        {info.canCycle && (
          <button type="button" className="lbh-btn" aria-label="next ride" aria-keyshortcuts="]" onClick={(e) => onCycle(1, e.detail > 0)}>
            <IconChevron dir="right" />
          </button>
        )}
      </div>
      <button type="button" className="lbh-x" aria-label="stop riding (esc)" aria-keyshortcuts="Escape" onClick={onExit}>
        <IconClose />
      </button>
    </section>
  );
}
