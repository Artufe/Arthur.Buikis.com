// Inline SVG icons for the HUD: chunky cartoon shapes, ink strokes (currentColor) and a fill colour
// from the CSS variable --lbf (the button decides: cream on an idle disc, white on an active one).

import type { TrackKind } from '../core/contracts';
import type { ModeId } from './modes';

const S = { stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const F = 'var(--lbf, #FFF8E8)';

function Svg({ children, size = 24 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false" style={{ display: 'block', overflow: 'visible' }}>
      {children}
    </svg>
  );
}

export function IconExplore({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <g transform="rotate(-18 12 12)">
        <ellipse cx="12" cy="12" rx="10.6" ry="3.7" fill="none" {...S} />
        <circle cx="12" cy="12" r="6.6" fill={F} {...S} />
        <path d="M8.6 9.6c1.3-.9 2.6-.5 3 .5.5 1.1 1.9.9 2.4 2" fill="none" {...S} strokeWidth={1.6} />
        <path d="M1.4 12a10.6 3.7 0 0 0 21.2 0" fill="none" {...S} />
      </g>
    </Svg>
  );
}

export function IconBird({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M4.6 13.2 1.6 11l.9 4.6z" fill={F} {...S} />
      <ellipse cx="10.6" cy="14.2" rx="6.6" ry="4.6" fill={F} {...S} />
      <circle cx="16.4" cy="10.8" r="3.4" fill={F} {...S} />
      <path d="m19.5 10.2 3.1 1-3 1.2z" fill="#FFB84D" {...S} strokeWidth={1.6} />
      <circle cx="17.3" cy="10.2" r="0.95" fill="currentColor" />
      <path d="M7.4 13.4c.6-5 4.4-7.6 7.3-7-1.7 1.6-2.6 4.2-3 7.4z" fill={F} {...S} />
    </Svg>
  );
}

export function IconPlane({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M4.4 11.2 3.2 6h2.9l2.8 5.1z" fill={F} {...S} />
      <path d="M2.6 13.4c0-1.5 1.4-2.3 3-2.3h11.2c3.2 0 5.6 1.1 5.6 2.4 0 1.3-2.4 2.3-5.6 2.3H5.6c-1.6 0-3-.8-3-2.4z" fill={F} {...S} />
      <path d="M10 14.6 13.4 20.6h2.6l-1.4-6" fill={F} {...S} />
      <circle cx="11.6" cy="12.9" r="0.9" fill="currentColor" />
      <circle cx="14.2" cy="12.9" r="0.9" fill="currentColor" />
      <path d="M18.4 11.5c1.1.2 2 .7 2.4 1.3h-2.6z" fill="currentColor" />
    </Svg>
  );
}

export function IconBus({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="2" y="5.6" width="19.6" height="11.4" rx="2.6" fill={F} {...S} />
      <path d="M4.6 8.4h3.2v3.4H4.6zM9.6 8.4h3.2v3.4H9.6zM14.6 8.4h3.4v3.4h-3.4z" fill="#8EC9F0" {...S} strokeWidth={1.5} />
      <path d="M2 13.8h19.6" fill="none" {...S} strokeWidth={1.5} />
      <circle cx="7" cy="17.4" r="2.3" fill="currentColor" />
      <circle cx="16.6" cy="17.4" r="2.3" fill="currentColor" />
      <circle cx="7" cy="17.4" r="0.8" fill={F} />
      <circle cx="16.6" cy="17.4" r="0.8" fill={F} />
    </Svg>
  );
}

export function IconSatellite({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M7.4 12h-1M17.6 12h-1" fill="none" {...S} />
      <rect x="1" y="8.6" width="5.4" height="6.8" rx="0.8" fill="#8EC9F0" {...S} />
      <rect x="17.6" y="8.6" width="5.4" height="6.8" rx="0.8" fill="#8EC9F0" {...S} />
      <path d="M3.7 8.6v6.8M20.3 8.6v6.8" fill="none" {...S} strokeWidth={1.3} />
      <rect x="8.4" y="8.4" width="7.2" height="7.2" rx="1.6" fill={F} {...S} />
      <path d="M12 8.4V5.6" fill="none" {...S} />
      <path d="M9.4 4.6a3 3 0 0 0 5.2 0z" fill={F} {...S} strokeWidth={1.6} />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    </Svg>
  );
}

export function IconPerson({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M4.6 21.4c0-5 3.2-7.2 7.4-7.2s7.4 2.2 7.4 7.2z" fill={F} {...S} />
      <circle cx="12" cy="8.4" r="4.6" fill={F} {...S} />
      <circle cx="10.3" cy="8.4" r="0.95" fill="currentColor" />
      <circle cx="13.7" cy="8.4" r="0.95" fill="currentColor" />
      <path d="M10.6 10.6c.8.6 2 .6 2.8 0" fill="none" {...S} strokeWidth={1.4} />
    </Svg>
  );
}

export function IconBalloon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 2.4c4 0 6.6 2.8 6.6 6.2 0 3.6-3.6 6.2-5 8.2h-3.2c-1.4-2-5-4.6-5-8.2 0-3.4 2.6-6.2 6.6-6.2z" fill={F} {...S} />
      <path d="M12 2.4c-1.6 2-2.2 4.6-1.6 14.4M12 2.4c1.6 2 2.2 4.6 1.6 14.4" fill="none" {...S} strokeWidth={1.4} />
      <rect x="9.8" y="18.6" width="4.4" height="3.2" rx="0.6" fill="currentColor" />
    </Svg>
  );
}

