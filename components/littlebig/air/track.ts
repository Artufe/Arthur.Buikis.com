// Air (L1, v2): cards and live lines for the planes and balloons the player can follow. The poses
// live in air/index.ts (they share its placement and dodge code); this is words only.

import type { LBContext } from '../core/contracts';
import { Biome } from '../world/planet';
import { R } from '../world/config';
import { headingOf, v3, type Vec3 } from '../world/sphere';
import { compass, kmh } from '../traffic/names';
import { BALLOONS, balloonAt, newBalloon, newPose, planePose, ROUTES } from './routes';
import { toSphere } from '../world/city/frame';

export const PLANE_CARDS = [
  { label: 'flight lb 204', sub: 'captain amelia · round the world, non-stop' },
  { label: 'flight lb 117', sub: 'captain orville · the long way round' },
  { label: 'flight lb 350', sub: 'captain bessie · sightseeing over the far side' },
  { label: 'flight lb 62', sub: 'captain wilbur · the polar shortcut' },
];

export const BALLOON_CARDS = [
  { label: 'marigold, a hot-air balloon', sub: 'pilot jacques · lunch in the basket' },
  { label: 'peppermint, a hot-air balloon', sub: 'pilot sophie · a birthday surprise' },
  { label: 'lavender, a hot-air balloon', sub: 'pilot bertrand · first flight, a bit nervous' },
];

const BIOME_WORDS: Record<number, string> = {
  [Biome.DeepOcean]: 'the open sea',
  [Biome.Shallows]: 'the shallows',
  [Biome.Beach]: 'the coast',
  [Biome.Grass]: 'the meadows',
  [Biome.Meadow]: 'the meadows',
  [Biome.Forest]: 'the woods',
  [Biome.Rock]: 'the mountains',
  [Biome.Snow]: 'the snowy peaks',
  [Biome.City]: 'the capital',
};

/**
 * What lies under unit direction `dir`: the nearest settlement or landmark label within ~25 m of
 * ground (ctx.services.labels, when the region system has added them), else the biome.
 */
export function overPlace(ctx: LBContext, dir: Vec3): string {
  let best = '';
  let bq = 1;
  for (const l of ctx.services.labels.list()) {
    if (l.track) continue;
    const ang = Math.acos(Math.min(1, l.dir.x * dir.x + l.dir.y * dir.y + l.dir.z * dir.z));
    // how far a place's name reaches (rad of arc): the capital's plateau, a town's pad, a landmark
    const reach = l.kind === 'capital' ? 0.5 : l.kind === 'city' ? 0.3 : l.kind === 'landmark' || l.kind === 'station' ? 0.08 : 0.16;
    const q = ang / reach;
    if (q < bq) {
      bq = q;
      best = l.text;
    }
  }
  if (best) return best;
  return BIOME_WORDS[ctx.world.planet.biomeAt(dir)] ?? 'somewhere nice';
}

const pose = newPose();
const bal = newBalloon();
const a = v3();
const b = v3();
const d = v3();

export function planeDetail(ctx: LBContext, i: number): string {
  const r = ROUTES[i];
  planePose(r, ctx.time.render, pose);
  const p = pose.pos;
  const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  d.x = p.x / len;
  d.y = p.y / len;
  d.z = p.z / len;
  return `alt ${Math.round(len - R)} m · ${kmh(r.omega * len)} · over ${overPlace(ctx, d)}`;
}

export function balloonDetail(ctx: LBContext, i: number): string {
  const bp = BALLOONS[i];
  const t = ctx.time.render;
  balloonAt(bp, t + 0.5, bal);
  toSphere(bal.x, bal.z, bal.h, a);
  balloonAt(bp, t - 0.5, bal);
  toSphere(bal.x, bal.z, bal.h, b);
  const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  d.x = a.x / len;
  d.y = a.y / len;
  d.z = a.z / len;
  b.x = a.x - b.x;
  b.y = a.y - b.y;
  b.z = a.z - b.z;
  const sp = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
  return `alt ${Math.round(len - R)} m · ${kmh(sp)} · drifting ${compass(headingOf(d, b))}`;
}
