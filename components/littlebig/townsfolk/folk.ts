// LITTLEBIG v2 townsfolk (T2): who lives in each town. Pure and seeded: how many walk its streets (by
// its dwellings and its character), their looks (the capital's crowd palette, people/sim makeLooks,
// dressed for the place: winter coats and hats in the snow, shorts at the resort, oilskins on the
// quay, dark suits in the city), their pace and their follow cards ('ines, off to the market' over
// 'far haven'), and the looks of the ones who stay put (keepers, sunbathers, a kid at the fountain).

import { dwelling, type Site } from '../towns/plan';
import { FEM, KIDS, MASC, nameAt } from '../traffic/names';
import { LookFlag, makeLooks, type Look } from '../people/sim';
import { hash3, hashSeed } from '../world/rng';
import type { Settlement } from '../world/region/types';
import { PK, POSE, type Net } from './net';
import type { Folk } from './sim';

/** Walkers per dwelling, by style, and the least a town has. */
const PER: Record<string, number> = { metro: 1.65, harbour: 1.2, farm: 0.95, alpine: 1.25, resort: 4 };

const WINTER = [0xd9483b, 0x2e3a6b, 0x2f5a52, 0x8e5bb5, 0xe2543f, 0x3d78c8, 0xf2a93b];
const SUMMER = [0xff8a7a, 0xf2cc5b, 0x47b39d, 0x5aa9e6, 0xf49ac2, 0xf7f3ea, 0xffb84d];
const SUITS = [0x2e3a6b, 0x5b6b8c, 0x3a3540, 0xf7f3ea];
const LINES: Record<string, string[]> = {
  metro: ['late for a meeting', 'on the lunch break', 'off to the market', 'window shopping', 'on a coffee run', 'heading down to the docks', 'between meetings'],
  harbour: ['back from the boats', 'off to the fish market', 'watching the boats come in', 'taking the sea air', 'off to buy bait', 'mending a net, later'],
  farm: ['off to feed the hens', 'back from the fields', 'off to the village shop', 'out for a stroll', 'off to see the ducks'],
  alpine: ['off to the lift', 'back from the slopes', 'off for a hot chocolate', 'walking off the fondue', 'admiring the snow'],
  resort: ['off for a swim', 'looking for a good spot', 'off to the beach bar', 'on holiday, finally', 'reapplying sun cream'],
};

const kid = (l: Look) => (l.flags & LookFlag.Kid) !== 0;
const fem = (l: Look) => !kid(l) && ((l.flags & LookFlag.Dress) !== 0 || l.hairStyle === 2 || l.hairStyle === 3);

/** Dress a look for its town. */
function dress(l: Look, style: string, r: number): void {
  if (style === 'alpine') {
    l.flags &= ~(LookFlag.ShortSleeve | LookFlag.Shorts | LookFlag.Dress | LookFlag.Umbrella);
    l.shirt = WINTER[Math.floor(r * 97) % WINTER.length];
    if (r < 0.55) l.hairStyle = 4;
    l.acc = WINTER[Math.floor(r * 31) % WINTER.length];
  } else if (style === 'resort') {
    l.flags = (l.flags | LookFlag.ShortSleeve | (l.flags & LookFlag.Dress ? 0 : r < 0.6 ? LookFlag.Shorts : 0)) & ~LookFlag.Umbrella;
    l.shirt = SUMMER[Math.floor(r * 97) % SUMMER.length];
  } else if (style === 'metro' && !kid(l) && r < 0.4) {
    l.shirt = SUITS[Math.floor(r * 97) % SUITS.length];
    l.legs = r < 0.2 ? 0x2b2f4a : 0x3a3540;
    l.flags &= ~LookFlag.Shorts;
  } else if (style === 'harbour' && !kid(l) && r < 0.3) {
    l.shirt = r < 0.07 ? 0xf2cc5b : 0x2e3a6b;
    l.hairStyle = 4;
    l.acc = 0x2e3a6b;
  } else if (style === 'farm' && !kid(l) && r < 0.45) l.legs = 0x3b5b92;
}