export function IconBoat({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M11.4 3v11.4H4.6z" fill={F} {...S} />
      <path d="M13.2 6.2v8.2h5z" fill={F} {...S} />
      <path d="M2.4 15.6h19.2l-2.6 4.4H5z" fill="#E07A5F" {...S} />
    </Svg>
  );
}

export function IconTrain({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="4.4" y="3" width="15.2" height="14" rx="3.4" fill={F} {...S} />
      <path d="M6.8 6.2h10.4v4.6H6.8z" fill="#8EC9F0" {...S} strokeWidth={1.5} />
      <circle cx="8.6" cy="14" r="1.1" fill="currentColor" />
      <circle cx="15.4" cy="14" r="1.1" fill="currentColor" />
      <path d="m7.4 17-2.2 4M16.6 17l2.2 4" fill="none" {...S} />
    </Svg>
  );
}

export function IconCar({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M2.6 15.6v-2.8c0-1 .6-1.6 1.6-1.8l2.6-.5 2.4-3.1c.5-.6 1.1-.9 1.9-.9h3.4c.8 0 1.5.4 1.9 1l2 3 1.6.4c1 .3 1.4 1 1.4 1.9v2.8z" fill={F} {...S} />
      <path d="M9.6 10.4 11 8.2h2.1v2.2zM15 10.4h-.2V8.2h.3l1.4 2.2z" fill="#8EC9F0" {...S} strokeWidth={1.3} />
      <circle cx="7" cy="16" r="2.3" fill="currentColor" />
      <circle cx="17" cy="16" r="2.3" fill="currentColor" />
      <circle cx="7" cy="16" r="0.8" fill={F} />
      <circle cx="17" cy="16" r="0.8" fill={F} />
    </Svg>
  );
}

export function IconSun({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <g fill="none" {...S} strokeWidth={2.2}>
        <path d="M12 1.6v2.6M12 19.8v2.6M1.6 12h2.6M19.8 12h2.6M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" />
      </g>
      <circle cx="12" cy="12" r="5.2" fill="#FFB84D" {...S} />
      <path d="M10 12.6c.6.9 3.4.9 4 0" fill="none" {...S} strokeWidth={1.4} />
      <circle cx="10.2" cy="10.8" r="0.8" fill="currentColor" />
      <circle cx="13.8" cy="10.8" r="0.8" fill="currentColor" />
    </Svg>
  );
}

