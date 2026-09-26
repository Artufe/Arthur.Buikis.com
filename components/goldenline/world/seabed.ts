// Underwater base height: nearshore slope, lagoon, reef shelf, steep reef front, channel, deep.
// OWNER: ocean agent. The swell's refraction, shoaling and breaking are baked from this, so the
// reef edge shape IS the wave shape. Keep it continuous with land.ts across the swash zone
// (both use the same beach face within ±12 m of the shoreline).
//
// The deep floor is flat (~30 m) right up to a steep reef front: the swell must reach the reef
// unrefracted, at an angle to the edge, or it would swing parallel to the reef and close out
// instead of peeling toward the pier.

import { CHANNEL, PIER, REEF, shoreX } from './layout';
import { fbm, vnoise } from './noise';

const ex = REEF.b.x - REEF.a.x;
const ez = REEF.b.z - REEF.a.z;
const elen = Math.hypot(ex, ez);
const ux = ex / elen;
const uz = ez / elen;

const DEEP = -30;

/** Height (m, negative underwater) of the seabed at (x, z), valid for x <= shoreX(z) + 20. */
export function seabedHeight(x: number, z: number) {
  const d = x - shoreX(z); // negative seaward
  // Nearshore sand: the beach face (same as land.ts) down to a softly rippled lagoon floor.
  const lagoon = -2.25 + 0.3 * fbm(x * 0.021, z * 0.021, 3);
  const near = Math.max(lagoon, -1.2 + d * 0.11);
  // Without a reef the sand shelves off into deep water well offshore.
  const base = near + (DEEP - lagoon) * smooth(-70, -230, d) + 0.8 * fbm(x * 0.004, z * 0.004, 2) * smooth(-120, -260, d);

  // Reef frame: `along` from a (the peak end) toward b, `across` shoreward of the edge line.
  const px = x - REEF.a.x;
  const pz = z - REEF.a.z;
  const along = px * ux + pz * uz;
  const alongT = along / elen;
  // An irregular edge: slow meanders plus spur-and-groove fingers on the front slope.
  const across = px * uz - pz * ux + 4.5 * fbm(along * 0.018, 3.7, 2);
  const presence = smooth(-0.1, 0.03, alongT) * (1 - smooth(0.88, 1.06, alongT));
  if (presence <= 0) return channel(base, x, z, d);

  const spurs = Math.sin(along * 0.43 + 2.2 * vnoise(along * 0.05, 1.3)) * smooth(-2, -8, across) * (1 - smooth(-30, -45, across));
  // Reef front: a near-vertical drop to ~12 m in 15 m, then down to the deep floor.
  const front = -1.9 - 10.5 * smooth(0, 15, -across) - (-DEEP - 12.4) * smooth(10, 120, -across) + 1.4 * spurs;
  // Reef top: coral flat with sand pockets and scattered bommies.
  const top = -REEF.topDepth + 0.32 * fbm(x * 0.07, z * 0.07, 4) + bommies(x, z);
  let h = mix(front, top, smooth(-3, 3, across));
  // Behind the shelf the reef gives way to the lagoon.
  h = mix(h, near, smooth(REEF.width - 12, REEF.width + 16, across));
  // Seaward of the reef, never shallower than the reef-free profile would be deep.
  if (across < 0) h = mix(h, Math.min(h, base), smooth(-30, -120, across));
  h = mix(base, h, presence);
  return channel(h, x, z, d);
}

/** The sand channel beside the pier: deeper, smooth, no reef. */
function channel(h: number, x: number, z: number, d: number) {
  const ch = smooth(CHANNEL.zMin - 12, CHANNEL.zMin, z) * (1 - smooth(CHANNEL.zMax, CHANNEL.zMax + 14, z));
  if (ch <= 0) return h;
  const chDepth = Math.max(-CHANNEL.depth - 7 * smooth(-60, PIER.tipX, d) + 0.25 * fbm(x * 0.03, z * 0.03, 2), -1.2 + d * 0.11);
  return h + (Math.min(h, chDepth) - h) * ch * smooth(-6, -28, d);
}

/** Coral heads on the reef flat: ~one per 11 m cell, 2–5 m across, rising 0.2–0.7 m. */
function bommies(x: number, z: number) {
  const cs = 11;
  const cx = Math.floor(x / cs);
  const cz = Math.floor(z / cs);
  let s = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const hx = hash(cx + i, cz + j);
      if (hx < 0.35) continue;
      const bx = (cx + i + hash(cz + j, cx + i + 7)) * cs;
      const bz = (cz + j + hash(cx + i + 3, cz + j + 11)) * cs;
      const r = 1 + 1.6 * hash(cx + i + 13, cz + j + 5);
      const q = ((x - bx) * (x - bx) + (z - bz) * (z - bz)) / (r * r);
      if (q < 1) s = Math.max(s, (0.2 + 0.5 * hx) * (1 - q) * (1 - q));
    }
  }
  return s;
}

function hash(x: number, y: number) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