export interface Townsfolk {
  /** Walkers' looks and cards (walker k is 'person:<first + k>'). */
  looks: Look[];
  cards: Array<{ label: string; sub: string }>;
  /** Walking pace (m/s), lateral preference, dog walker. */
  v: number[];
  pref: number[];
  dog: boolean[];
}

/** How many walk town s's streets (its plan site counts its dwellings). */
export function walkers(s: Settlement, site: Site): number {
  const dw = site.items.reduce((n, it) => n + +dwelling(it.t), 0);
  return Math.round(Math.max(s.style === 'resort' ? 16 : 10, Math.min(78, dw * (PER[s.style] ?? 1))));
}

export function townsfolk(s: Settlement, n: number, seed: number): Townsfolk {
  const ts = hashSeed(seed, `townsfolk:${s.id}`);
  const looks = makeLooks(ts, n);
  const cards: Townsfolk['cards'] = [], v: number[] = [], pref: number[] = [], dog: boolean[] = [];
  let kids = 0, fems = 0, mascs = 0;
  const lines = LINES[s.style] ?? LINES.farm;
  looks.forEach((l, i) => {
    const r = hash3(i, 3, ts);
    dress(l, s.style, r);
    // dog walkers: grown-ups with a free left hand
    const d = !(l.flags & (LookFlag.Kid | LookFlag.Bag | LookFlag.Umbrella)) && hash3(i, 5, ts) < 0.12;
    if (d) l.flags = (l.flags | LookFlag.Leash) & ~LookFlag.Phone;
    dog.push(d);
    const name = kid(l) ? nameAt(KIDS, ts, kids++) : fem(l) ? nameAt(FEM, ts, fems++) : nameAt(MASC, ts, mascs++);
    const line = d ? `out with ${fem(l) ? 'her' : 'his'} dog` : kid(l) ? (r < 0.5 ? 'racing nobody in particular' : 'on the way home from school') : lines[Math.floor(hash3(i, 7, ts) * lines.length)];
    cards.push({ label: `${name}, ${line}`, sub: s.name });
    v.push(kid(l) ? 1 + r * 0.35 : l.bounce < 0.25 || d ? 0.82 + r * 0.22 : 1.02 + r * 0.4);
    pref.push(0.6 + hash3(i, 9, ts) * 0.3);
  });
  return { looks, cards, v, pref, dog };
}

/** Looks for the anchored people of a town (by their places' poses): a leaning one is a kid; sitters, loungers and keepers carry nothing. */
export function anchoredLooks(s: Settlement, poses: readonly number[], seed: number): Look[] {
  const ts = hashSeed(seed, `townsfolk-a:${s.id}`), looks = makeLooks(ts, poses.length);
  looks.forEach((l, k) => {
    dress(l, s.style, hash3(k, 3, ts));
    l.flags &= ~(LookFlag.Umbrella | LookFlag.Phone | LookFlag.Leash | (poses[k] === POSE.chat || poses[k] === POSE.idle ? 0 : LookFlag.Backpack | LookFlag.Bag));
    if (poses[k] === POSE.lean) {
      l.flags = (l.flags & ~LookFlag.Dress) | LookFlag.Kid | LookFlag.Shorts;
      l.scale = 0.66;
    }
    if (poses[k] === POSE.lie) l.flags = (l.flags | LookFlag.ShortSleeve | (l.flags & LookFlag.Dress ? 0 : LookFlag.Shorts)) & ~(LookFlag.Backpack | LookFlag.Bag);
  });
  return looks;
}

/** The walkers of a town as the sim takes them: pace, side, dog, size, and a home door each (several share one). */
export function folkFor(net: Net, tf: Townsfolk, seed: number): Folk[] {
  const homes = net.places.map((p, i) => (p.k === PK.door && p.home && p.node >= 0 ? i : -1)).filter((i) => i >= 0);
  return tf.looks.map((l, i) => ({ v: tf.v[i], pref: tf.pref[i], dog: tf.dog[i], scale: l.scale, home: homes.length ? homes[Math.floor(hash3(i, 13, seed) * homes.length)] : -1 }));
}
