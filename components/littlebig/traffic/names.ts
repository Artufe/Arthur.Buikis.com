// L1 (v2): names for the follow card, in the site's lowercase voice. Pure (no three.js), seeded,
// cached per plan. Road names are shared with people (a walker waits to cross "maple avenue").
//
// The capital's sketch (world/city/layout.ts) is a plaza loop ('street'), avenues swirling out of
// its corners ('avenue'), an oval ring road ('ring') and cul-de-sacs off it ('lane'). An avenue may
// be split into several edges at junctions: edges of one kind whose departure angles round the
// centre are close share a name, so a car driving straight on never "turns onto" a new street.

import type { CityPlan, Feature } from '../world/city/types';
import { hash3 } from '../world/rng';

const AVENUES = ['maple avenue', 'harbour avenue', 'lilac avenue', 'clockwork avenue', 'kite avenue', 'tram avenue', 'juniper avenue', 'lantern avenue'];
const CLOSES = ['acorn close', 'pebble close', 'button close', 'teapot close', 'moss close', 'fern close', 'biscuit close', 'snail close', 'thimble close', 'cricket close'];
const RURAL = ['the old country road', 'windmill lane', 'the coast road', 'blackberry lane'];

const cache = new WeakMap<CityPlan, string[]>();

/** A name per road edge: 'the ring road', 'the plaza loop', 'maple avenue', 'acorn close'. */
export function roadNames(plan: CityPlan): string[] {
  let names = cache.get(plan);
  if (names) return names;
  const edges = plan.edges;
  // plan angle of each edge's midpoint round the centre
  const ang = edges.map((e) => {
    const p = e.centre.pts;
    const k = (p.length >> 2) << 1;
    return Math.atan2(p[k + 1], p[k]);
  });
  names = edges.map(() => '');
  const group = (kind: string, list: string[], gap: number) => {
    const ids = edges.filter((e) => e.kind === kind).map((e) => e.id);
    ids.sort((a, b) => ang[a] - ang[b]);
    let g = -1;
    let last = -1e9;
    for (const id of ids) {
      if (ang[id] - last > gap) g++;
      last = ang[id];
      names![id] = list[g % list.length];
    }
    // the last group wraps round to the first when they are close across ±π
    if (g > 0 && ang[ids[0]] + Math.PI * 2 - ang[ids[ids.length - 1]] < gap) {
      const first = names![ids[0]];
      const last = names![ids[ids.length - 1]];
      for (const id of ids) if (names![id] === last) names![id] = first;
    }
  };
  group('avenue', AVENUES, 0.32);
  group('lane', CLOSES, 0.05);
  group('rural', RURAL, 0.6);
  for (const e of edges) {
    if (e.kind === 'ring') names[e.id] = 'the ring road';
    else if (e.kind === 'street') names[e.id] = 'the plaza loop';
    else if (!names[e.id]) names[e.id] = 'a side street';
  }
  cache.set(plan, names);
  return names;
}

// ── Places: what a bus stop or a walker's destination is called ──

const placeCache = new WeakMap<CityPlan, { stops: Feature[]; stopNames: string[] }>();
const markCache = new WeakMap<CityPlan, Landmark[]>();

export interface Landmark {
  x: number;
  z: number;
  /** How far (m) a place still counts as "at" it. */
  r: number;
  name: string;
}

/** The capital's named places: the clock tower, church square, the stadium, the plaza, park gate. */
export function landmarks(plan: CityPlan): Landmark[] {
  let marks = markCache.get(plan);
  if (marks) return marks;
  marks = [];
  for (const b of plan.buildings) {
    if (b.landmark === 'clocktower') marks.push({ x: b.x, z: b.z, r: 34, name: 'clock tower' });
    else if (b.landmark === 'church') marks.push({ x: b.x, z: b.z, r: 28, name: 'church square' });
    else if (b.landmark === 'stadium') marks.push({ x: b.x, z: b.z, r: 34, name: 'the stadium' });
  }
  for (const a of plan.areas) {
    if (a.kind !== 'park' && a.kind !== 'plaza') continue;
    let x = 0;
    let z = 0;
    const n = a.outline.length >> 1;
    for (let k = 0; k < n; k++) {
      x += a.outline[k * 2];
      z += a.outline[k * 2 + 1];
    }
    marks.push({ x: x / n, z: z / n, r: a.kind === 'park' ? 30 : 26, name: a.kind === 'park' ? 'park gate' : 'the plaza' });
  }
  markCache.set(plan, marks);
  return marks;
}

