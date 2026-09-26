// Above-water base height: beach face, berm, dry upper beach, dune, headland rise.
// OWNER: beach agent. Keep it continuous with seabed.ts across the swash zone and keep
// it cheap (it is baked at boot and sampled by the player every frame).

import { shoreX } from './layout';
import { fbm } from './noise';

/**
 * Height (m) of the land surface at (x, z), valid for x >= shoreX(z) - 20. `d` is the
 * distance shoreward of the mean water line (negative = seaward).
 */
export function landHeight(x: number, z: number) {
  const d = x - shoreX(z);
  // Beach face: ~1:9 slope from -1.2 m in the swash zone up to the berm crest.
  const face = -1.2 + d * 0.11;
  // Berm and dry upper beach: nearly flat at ~2.6 m with long, soft undulation.
  const berm = 2.6 + 0.25 * fbm(x * 0.02, z * 0.02, 3) + Math.max(0, d - 34) * 0.018;
  // Dune line rising behind the beach.
  const duneT = Math.min(1, Math.max(0, (d - 58) / 26));
  const dune = duneT * duneT * (3 - 2 * duneT) * (5.5 + 2.5 * fbm(z * 0.012, 3.1, 3));
  const beach = Math.min(face, berm);
  return beach + dune;
}
