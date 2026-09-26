// Underwater base height: nearshore slope, reef shelf, reef edge drop-off, channel, deep water.
// OWNER: ocean agent. The breaking-wave system derives shoaling from this, so the reef edge
// shape IS the wave shape. Keep it continuous with land.ts across the swash zone.

import { CHANNEL, PIER, REEF, shoreX } from './layout';
import { fbm } from './noise';

const ex = REEF.b.x - REEF.a.x;
const ez = REEF.b.z - REEF.a.z;
const elen = Math.hypot(ex, ez);
const ux = ex / elen;
const uz = ez / elen;

/** Height (m, negative underwater) of the seabed at (x, z), valid for x <= shoreX(z) + 20. */
export function seabedHeight(x: number, z: number) {
  const d = x - shoreX(z); // negative seaward
  // Nearshore sand: continues the beach face, then flattens into a ~-2.2 m lagoon.
  const near = Math.max(-2.2, -1.2 + d * 0.11);

  // Signed distance from the reef edge line: >0 shoreward (on the shelf), <0 seaward.
  const px = x - REEF.a.x;
  const pz = z - REEF.a.z;
  const along = px * ux + pz * uz;
  const across = -(px * -uz + pz * ux); // left normal of a→b points seaward; flip so + is shoreward
  const alongT = along / elen;
  // Reef presence fades out at both ends of the edge line.
  const endFade = smooth(-0.15, 0.05, alongT) * (1 - smooth(0.92, 1.12, alongT));

  const reefTop = -REEF.topDepth + 0.5 * fbm(x * 0.06, z * 0.06, 4);
  const onShelf = smooth(-6, 4, across) * (1 - smooth(REEF.width - 20, REEF.width + 10, across));
  const deep = -14 - 12 * smooth(0, 160, -across) + 1.5 * fbm(x * 0.01, z * 0.01, 3);

  // Seaward of the edge: drop into deep water. Shoreward: the shelf, then back to the lagoon.
  let h = across < 0 ? deep : near;
  h = h + (reefTop - h) * onShelf * endFade;
  // Blend the deep water in wherever the reef is absent offshore.
  const offshore = smooth(-40, -140, d);
  h = h + (Math.min(h, deep) - h) * offshore * (1 - onShelf * endFade);

  // Sand channel beside the pier: deeper, smooth, no reef.
  const ch = smooth(CHANNEL.zMin - 10, CHANNEL.zMin, z) * (1 - smooth(CHANNEL.zMax, CHANNEL.zMax + 12, z));
  const chDepth = Math.max(-CHANNEL.depth - 6 * smooth(-60, PIER.tipX, d), -1.2 + d * 0.11);
  h = h + (Math.min(h, chDepth) - h) * ch * smooth(-8, -30, d);
  return h;
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