/** The plan's bus stops and a name for each (the landmark, square or road it serves). */
export function busStops(plan: CityPlan): { stops: Feature[]; stopNames: string[] } {
  let c = placeCache.get(plan);
  if (c) return c;
  const stops = plan.features.filter((f) => f.kind === 'bus-stop');
  const roads = roadNames(plan);
  const marks = landmarks(plan);
  const used = new Set<string>();
  const stopNames = stops.map((s) => {
    let best = '';
    let bd = Infinity;
    for (const m of marks) {
      const d = Math.hypot(m.x - s.x, m.z - s.z) / m.r;
      if (d < 1 && d < bd && !used.has(m.name)) {
        bd = d;
        best = m.name;
      }
    }
    if (!best) {
      // the road it stands on, or a made-up corner shop
      let e = -1;
      let ed = Infinity;
      for (const r of plan.edges) {
        const p = r.centre.pts;
        for (let k = 0; k < p.length; k += 4) {
          const d = (p[k] - s.x) ** 2 + (p[k + 1] - s.z) ** 2;
          if (d < ed) {
            ed = d;
            e = r.id;
          }
        }
      }
      best = e >= 0 && !used.has(roads[e]) ? roads[e].replace(/^the /, '') : SHOPS[Math.floor(hash3(Math.round(s.x * 10), Math.round(s.z * 10), 77) * SHOPS.length)];
    }
    used.add(best);
    return best;
  });
  c = { stops, stopNames };
  placeCache.set(plan, c);
  return c;
}

const SHOPS = ['the bakery', 'the bike shop', 'the library', 'the noodle bar', 'the post office', 'the flower stall'];

/** Lowercase compass word for a heading (rad, 0 = north, clockwise). */
export function compass(heading: number): string {
  const k = Math.round((((heading / (Math.PI * 2)) % 1) + 1) % 1 * 8) % 8;
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][k];
}

/** 'n km/h' (rounded). */
export const kmh = (ms: number) => `${Math.round(ms * 3.6)} km/h`;

// ── People's names (drivers, walkers) ──

// Pools long enough that nobody shares a name: walkers count up from a seeded start in each pool
// (people/track.ts walkerNames), drivers count down from just before it (nameAt), so the two
// never meet while both fit (≈ 100 walkers and 18 drivers per grown-up pool at most).
export const FEM = [
  'maya', 'ines', 'ruth', 'nora', 'lena', 'ada', 'ivy', 'june', 'zoe', 'mina', 'olga', 'rosa',
  'tess', 'cleo', 'wren', 'hana', 'aiko', 'lucia', 'priya', 'fatou', 'greta', 'iris', 'mei',
  'sofia', 'yara', 'elif', 'bea', 'dot', 'agnes', 'pearl', 'amara', 'anouk', 'astrid', 'beth',
  'bianca', 'carmen', 'celia', 'dana', 'delia', 'edie', 'elena', 'elsa', 'emma', 'esme', 'eva',
  'fern', 'flora', 'frida', 'gemma', 'gwen', 'hazel', 'heidi', 'ida', 'ilse', 'imani', 'irene',
  'jade', 'jana', 'joy', 'kaia', 'kat', 'kira', 'lara', 'layla', 'lea', 'lidia', 'lila', 'lisa',
  'liv', 'lola', 'lorna', 'mabel', 'mara', 'margo', 'marta', 'mila', 'mira', 'molly', 'nadia',
  'nina', 'noor', 'odile', 'opal', 'paula', 'petra', 'pia', 'polly', 'rania', 'rita', 'ronja',
  'rue', 'sadie', 'sara', 'selma', 'sia', 'signe', 'sunita', 'tamsin', 'tara', 'thea', 'una',
  'uma', 'vera', 'viola', 'wanda', 'willa', 'xenia', 'yoko', 'yasmin', 'zadie', 'zara', 'zelda',
  'alma', 'anya', 'bette', 'carla', 'dora', 'effie', 'elke', 'enid', 'fleur', 'gita', 'hilde',
  'inga', 'keiko', 'lotte', 'magda', 'noa', 'oona', 'rhea', 'saskia', 'tove', 'ulla', 'vida',
  'wilma', 'ayesha', 'chiara', 'dagny', 'kalinda', 'leilani', 'malia', 'nkechi', 'oksana', 'rumi',
  'suki',
];

