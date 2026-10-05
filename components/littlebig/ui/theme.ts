// The HUD's colours and the few world constants it needs, mirrored as plain values on purpose: the
// HUD ships in the canvas chunk, and importing render/palette.ts or world/config.ts here would pull
// three and the engine's modules into it (and split them out of the engine's scope-hoisted chunk).
// theme.spec.ts keeps every mirrored value equal to its source.

import type { TrackKind } from '../core/contracts';

/** render/palette.ts, as CSS hex. */
export const C = {
  ink: '#1B1530',
  accent: '#FFB84D',
  cream: '#F3E9D2',
  paper: '#FFF8E8',
  terracotta: '#E07A5F',
  teal: '#3D9CA8',
  mustard: '#F2CC5B',
  coral: '#FF8A7A',
  lilac: '#A99CDA',
  glass: '#8EC9F0',
  roofRed: '#D9483B',
  grass: '#7BCB4A',
  sky: '#4FA8FF',
  marking: '#FFE066',
  snow: '#F7FBFF',
  space: '#070B1A',
} as const;

/** world/config.ts. */
export const WORLD = {
  R: 160,
  CITY_LON: 10,
  DAY_LENGTH: 480,
  START_HOUR_ANGLE: 64,
  SUN_DECLINATION: 10,
} as const;

/** The ride badge colour of each kind. */
export const KIND_COLOR: Record<TrackKind, string> = {
  plane: C.sky,
  balloon: C.sky,
  car: C.mustard,
  bus: C.mustard,
  truck: C.mustard,
  train: C.roofRed,
  boat: C.teal,
  ferry: C.teal,
  person: C.coral,
  satellite: C.lilac,
  station: C.lilac,
};

/** What the card's kind badge says. */
export const KIND_NAME: Record<TrackKind, string> = {
  plane: 'flight',
  balloon: 'balloon',
  car: 'car',
  bus: 'bus',
  truck: 'truck',
  train: 'train',
  boat: 'boat',
  ferry: 'ferry',
  person: 'local',
  satellite: 'satellite',
  station: 'station',
};

/** The HUD's display face: a rounded heavy system font where there is one (no downloads). */
export const FONT_POP = "ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', 'Nunito', 'Trebuchet MS', system-ui, sans-serif";
/** The site's mono (lowercase labels, details). */
export const FONT_MONO = "var(--font-body, ui-monospace, Menlo, monospace)";