export function IconMoon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M15.6 3.2a8.6 8.6 0 1 0 5.2 13.4A7 7 0 0 1 15.6 3.2z" fill="#F2CC5B" {...S} />
      <circle cx="11" cy="13.6" r="1.1" fill="currentColor" opacity="0.35" />
      <circle cx="8.2" cy="9.6" r="0.8" fill="currentColor" opacity="0.35" />
      <path d="M19.4 4.4v3M17.9 5.9h3" fill="none" {...S} strokeWidth={1.5} />
    </Svg>
  );
}

export function IconChevron({ dir, size = 20 }: { dir: 'left' | 'right'; size?: number }) {
  return (
    <Svg size={size}>
      <path d={dir === 'left' ? 'M15 4.6 7.6 12l7.4 7.4' : 'M9 4.6l7.4 7.4L9 19.4'} fill="none" {...S} strokeWidth={3} />
    </Svg>
  );
}

export function IconClose({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" fill="none" {...S} strokeWidth={3.2} />
    </Svg>
  );
}

export function IconStar({ size = 14 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="m12 1.8 3 6.4 7 .8-5.2 4.8 1.4 7-6.2-3.5-6.2 3.5 1.4-7L2 9l7-.8z" fill="currentColor" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" />
    </Svg>
  );
}

export function IconAnchor({ size = 14 }: { size?: number }) {
  return (
    <Svg size={size}>
      <g fill="none" {...S} strokeWidth={2.6}>
        <circle cx="12" cy="4.8" r="2.4" />
        <path d="M12 7.2v14M7.4 11h9.2M3.6 14c.6 4.4 4.2 7 8.4 7s7.8-2.6 8.4-7" />
      </g>
    </Svg>
  );
}

/** A comic starburst (`spikes` points), as a path in a 0..100 box. */
export function burstPath(spikes = 14, inner = 0.78, jitter = 0.06): string {
  let d = '';
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    // A fixed wobble (no randomness: the same burst every render).
    const wob = 1 + jitter * Math.sin(i * 2.3 + 0.7);
    const r = (i % 2 === 0 ? 50 : 50 * inner) * (i % 2 === 0 ? wob : 1);
    d += `${i === 0 ? 'M' : 'L'}${(50 + Math.cos(a) * r * 0.96).toFixed(1)} ${(50 + Math.sin(a) * r * 0.96).toFixed(1)}`;
  }
  return d + 'Z';
}

export const BURST = burstPath(14, 0.76);
export const BURST_SMALL = burstPath(10, 0.7, 0.04);

export function ModeIcon({ id, size }: { id: ModeId; size?: number }) {
  switch (id) {
    case 'explore':
      return <IconExplore size={size} />;
    case 'bird':
      return <IconBird size={size} />;
    case 'plane':
      return <IconPlane size={size} />;
    case 'drive':
      return <IconBus size={size} />;
    case 'space':
      return <IconSatellite size={size} />;
    case 'people':
      return <IconPerson size={size} />;
  }
}

export function KindIcon({ kind, size }: { kind: TrackKind | 'bird'; size?: number }) {
  switch (kind) {
    case 'plane':
      return <IconPlane size={size} />;
    case 'balloon':
      return <IconBalloon size={size} />;
    case 'car':
    case 'truck':
      return <IconCar size={size} />;
    case 'bus':
      return <IconBus size={size} />;
    case 'train':
      return <IconTrain size={size} />;
    case 'boat':
    case 'ferry':
      return <IconBoat size={size} />;
    case 'person':
      return <IconPerson size={size} />;
    case 'satellite':
    case 'station':
      return <IconSatellite size={size} />;
    case 'bird':
      return <IconBird size={size} />;
  }
}