export const MASC = [
  'theo', 'omar', 'ike', 'hugo', 'sami', 'felix', 'otto', 'raj', 'ken', 'leo', 'milo', 'arlo',
  'bruno', 'cyril', 'diego', 'emil', 'gus', 'hal', 'ivan', 'jonas', 'kofi', 'lars', 'marco',
  'nils', 'oskar', 'pablo', 'abe', 'wim', 'tomas', 'yusuf', 'aaron', 'adil', 'alf', 'amos',
  'anton', 'arne', 'axel', 'basil', 'ben', 'bjorn', 'boris', 'carl', 'cas', 'chen', 'dario', 'dev',
  'dmitri', 'eddie', 'eli', 'enzo', 'ezra', 'fred', 'gael', 'gil', 'gino', 'goran', 'hamid',
  'hans', 'harry', 'henk', 'idris', 'igor', 'isaac', 'jack', 'jan', 'jasper', 'joel', 'jules',
  'kai', 'karim', 'kasper', 'kenji', 'lou', 'luca', 'lukas', 'malik', 'matteo', 'max', 'mick',
  'moss', 'nate', 'ned', 'noel', 'olaf', 'oren', 'otis', 'owen', 'paolo', 'pete', 'quentin',
  'rafa', 'ray', 'remy', 'rico', 'rolf', 'rudy', 'sanjay', 'saul', 'sven', 'taro', 'ted', 'tiago',
  'tobi', 'ugo', 'umar', 'vic', 'vince', 'walt', 'wes', 'xavi', 'yann', 'yuri', 'zack', 'zeke',
  'ali', 'bram', 'cosmo', 'dante', 'elias', 'farid', 'hiro', 'jorge', 'lionel', 'mateo', 'niko',
  'obi', 'pedro', 'reza', 'seth', 'tariq', 'ulf', 'vito', 'aldo', 'bilal', 'dax', 'ernst', 'beau',
  'cal', 'clem', 'dag', 'duncan', 'fynn', 'hector', 'jabari', 'jude', 'kwame', 'lenny', 'magnus',
  'mungo', 'nando', 'osei', 'percy', 'sacha', 'stellan', 'tadeo', 'ulrich',
  'viggo', 'wolfgang', 'yoshi',
];

export const KIDS = [
  'pip', 'bo', 'kit', 'lulu', 'tam', 'rex', 'mo', 'ziggy', 'nell', 'finn', 'tilly', 'ozzy',
  'alfie', 'bibi', 'coco', 'dex', 'elsie', 'fifi', 'gigi', 'hattie', 'izzy', 'jojo', 'kiki',
  'lottie', 'milly', 'nemo', 'ollie', 'pepe', 'poppy', 'queenie', 'roo', 'skye', 'sunny', 'teddy',
  'vivi', 'wally', 'yaya', 'zuzu', 'benji', 'dodo', 'evie', 'fizz', 'harper', 'iggy', 'juno',
  'kip', 'lexi', 'minnie', 'bertie',
];

/**
 * The k-th name of a pool: walkers count up from a seeded start (k = 0, 1, …), drivers count down
 * from just before it, so walkers and drivers never share a name while both fit in the pool.
 */
export function nameAt(pool: readonly string[], seed: number, k: number, driver = false): string {
  const L = pool.length;
  const o = Math.floor(hash3(seed, 31, L) * L);
  return pool[(((driver ? o - 1 - k : o + k) % L) + L) % L];
}

/** A seeded pick from a list. */
export const pickOf = <T>(list: readonly T[], a: number, b: number, c = 0): T => list[Math.floor(hash3(a, b, c) * list.length) % list.length];
