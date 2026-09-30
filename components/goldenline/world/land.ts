// Above-water base height: swash face with beach cusps, berm crest, backshore, foredune,
// back-dune swale and the vegetated hinterland. OWNER: beach agent. The face passes 0 m at the
// mean water line (d = 0); seabed.ts runs 1.2 m lower there, and terrain-shape.ts cross-fades
// the two over ±12 m, which reads as the steeper foreshore real beaches have. Cheap: baked at
// boot and sampled by the player every frame. Sub-metre detail is GPU-only.

import { shoreX } from './layout';
import { fbm, vnoise } from './noise';

const sm = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Along-shore phase of the beach cusps (m): rhythmic scallops ~24 m apart, slightly irregular. */
const cuspPhase = (z: number) => (z / 24 + 0.35 * vnoise(z * 0.013, 7.7)) * Math.PI * 2;

/**
 * Height (m) of the land surface at (x, z), valid for x >= shoreX(z) - 20. `d` is the
 * distance shoreward of the mean water line (negative = seaward).
 */
export function landHeight(x: number, z: number) {
  const d = x - shoreX(z);

  // Swash face: 1:9, through 0 m at the mean water line.
  let h = d * 0.11;
  // Beach cusps: horns build seaward, embayments scoop out, only in the upper swash zone.
  const cw = sm(-1, 5, d) * (1 - sm(11, 18, d));
  h += 0.2 * Math.cos(cuspPhase(z)) * cw;

  // Berm: the face rolls over a crest at ~31 m into a backshore that dips slightly landward,
  // then rises again to the foredune toe.
  const crest = 2.35 + 0.12 * fbm(z * 0.01, 1.3, 2);
  const over = sm(15, 27, d);
  const back = crest - 0.06 * sm(22, 36, d) + 0.02 * Math.max(0, d - 40) + 0.1 * fbm(x * 0.03, z * 0.03, 3);
  h = h + (Math.min(h, crest + 0.4) * (1 - over) + back * over - h) * sm(13, 25, d);
  h = Math.min(h, back + 0.25 * (1 - over));

  // Foredune: a steep seaward face to an irregular, hummocky crest with occasional blowouts.
  const toe = 54 + 5 * fbm(z * 0.008, 4.2, 2);
  const crestH = 6.2 + 2.6 * fbm(z * 0.011, 9.1, 3);
  const blow = sm(0.35, 0.6, fbm(z * 0.02, 2.2, 2)) * 2.2;
  const up = sm(toe, toe + 22, d);
  const down = sm(toe + 30, toe + 62, d);
  const hummock = 0.9 * fbm(x * 0.07, z * 0.07, 3) * sm(toe - 2, toe + 10, d);
  const dune = up * (crestH - blow) * (1 - 0.45 * down) + hummock;

  // Hinterland: the swale behind the dune, then low vegetated hills.
  const hills = sm(toe + 70, toe + 380, d) * (9 + 9 * fbm(x * 0.006, z * 0.006, 4));
  return h + dune + hills;
}
