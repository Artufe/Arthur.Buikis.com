// The BRIEF §3 palette as named colours: ONE place for the look pass (B4) to retint the world.
// Every system imports its base colours from here instead of hard-coding hex values; derive
// variants (darker, lerped) from these at init. Treat the Color objects as read-only (clone before
// mutating). Values are sRGB hex, converted to linear by three's ColorManagement.

import { Color } from 'three';

const c = (hex: string) => new Color(hex);

export const PALETTE = {
  ocean: { deep: c('#1E6FD9'), shallow: c('#3FD0E0'), foam: c('#FFFFFF') },
  ground: { sand: c('#F6D98B'), grass: c('#7BCB4A'), meadow: c('#A6DB5E'), forest: c('#2F8F4E'), rock: c('#9A8F87'), snow: c('#F7FBFF') },
  road: { asphalt: c('#4A4E5A'), marking: c('#FFE066'), sidewalk: c('#E6E1D6') },
  /** Building walls, in Building.wall index order. */
  walls: [c('#F3E9D2'), c('#E07A5F'), c('#3D9CA8'), c('#F2CC5B'), c('#FF8A7A'), c('#A99CDA'), c('#8EC9F0')],
  /** Roofs, in Building.roofColor index order. */
  roofs: [c('#D9483B'), c('#5B6B8C'), c('#5BA35B')],
  sky: { top: c('#4FA8FF'), horizon: c('#BDE6FF'), space: c('#070B1A'), rim: c('#7FD3FF') },
  /** The site accent: sun glints, HUD. */
  accent: c('#FFB84D'),
  ink: c('#1B1530'),
} as const;
