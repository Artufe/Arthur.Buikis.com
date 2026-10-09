// The named review shots (BRIEF §9 / TASKS F0) and the scripted orbit → street dive. Shots that
// stand in the city read the plan's viewpoints, so they follow A2's plan automatically.
// Add your own shots here (additive): name → { view, t }.

import { buildDivePath, DIVE_SECONDS, divePoseAt, type DivePath, type DivePose } from '../camera/dive';
import type { Viewpoint } from '../world/city/types';
import { registerShotViews } from '../world/city/views';
import type { LBContext, ViewSpec } from './contracts';
import { K } from './debug-kit';

// Review tooling (the debug chunk): engine modules come through the kit, not imports (core/kit.ts).
const { CITY_LAT, CITY_LON, CITY_SURFACE_R, CURB_H, EYE_HEIGHT, PLATEAU_HEIGHT, ROAD_H, planHeadingToWorld, planToDir, latLonFromDir, eveningTimeAt, timeAtHourAngle, cloudsShotView } = K;

// The plan's rooftops / horizon / dusk viewpoints are solved by views.ts, loaded only with the shots.
registerShotViews();

export interface ShotDef {
  /** What the shot is for (printed by --list). */
  about: string;
  view(ctx: LBContext): ViewSpec;
  /** Sim time (s), or a function of the resolved view. Default 0: late afternoon over the city. */
  t?: number | ((view: ViewSpec) => number);
  /** v2 (D1): then ride this Trackable, settled (the camera director's ride). */
  ride?: string;
  /** v2 (D1): then fly the bird, holding this input for `secs` of flight before the frame. */
  bird?: { steer: number; climb: number; secs: number };
}

const DEG = 180 / Math.PI;
/** v2 (R2): the region's review shots at the place's own early afternoon (sun ~25° past its noon). */
const AFTERNOON = (v: ViewSpec) => timeAtHourAngle(25, v.lon);
/** The far continent's longitude (far haven −155°, clover −144°: the planet's seeded continents). */
const FAR_LON = -150;
/** v2 (R2 refine): the gate shots in the capital's early afternoon (at t = 0 its plazas are in late light). */
const CAPITAL_AFTERNOON = timeAtHourAngle(25, CITY_LON);
/** region-far-west's timing: clover's own longitude (set when its view resolves). */
let cloverLon = FAR_LON;
/** Horizon dip (deg) for the eye on a sidewalk. */
const DUSK_DIP = Math.acos((CITY_SURFACE_R + ROAD_H + CURB_H) / (CITY_SURFACE_R + ROAD_H + CURB_H + EYE_HEIGHT)) * DEG;

/** A ViewSpec standing at a plan viewpoint. */
export function viewAt(vp: Viewpoint, alt: number, pitch?: number): ViewSpec {
  const ll = latLonFromDir(planToDir(vp.x, vp.z));
  const v: ViewSpec = { lat: ll.lat, lon: ll.lon, alt, heading: planHeadingToWorld(vp.x, vp.z, vp.heading) * DEG };
  if (pitch !== undefined) v.pitch = pitch;
  return v;
}

/**
 * Sim time (s) the /play clip starts at: it is rendered with `--dive 301 --t DIVE_T0`, so its last
 * frame (the poster and loop point, at DIVE_T0 + DIVE_SECONDS) is the `landing` shot's light and life.
 * Picked by `scripts/play-media/littlebig-scan.mjs` over T0 ∈ [0, 14] (loop point and final second
 * with no walker or vehicle near the lens, nobody walking at it, people + cars in view), then by eye;
 * recipe in `docs/play-media.md`. The sims are chaotic (±0.25 s changes the frame), so re-scan
 * whenever traffic or people change.
 */
export const DIVE_T0 = 11;

/**
 * The `street` shot stands on A2's viewpoint stepped 0.9 m toward the building side and turned 6°
 * toward it: on the viewpoint itself a lamp pole 8 m ahead split the frame against the clock tower.
 * Kept only if the stepped spot is still clear pavement.
 */
function streetView(ctx: LBContext): ViewSpec {
  const vp = ctx.world.city.viewpoints.street;
  const x = vp.x + Math.cos(vp.heading) * 0.9;
  const z = vp.z + Math.sin(vp.heading) * 0.9;
  const ok = ctx.world.cityIndex.classify(x, z) === 'sidewalk' && !ctx.world.cityIndex.collide(x, z, 0.4, { x: 0, z: 0 });
  return viewAt(ok ? { ...vp, x, z, heading: vp.heading + (6 * Math.PI) / 180 } : vp, EYE_HEIGHT);
}

/** Plan point (x, z) as lat/lon. */
function planLL(x: number, z: number) {
  return latLonFromDir(planToDir(x, z));
}

export const SHOTS: Record<string, ShotDef> = {
  // (v2 R2: re-aimed west of the capital, later in the afternoon, so the farm village and the harbour
  // stand clear of the cloud layer in the lit hemisphere beside the city, the dusk glow on its right;
  // R2 refine 2: 4° further west and 2° south, the western towns nearer the middle of the disc, the
  // capital still face-on: region.spec 'orbit shot')
  orbit: { about: 'whole planet from 380 m: the capital face-on in the afternoon, millbrook and port pebble on the western lands, the dusk glow on the right limb', view: () => ({ lat: CITY_LAT - 18, lon: CITY_LON - 25, alt: 380, heading: 0 }), t: 468 },
  city: { about: 'top-down over the city from 120 m', view: () => ({ lat: CITY_LAT, lon: CITY_LON, alt: 120, heading: 0 }) },
  // (The clouds frame this view with two anchored clusters: clouds/dive-anchors.ts.)
  clouds: { about: 'in the cloud layer (44 m), looking across it at the city (pitch −35°: the layer, not a top-down)', view: cloudsShotView },
  // Pitched up to −24° (the curve's −35° puts everything above the 16 m eye out of frame): from the
  // viewpoint's 58–70 m the plateau's curve drops the whole clock tower into view (A2).
  rooftops: { about: 'rooftop height (16 m), in over downtown at the clock tower', view: (ctx) => viewAt(ctx.world.city.viewpoints.rooftops, 16, -24) },
  street: { about: "FPV on a city sidewalk (A2's viewpoint, stepped off a lamp pole's line)", view: streetView },
  horizon: { about: '6 m up at the plateau edge, looking along the curve', view: (ctx) => viewAt(ctx.world.city.viewpoints.horizon, 6) },
  night: {
    about: 'orbit over the city at local midnight (the constellation)',
    view: () => ({ lat: CITY_LAT - 4, lon: CITY_LON + 6, alt: 380, heading: 0 }),
    t: timeAtHourAngle(180),
  },
  approach: {
    about: 'the dive at ~12 m, gliding in down the street toward the landing (A4)',
    view: (ctx) => diveAt(ctx, 0.7),
    t: DIVE_T0 + 0.7 * DIVE_SECONDS,
  },
  landing: {
    about: "the dive's last frame: its own landing on a sunlit downtown corner (A4; the /play loop point, at the clip's end time)",
    view: (ctx) => diveAt(ctx, 1),
    t: DIVE_T0 + DIVE_SECONDS,
  },
  cloudscape: {
    about: 'across the cloud layer from its top (46 m), toward the clouds-shot anchors: crowns, bellies, rims (A3)',
    view: () => {
      const ll = planLL(-8, 100);
      return { lat: ll.lat, lon: ll.lon, alt: 46, heading: 0, pitch: -12 };
    },
  },
  station: {
    about: 'the sky station from ~30 m behind and above, the planet below (v2 S1)',
    view: (ctx) => spaceView(ctx, 'station:0', 40, 2.6, 150, 40),
    t: 40,
  },
  skywatch: {
    about: 'night at the plateau edge, looking up: the sky station gliding over, still sunlit (v2 S1)',
    view: (ctx) => skyView(ctx, 'station:0', 102.6),
    t: 102.6,
  },
  // ── v2 rides and the bird (D1): the view and time, then the ride / flight, settled ──
  chase: { about: 'v2: riding a car (chase), from the city view: behind and above it down the street', view: () => ({ lat: CITY_LAT, lon: CITY_LON, alt: 120, heading: 0 }), ride: 'car:3' },
  flight: { about: 'v2: riding flight lb 117 (chase) over the capital: the planet curving below', view: () => ({ lat: CITY_LAT, lon: CITY_LON, alt: 120, heading: 0 }), ride: 'plane:1' },
  eyes: { about: "v2: a walker's eyes (first person) on the street shot's sidewalk", view: streetView, ride: 'person:12' },
  alongside: { about: 'v2: riding alongside the sky station: high and beside it, over the planet', view: () => ({ lat: CITY_LAT - 6, lon: CITY_LON + 26, alt: 380, heading: 0 }), ride: 'station:0' },
  bird: { about: 'v2: the bird over downtown, 1.2 s into a gentle right climb from the rooftops shot', view: (ctx) => viewAt(ctx.world.city.viewpoints.rooftops, 16, -24), bird: { steer: 0.3, climb: 0.2, secs: 1.2 } },
  takeoff: { about: 'v2 (D1f): the bird 1.2 s after a launch from the street shot, no input: climbing out down the street', view: streetView, bird: { steer: 0, climb: 0, secs: 1.2 } },
  dusk: {
    about: 'street at sunset, looking west: the sun disc touching the horizon',
    view: (ctx) => viewAt(ctx.world.city.viewpoints.dusk, EYE_HEIGHT),
    // The planet is tiny: local sun elevation changes ~1° per 2.8 m, so time it at the viewpoint,
    // and the visible horizon dips ~8° at eye height: the disc meets it at about −(dip − 1°).
    t: (v) => eveningTimeAt(v.lat, v.lon, -(DUSK_DIP - 1)),
  },
  // ── v2 region (R1, R2): add --p region.debug=1 for the network overlay ──
  // The globe from 380 m round the equator every 45° and over both poles, each in its own early
  // afternoon (V2 R2: no side of the planet is empty: a settlement or a road on every one).
  ...globeShots(),
  // (v2 R2 refine 2: later in the afternoon, port pebble out from under a cloud)
  'region-west': { about: 'v2: over the western lands (the mill road past the windmills to millbrook, the downs road on to port pebble, the coast road back)', view: (ctx) => regionView(ctx, (r) => mixDir(town(r, 'millbrook') ?? r.settlements[0].dir, town(r, 'port-pebble'), 0.45), 240), t: (v: ViewSpec) => timeAtHourAngle(40, v.lon) },
  'region-east': { about: 'v2: over the east (the rim road, the alpine road up the pass to snowberry, the cove road and its bridge to coral cove)', view: (ctx) => regionView(ctx, (r) => mixDir(r.settlements[0].dir, mixDir(town(r, 'snowberry') ?? r.settlements[0].dir, town(r, 'coral-cove'), 0.5), 0.72), 260), t: AFTERNOON },
  'region-south': { about: 'v2: over the south-west (port pebble on its point, its quay and pier, the coast road and the downs road)', view: (ctx) => regionView(ctx, (r) => mixDir(r.settlements[0].dir, town(r, 'port-pebble'), 0.75), 220), t: AFTERNOON },
  'region-far': { about: 'v2: over the far continent (far haven, its airport, the clover highway, the bay road, the ferry in)', view: (ctx) => regionView(ctx, (r) => mixDir(town(r, 'far-haven') ?? r.settlements[0].dir, town(r, 'clover'), 0.35), 300), t: AFTERNOON },
  // (v2 R2 refine: clover well inside the disc, driftwood and the lookout lane toward the limb, timed by clover's own afternoon)
  'region-far-west': {
    about: "v2 R2: over the far continent's west lobe (clover, the west road to driftwood, the lookout lane to its car park)",
    view: (ctx) => {
      const r = ctx.world.region;
      const c = town(r, 'clover');
      if (c) cloverLon = latLonFromDir(c).lon;
      return regionView(ctx, (rr) => mixDir(c ?? rr.settlements[0].dir, town(rr, 'driftwood') ?? rr.lookouts.find((l) => l.name === 'the lookout')?.dir ?? null, 0.4), 220);
    },
    t: () => timeAtHourAngle(25, cloverLon),
  },
  'town-port-pebble': { about: 'v2: port pebble (harbour) from 62 m (over the clouds), straight down', view: (ctx) => regionView(ctx, (r) => town(r, 'port-pebble'), 62, -90), t: AFTERNOON },
  'town-millbrook': { about: 'v2: millbrook (farm village) from 62 m, straight down', view: (ctx) => regionView(ctx, (r) => town(r, 'millbrook'), 62, -90), t: AFTERNOON },
  'town-snowberry': { about: 'v2: snowberry (alpine village) from 62 m, straight down', view: (ctx) => regionView(ctx, (r) => town(r, 'snowberry'), 62, -90), t: AFTERNOON },
  'town-coral-cove': { about: 'v2: coral cove (island resort) from 62 m, straight down', view: (ctx) => regionView(ctx, (r) => town(r, 'coral-cove'), 62, -90), t: AFTERNOON },
  'town-far-haven': { about: 'v2: far haven (city) from 120 m, straight down', view: (ctx) => regionView(ctx, (r) => town(r, 'far-haven'), 120, -90), t: AFTERNOON },
  'town-clover': { about: 'v2 R1: clover (farm village at the end of the far highway) from 62 m, straight down, at its noon (it lies far south: an afternoon sun rakes it)', view: (ctx) => regionView(ctx, (r) => town(r, 'clover'), 62, -90), t: (v: ViewSpec) => timeAtHourAngle(0, v.lon) },
  // (in its late morning: in the afternoon a cloud of the layer sits over it)
  'town-puffin-bay': { about: 'v2 R2: puffin bay (fishing village) from 62 m, straight down', view: (ctx) => regionView(ctx, (r) => town(r, 'puffin-bay'), 62, -90), t: 40 },
  'town-driftwood': { about: 'v2 R2: driftwood (fishing village on the far west lobe, the ferry to coral cove) from 62 m, straight down', view: (ctx) => regionView(ctx, (r) => town(r, 'driftwood'), 62, -90), t: AFTERNOON },
  'quay-port-pebble': { about: "v2 R2: port pebble's waterfront from the sea, 14 m up: the quay at the water, the sea wall, the pier, the town climbing behind", view: (ctx) => quayView(ctx, 'port-pebble'), t: AFTERNOON },
  'quay-far-haven': { about: "v2 R2: far haven's docks from the sea, 24 m up: the harbour front at the water, the pier", view: (ctx) => quayView(ctx, 'far-haven', 22, 24, -30), t: AFTERNOON },
  'quay-puffin-bay': { about: "v2 R2: puffin bay's quay from the sea, 12 m up: the sea wall, the quay street behind it", view: (ctx) => quayView(ctx, 'puffin-bay', 26, 12), t: 40 },
  'quay-driftwood': { about: "v2 R2: driftwood's strand from the sea, 12 m up: the sea wall, the pier, the boatyard corner", view: (ctx) => quayView(ctx, 'driftwood', 26, 12), t: AFTERNOON },
  'ferry-cove': { about: 'v2 R2: the second ferry (driftwood ⇄ coral cove) from 200 m, straight down over its middle', view: (ctx) => regionView(ctx, (r) => ferryMid(r, 1), 200, -90), t: AFTERNOON },
  'beach-coral-cove': { about: "v2 R2: coral cove's beach crescent from over its bay, 16 m up: the promenade's curve, the sand below it", view: (ctx) => quayView(ctx, 'coral-cove', 34, 16), t: AFTERNOON },
  'alpine-street': { about: 'v2 R2: across snowberry from 10 m over its far side, at the peak above it: the terraces, the rock and the snow', view: (ctx) => townPeakView(ctx, 'snowberry'), t: AFTERNOON },
  'gate-0': { about: 'v2: gate plaza 0 from 32 m: the city turnaround meets the roundabout', view: (ctx) => regionView(ctx, (r) => r.gates[0]?.dir ?? null, 32, -90), t: CAPITAL_AFTERNOON },
  'gate-1': { about: 'v2: gate plaza 1 from 32 m', view: (ctx) => regionView(ctx, (r) => r.gates[1]?.dir ?? null, 32, -90), t: CAPITAL_AFTERNOON },
  'gate-2': { about: 'v2: gate plaza 2 from 32 m', view: (ctx) => regionView(ctx, (r) => r.gates[2]?.dir ?? null, 32, -90), t: CAPITAL_AFTERNOON },
  'gate-street': { about: 'v2: a gate plaza at street level, from the capital looking out through it', view: gateStreetView, t: CAPITAL_AFTERNOON },
  'bridge-0': { about: 'v2: the cove bridge from the side (26 m off, 14 m up): the water under the span', view: (ctx) => bridgeView(ctx, 'cove road'), t: 330 },
  'bridge-1': { about: 'v2 R2: the second bridge on the network (the coast road or the downs road), from the side', view: (ctx) => bridgeView(ctx, null, 1), t: 18 },
  'alpine-pass': { about: "v2 R1: the alpine road's hairpin up the pass to snowberry, from 90 m", view: (ctx) => regionView(ctx, (r) => roadMid(r, 'alpine road'), 90, -90), t: AFTERNOON },
  lookout: { about: 'v2 R1: the lookout car park on the far continent and its road, from 60 m, straight down', view: (ctx) => regionView(ctx, (r) => lookoutAt(r, 'the lookout'), 60, -90), t: 150 },
  'lighthouse-point': { about: 'v2 R1: the lighthouse road and its car park on the N headland, from 45 m, straight down', view: (ctx) => regionView(ctx, (r) => lookoutAt(r, 'lighthouse point'), 45, -90) },
  'airport-lbx': { about: "v2: the capital's lagoon airport from 60 m", view: (ctx) => regionView(ctx, (r) => r.airports[0]?.centre ?? null, 60, -90) },
  'airport-fhv': { about: "v2: far haven's airport from 60 m", view: (ctx) => regionView(ctx, (r) => r.airports[1]?.centre ?? null, 60, -90), t: 220 },
  // ── v2 H1 (roads): the network at eye level, from just above, and at night ──
  'road-eye': { about: 'v2 H1: on the mill road at eye level, on its verge, looking down it: tarmac, paint, the shoulder into the grass, the country lamps', view: (ctx) => roadView(ctx, 'mill road', 0.3, 3.9, EYE_HEIGHT, -3), t: AFTERNOON },
  'road-low': { about: 'v2 H1: 7 m over the downs road, looking along it toward its bridge', view: (ctx) => roadView(ctx, 'downs road', 0.25, 0, 7, -16), t: AFTERNOON },
  'road-banks': { about: 'v2 H1: the alpine road from 12 m, looking up the switchbacks: the road on its cut and fill', view: (ctx) => roadView(ctx, 'alpine road', 0.5, 10, 24, -38), t: AFTERNOON },
  'bridge-deck': { about: 'v2 H1: on the cove road at eye level 7 m before its bridge, looking over it: the end pillars and their lamps, walkways, parapets, the coping lamps', view: (ctx) => bridgeDeckView(ctx, 'cove road'), t: 330 },
  'bridge-end': { about: 'v2 H1: the downs road bridge\'s first abutment from beside the road, 5 m up: the end pillars and their lamps, the coping lamps, the retaining wall', view: (ctx) => bridgeEndView(ctx, 'downs road'), t: 18 },
  'bridge-under': { about: 'v2 H1: the downs road bridge from mid-channel, 2 m up, square to it: arches, piers and cutwaters, the abutments', view: (ctx) => bridgeUnderView(ctx, 'downs road'), t: 18 },
  'lookout-low': { about: 'v2 H1: the lookout car park from 16 m off, 8 m up: the kerbed gravel rim, the rail and telescope, the fillets to its lane', view: (ctx) => offView(ctx, (r) => lookoutAt(r, 'the lookout'), 200, 16, 8, -24), t: AFTERNOON },
  'lookout-yard': { about: "v2 H1: puffin bay's lookout yard from 14 m off, 7 m up: the island's mast, the rail on the walk", view: (ctx) => offView(ctx, (r) => yardAt(r, 'puffin-bay', 'lookout'), 160, 14, 7, -24), t: AFTERNOON },
  'market-yard': { about: "v2 H1: far haven's market yard on the quay from 14 m off, 7 m up: the anchor on its island", view: (ctx) => offView(ctx, (r) => yardAt(r, 'far-haven', 'market'), 200, 14, 7, -24), t: AFTERNOON },
  'gate-clock': { about: 'v2 H1: gate plaza 1 at eye level from its ring: the clock pillar', view: (ctx) => offView(ctx, (r) => r.gates[1]?.dir ?? null, 30, 12, 2.2, 6), t: AFTERNOON },
  'gate-topiary': { about: 'v2 H1: gate plaza 2 at eye level from its ring: the tiered topiary', view: (ctx) => offView(ctx, (r) => r.gates[2]?.dir ?? null, 120, 12, 2.2, 6), t: AFTERNOON },
  'bridge-wing': { about: "v2 H1: the downs road bridge's far abutment from the water off its right side, 3 m up: the wing wall down the bank, the end pillar", view: (ctx) => bridgeWingView(ctx, 'downs road', 1), t: 18 },
  'bridge-wing-l': { about: "v2 H1: the same abutment from off the road's left side", view: (ctx) => bridgeWingView(ctx, 'downs road', -1), t: 18 },
  'quay-street': { about: "v2 H1: on port pebble's quay 2.6 m up, along the sea wall: coping, bollards, the apron, the globe lamps", view: (ctx) => quayStreetView(ctx, 'port-pebble'), t: AFTERNOON },
  'runway-eye': { about: "v2 H1: far haven's runway from its threshold, 2.5 m up: the threshold bars, the number, the centreline", view: (ctx) => runwayView(ctx, 1), t: 220 },
  'gate-dusk': { about: 'v2 H1: the gate-street view at dusk, the plaza lamps on', view: gateStreetView, t: (v: ViewSpec) => eveningTimeAt(v.lat, v.lon, -3) },
  'region-night': { about: 'v2 H1: the region-west view at night: the roads strung with lights between the towns', view: (ctx) => regionView(ctx, (r) => mixDir(town(r, 'millbrook') ?? r.settlements[0].dir, town(r, 'port-pebble'), 0.45), 240), t: (v: ViewSpec) => timeAtHourAngle(175, v.lon) },
  'town-night': { about: 'v2 H1: port pebble from 40 m at night: the lamps and their pools', view: (ctx) => regionView(ctx, (r) => town(r, 'port-pebble'), 40, -60), t: (v: ViewSpec) => timeAtHourAngle(170, v.lon) },
  'road-night': { about: 'v2 H1: the road-eye view at night: the country lamps\' lanterns and their pools over the road', view: (ctx) => roadView(ctx, 'mill road', 0.3, 3.9, EYE_HEIGHT, -3), t: (v: ViewSpec) => timeAtHourAngle(170, v.lon) },
  'road-town': { about: 'v2 H1: on the downs road at eye level entering its town: the walks easing in from the kerb line, the country shoulder under them', view: (ctx) => roadView(ctx, 'downs road', 0.75, 0, EYE_HEIGHT, -8), t: AFTERNOON },
  // ── v2 T1 (towns): each town from 55 m across it (the harbours from the sea), low over its roofs, at
  // night, the city's skyline from the water, the chairlift, the airports' buildings ──
  ...townShots(),
  'towns-night': { about: 'v2 T1: the western lands from 380 m at night: each town a glowing cluster, the capital beside them', view: () => ({ lat: CITY_LAT - 18, lon: CITY_LON - 25, alt: 380, heading: 0 }), t: (v: ViewSpec) => timeAtHourAngle(160, v.lon) },
  'towns-dusk': { about: 'v2 T1: port pebble from 55 m at dusk: the windows switching on', view: (ctx) => townObliqueView(ctx, 'port-pebble', 55, 75, null), t: (v: ViewSpec) => eveningTimeAt(v.lat, v.lon, -4) },
  'skyline-far-haven': { about: "v2 T1: far haven's skyline from its harbour, 9 m up: the towers over the docks and their cranes", view: (ctx) => quayView(ctx, 'far-haven', 34, 9, -4), t: AFTERNOON },
  'lift-snowberry': { about: 'v2 T1: the chairlift from the village beside its line, 14 m up: the pylons and the chairs climbing the peak to the summit station', view: (ctx) => liftView(ctx), t: AFTERNOON },
  'airport3d-lbx': { about: "v2 T1: the capital's airport from 45 m across the apron: terminal, tower, hangar, windsock", view: (ctx) => siteView(ctx, ctx.world.region.airports[0]?.apron ?? null, 45, 60, 135), t: AFTERNOON },
  'airport3d-fhv': { about: "v2 T1: far haven's airport from 45 m across the apron", view: (ctx) => siteView(ctx, ctx.world.region.airports[1]?.apron ?? null, 45, 60, 300), t: 220 },
};

/** v2 T1: the town shots, two per town (55 m across it, 12 m low over it). */
function townShots(): Record<string, ShotDef> {
  const out: Record<string, ShotDef> = {};
  for (const id of ['port-pebble', 'millbrook', 'snowberry', 'coral-cove', 'far-haven', 'clover', 'puffin-bay', 'driftwood']) {
    const big = id === 'far-haven';
    out[`town3d-${id}`] = { about: `v2 T1: ${id.replace('-', ' ')} from ${big ? 80 : 55} m, looking across it`, view: (ctx) => townObliqueView(ctx, id, big ? 80 : 55, big ? 120 : 75, null), t: AFTERNOON };
    out[`townlow-${id}`] = { about: `v2 T1: ${id.replace('-', ' ')} from 12 m over its edge, looking across the roofs`, view: (ctx) => townObliqueView(ctx, id, 12, big ? 52 : 30, null, -14), t: AFTERNOON };
    out[`towneye-${id}`] = { about: `v2 T1: ${id.replace('-', ' ')} at eye level on its square, looking into the town`, view: (ctx) => townEyeView(ctx, id), t: AFTERNOON };
  }
  return out;
}
/** v2 T1: at eye level at a town square's rim (on its far side from the pad's middle), looking across it into the town. */
function townEyeView(ctx: LBContext, id: string): ViewSpec {
  const s = ctx.world.region.settlements.find((x) => x.id === id);
  const q = s?.square;
  if (!s || !q) return townObliqueView(ctx, id, 12, 30, null, -14);
  // (the resort's square is its pool, ringed by loungers and umbrellas: from the plaza's edge)
  return siteView(ctx, s.dir, EYE_HEIGHT, Math.hypot(q.x, q.z) + q.r + (s.style === 'resort' ? 4.2 : 1.2), (Math.atan2(q.x, -q.z) * DEG + 360) % 360, -2);
}
/**
 * v2 T1: over a town, `alt` m up, `back` m from its centre on compass `bearing` (deg; null: the harbours
 * from the sea, the others from across their main axis), looking back at it.
 */
function townObliqueView(ctx: LBContext, id: string, alt: number, back: number, bearing: number | null, pitch?: number): ViewSpec {
  const s = ctx.world.region.settlements.find((x) => x.id === id);
  if (!s) return regionView(ctx, () => null, 60);
  const b = bearing ?? (s.cut ? (s.heading * DEG + 360) % 360 : (s.heading * DEG + 120) % 360);
  return siteView(ctx, s.dir, alt, back, b, pitch);
}
function siteView(ctx: LBContext, d: Dir | null, alt: number, back: number, bearing: number, pitch?: number): ViewSpec {
  if (!d) return regionView(ctx, () => null, 60);
  const c = latLonFromDir(d);
  const cos = Math.cos((c.lat * Math.PI) / 180);
  const m = back / (Math.PI / 180) / (CITY_SURFACE_R - 2);
  const b = bearing / DEG;
  return { lat: c.lat + Math.cos(b) * m, lon: c.lon + (Math.sin(b) * m) / cos, alt, heading: (bearing + 180) % 360, pitch: pitch ?? -Math.atan(alt / back) * DEG - 4 };
}
/** v2 T1: snowberry's chairlift from over the village, looking up the line toward the snow (it climbs toward the highest ground round the village). */
function liftView(ctx: LBContext): ViewSpec {
  const s = ctx.world.region.settlements.find((x) => x.style === 'alpine');
  if (!s) return regionView(ctx, () => null, 60);
  // (townPeakView looks at the peak across the village: its heading is the lift's bearing)
  const hb = townPeakView(ctx, s.id).heading! / DEG;
  const c = latLonFromDir(s.dir);
  const cos = Math.cos((c.lat * Math.PI) / 180);
  const deg = 1 / (Math.PI / 180) / (CITY_SURFACE_R - 2);
  // (from the village's edge beside the line, 14 m up: the line climbing the peak to its summit station)
  const cb = hb - 0.84;
  const lat = c.lat + Math.cos(cb) * 24 * deg;
  const lon = c.lon + (Math.sin(cb) * 24 * deg) / cos;
  return { lat, lon, alt: 14, heading: (hb * DEG + 32 + 360) % 360, pitch: -6 };
}

type RegionData = LBContext['world']['region'];
type Dir = { x: number; y: number; z: number };
const town = (r: RegionData, id: string): Dir | null => r.settlements.find((s) => s.id === id)?.dir ?? null;
const lookoutAt = (r: RegionData, name: string): Dir | null => {
  const l = r.lookouts.find((x) => x.name === name);
  return l ? r.nodes[l.node].dir : null;
};
function mixDir(a: Dir, b: Dir | null, t: number): Dir {
  if (!b) return a;
  const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}
/** A view over a region feature (falls back to the capital when the world has none). */
function regionView(ctx: LBContext, pick: (r: RegionData) => Dir | null, alt: number, pitch?: number, heading = 0): ViewSpec {
  const d = pick(ctx.world.region) ?? ctx.world.region.settlements[0].dir;
  const ll = latLonFromDir(d);
  const v: ViewSpec = { lat: ll.lat, lon: ll.lon, alt, heading };
  if (pitch !== undefined) v.pitch = pitch;
  return v;
}
/** The middle of ferry `i`'s lane. */
function ferryMid(r: RegionData, i: number): Dir | null {
  const f = r.ferries[i];
  if (!f) return null;
  const k = Math.floor(f.lane.h.length / 2);
  return { x: f.lane.dir[k * 3], y: f.lane.dir[k * 3 + 1], z: f.lane.dir[k * 3 + 2] };
}
/** The middle of the first region road called `name`. */
function roadMid(r: RegionData, name: string): Dir | null {
  const e = r.edges.find((x) => x.name === name);
  if (!e) return null;
  const p = e.centre;
  let i = 0;
  while (i < p.s.length - 1 && p.s[i] < p.length / 2) i++;
  return { x: p.dir[i * 3], y: p.dir[i * 3 + 1], z: p.dir[i * 3 + 2] };
}
/** The middle of the bridge on road `name`. */
function bridgeMid(r: RegionData, name: string): Dir | null {
  const b = r.bridges.find((x) => r.edges[x.edge].name === name);
  if (!b) return null;
  const p = r.edges[b.edge].centre;
  let i = 0;
  while (i < p.s.length - 1 && p.s[i] < (b.s0 + b.s1) / 2) i++;
  return { x: p.dir[i * 3], y: p.dir[i * 3 + 1], z: p.dir[i * 3 + 2] };
}
/** Over the middle of the bridge on road `name`, 30 m up, looking along it. */
function bridgeView(ctx: LBContext, name: string | null, index = 0): ViewSpec {
  const r = ctx.world.region;
  const b = (name ? r.bridges.find((x) => r.edges[x.edge].name === name) : r.bridges.filter((x) => r.edges[x.edge].name !== 'cove road')[index - 1]) ?? r.bridges[0];
  if (!b) return regionView(ctx, () => null, 60);
  const p = r.edges[b.edge].centre;
  let i = 0;
  while (i < p.s.length - 1 && p.s[i] < (b.s0 + b.s1) / 2) i++;
  const j = Math.min(p.s.length - 1, i + 3);
  const d = { x: p.dir[i * 3], y: p.dir[i * 3 + 1], z: p.dir[i * 3 + 2] };
  const e = { x: p.dir[j * 3], y: p.dir[j * 3 + 1], z: p.dir[j * 3 + 2] };
  const ll = latLonFromDir(d);
  const le = latLonFromDir(e);
  const cos = Math.cos((ll.lat * Math.PI) / 180);
  const fN = le.lat - ll.lat;
  const fE = (le.lon - ll.lon) * cos;
  const heading = Math.atan2(fE, fN) * DEG;
  // R1: from the side, 26 m off its middle and 14 m up, so the water under the span shows
  const k = 26 / Math.max(0.1, p.s[j] - p.s[i]);
  return { lat: ll.lat + fE * k, lon: ll.lon - (fN * k) / cos, alt: 14, heading: heading + 90, pitch: -Math.atan(14 / 26) * DEG };
}
/** The globe shots: 380 m over the equator every 45° of longitude and over both poles, each at its early afternoon. */
function globeShots(): Record<string, ShotDef> {
  const out: Record<string, ShotDef> = {};
  // (v2 R2 refine 2: three re-timed — later in the afternoon, or for 180° its morning 8° east — so the
  // towns each holds face-on stand clear of the cloud layer: region.spec 'clear of cloud')
  const tweak: Record<number, { ha: number; lon?: number }> = { 180: { ha: -20, lon: -172 }, 270: { ha: 38 }, 315: { ha: 40 } };
  for (let k = 0; k < 8; k++) {
    const tw = tweak[k * 45];
    const lon = tw?.lon ?? ((k * 45 + 180) % 360) - 180;
    const ha = tw?.ha ?? 25;
    out[`globe-${k * 45}`] = { about: `v2 R2: the globe from 380 m over the equator at longitude ${lon}°, in its ${ha < 0 ? 'morning' : ha > 30 ? 'afternoon' : 'early afternoon'}`, view: () => ({ lat: 0, lon, alt: 380, heading: 0 }), t: timeAtHourAngle(ha, lon) };
  }
  out['globe-north'] = { about: 'v2 R2: the globe from 380 m over the north pole (the capital at the bottom)', view: () => ({ lat: 89.5, lon: CITY_LON, alt: 380, heading: 180 }), t: timeAtHourAngle(25, CITY_LON) };
  out['globe-south'] = { about: 'v2 R2: the globe from 380 m over the south pole (the far continent below)', view: () => ({ lat: -89.5, lon: FAR_LON, alt: 380, heading: 0 }), t: timeAtHourAngle(25, FAR_LON) };
  return out;
}
/** A waterfront from the sea: `off` m out along the town's axis past its edge, `up` m up, looking back at it. */
function quayView(ctx: LBContext, id: string, off = 30, up = 14, pitch?: number): ViewSpec {
  const r = ctx.world.region;
  const s = r.settlements.find((x) => x.id === id);
  if (!s) return regionView(ctx, () => null, 60);
  const ll = latLonFromDir(s.dir);
  const cos = Math.cos((ll.lat * Math.PI) / 180);
  const m = (s.padR + off) / (Math.PI / 180) / (CITY_SURFACE_R - 2);
  const lat = ll.lat + Math.cos(s.heading) * m;
  const lon = ll.lon + (Math.sin(s.heading) * m) / cos;
  return { lat, lon, alt: up, heading: (s.heading * DEG + 180) % 360, pitch: pitch ?? -Math.atan(up / (s.padR * 0.6 + off)) * DEG };
}
/**
 * v2 (R2): over a town, `up` m high, looking across it at the highest ground within ~70 m (an alpine
 * village's peak, its rock and snow): from `back` m behind its centre on the far side.
 */
function townPeakView(ctx: LBContext, id: string, up = 10, back = 20): ViewSpec {
  const r = ctx.world.region;
  const s = r.settlements.find((x) => x.id === id);
  if (!s) return regionView(ctx, () => null, 60);
  const c = latLonFromDir(s.dir);
  const cos = Math.cos((c.lat * Math.PI) / 180);
  const deg = 1 / (Math.PI / 180) / (CITY_SURFACE_R - 2);
  const at = (b: number, m: number): Dir => {
    const lat = ((c.lat + Math.cos(b) * m * deg) * Math.PI) / 180;
    const lon = ((c.lon + (Math.sin(b) * m * deg) / cos) * Math.PI) / 180;
    return { x: Math.cos(lat) * Math.sin(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.cos(lon) };
  };
  let best = 0;
  let bh = -Infinity;
  for (let k = 0; k < 36; k++) {
    const b = (k / 36) * Math.PI * 2;
    let h = 0;
    for (const m of [s.padR + 18, s.padR + 30, s.padR + 42]) h += ctx.world.planet.heightAt(at(b, m));
    if (h > bh) {
      bh = h;
      best = b;
    }
  }
  const eye = latLonFromDir(at(best + Math.PI, back));
  return { lat: eye.lat, lon: eye.lon, alt: up, heading: best * DEG, pitch: -6 };
}
// ── v2 H1 (roads) shot helpers ──
/** Sample i of a road's centreline as a unit direction, and the compass heading (deg) along it toward sample j. */
function roadAt(p: { dir: Float64Array }, i: number, j: number) {
  const d = { x: p.dir[i * 3], y: p.dir[i * 3 + 1], z: p.dir[i * 3 + 2] };
  const e = { x: p.dir[j * 3], y: p.dir[j * 3 + 1], z: p.dir[j * 3 + 2] };
  const ll = latLonFromDir(d);
  const le = latLonFromDir(e);
  const cos = Math.cos((ll.lat * Math.PI) / 180);
  return { d, ll, heading: Math.atan2((le.lon - ll.lon) * cos, le.lat - ll.lat) * DEG, cos };
}
/** Shift a lat/lon `m` metres toward compass heading `hd` (deg). */
function shift(ll: { lat: number; lon: number }, cos: number, hd: number, m: number) {
  const k = (m / (CITY_SURFACE_R - PLATEAU_HEIGHT)) * DEG;
  return { lat: ll.lat + Math.cos(hd / DEG) * k, lon: ll.lon + (Math.sin(hd / DEG) * k) / cos };
}
/** On road `name` at fraction f of its length, `side` m to the right of its centreline, `alt` m up, looking along it. */
function roadView(ctx: LBContext, name: string, f: number, side: number, alt: number, pitch: number): ViewSpec {
  const r = ctx.world.region;
  const e = r.edges.find((x) => x.name === name) ?? r.edges.find((x) => x.settlement < 0) ?? r.edges[0];
  const n = e.centre.h.length;
  const i = Math.min(n - 4, Math.floor(f * (n - 1)));
  const a = roadAt(e.centre, i, i + 3);
  const at = shift(a.ll, a.cos, a.heading + 90, side);
  return { lat: at.lat, lon: at.lon, alt, heading: a.heading, pitch };
}
/** At eye level on bridge `name`'s road 7 m before its span, by the kerb, looking over it. */
function bridgeDeckView(ctx: LBContext, name: string): ViewSpec {
  const r = ctx.world.region;
  const b = r.bridges.find((x) => r.edges[x.edge].name === name) ?? r.bridges[0];
  if (!b) return regionView(ctx, () => null, 60);
  const e = r.edges[b.edge];
  const p = e.centre;
  let i = 0;
  while (i < p.s.length - 4 && p.s[i] < b.s0 - 7) i++;
  const a = roadAt(p, i, i + 3);
  const at = shift(a.ll, a.cos, a.heading + 90, e.width / 2 - 1.2);
  return { lat: at.lat, lon: at.lon, alt: p.h[i] + EYE_HEIGHT, heading: a.heading - 3, pitch: -2 };
}
/** Beside bridge `name`'s first abutment, 7 m to the side and 5 m up, looking at it across the approach. */
function bridgeEndView(ctx: LBContext, name: string): ViewSpec {
  const r = ctx.world.region;
  const b = r.bridges.find((x) => r.edges[x.edge].name === name) ?? r.bridges[0];
  if (!b) return regionView(ctx, () => null, 60);
  const p = r.edges[b.edge].centre;
  let i = 0;
  while (i < p.s.length - 4 && p.s[i] < b.s0 - 6) i++;
  const a = roadAt(p, i, i + 3);
  const at = shift(a.ll, a.cos, a.heading - 90, 9);
  return { lat: at.lat, lon: at.lon, alt: 5, heading: a.heading + 50, pitch: -14 };
}
/** `m` m from the picked point toward compass `hd` (deg), `alt` m up, looking back at it. */
function offView(ctx: LBContext, pick: (r: RegionData) => Dir | null, hd: number, m: number, alt: number, pitch: number): ViewSpec {
  const ll = latLonFromDir(pick(ctx.world.region) ?? ctx.world.region.settlements[0].dir);
  const at = shift(ll, Math.cos((ll.lat * Math.PI) / 180), hd, m);
  return { lat: at.lat, lon: at.lon, alt, heading: hd + 180, pitch };
}
/** Town `id`'s first yard of `kind` (its end node). */
function yardAt(r: RegionData, id: string, kind: string): Dir | null {
  const y = r.settlements.find((s) => s.id === id)?.yards?.find((x) => x.kind === kind);
  return y ? r.nodes[y.node].dir : null;
}
/** Beside bridge `name`'s far abutment over the water, `side` (+1 right of the road) 13 m off it, 3 m up, looking back at it. */
function bridgeWingView(ctx: LBContext, name: string, side: number): ViewSpec {
  const r = ctx.world.region;
  const b = r.bridges.find((x) => r.edges[x.edge].name === name) ?? r.bridges[0];
  if (!b) return regionView(ctx, () => null, 60);
  const p = r.edges[b.edge].centre;
  let i = 0;
  while (i < p.s.length - 4 && p.s[i] < b.s1 - 5) i++;
  const a = roadAt(p, i, i + 3);
  const at = shift(a.ll, a.cos, a.heading + 90 * side, 13);
  return { lat: at.lat, lon: at.lon, alt: 3, heading: a.heading - 90 * side + 40 * side, pitch: -6 };
}
/** From the water beside bridge `name`, 3 m up, 20 m off its first pier, looking at it. */
function bridgeUnderView(ctx: LBContext, name: string): ViewSpec {
  const r = ctx.world.region;
  const b = r.bridges.find((x) => r.edges[x.edge].name === name) ?? r.bridges[0];
  if (!b) return regionView(ctx, () => null, 60);
  const p = r.edges[b.edge].centre;
  let i = 0;
  while (i < p.s.length - 4 && p.s[i] < (b.s0 + b.s1) / 2) i++;
  const a = roadAt(p, i, i + 3);
  const at = shift(a.ll, a.cos, a.heading + 90, 24);
  return { lat: at.lat, lon: at.lon, alt: 2, heading: a.heading - 90, pitch: 3 };
}
/** On a walled town's quay apron at eye level, looking along its sea wall. */
function quayStreetView(ctx: LBContext, id: string): ViewSpec {
  const s = ctx.world.region.settlements.find((x) => x.id === id);
  const w = s?.wall;
  if (!s || !w) return regionView(ctx, () => null, 60);
  const n = w.line.length / 2;
  const i = Math.floor(n * 0.15);
  const a = roadAt({ dir: Float64Array.from(w.dir) }, i, i + 2);
  const at = shift(a.ll, a.cos, a.heading + 90, 0);
  // (a plan vector's compass heading is atan2(x, −z): +x east, +z south; −n points inland)
  const back = shift(at, a.cos, Math.atan2(-w.nx, w.nz) * DEG, 2.2);
  return { lat: back.lat, lon: back.lon, alt: w.top[i] + 2.6, heading: a.heading, pitch: -9 };
}
/** Over airport k's landing threshold, 2.5 m up, looking down the runway. */
function runwayView(ctx: LBContext, k: number): ViewSpec {
  const a = ctx.world.region.airports[k] ?? ctx.world.region.airports[0];
  if (!a) return regionView(ctx, () => null, 60);
  const e0 = a.ends[a.landEnd], e1 = a.ends[1 - a.landEnd];
  const ll = latLonFromDir(e0);
  const le = latLonFromDir(e1);
  const cos = Math.cos((ll.lat * Math.PI) / 180);
  const heading = Math.atan2((le.lon - ll.lon) * cos, le.lat - ll.lat) * DEG;
  const at = shift(ll, cos, heading + 180, 6);
  return { lat: at.lat, lon: at.lon, alt: 2.5, heading, pitch: -6 };
}
/** At eye level on the capital's gate avenue just inside its turnaround, looking out through the plaza. */
function gateStreetView(ctx: LBContext): ViewSpec {
  const g = ctx.world.region.gates[0];
  if (!g) return regionView(ctx, () => null, 60);
  const back = 9;
  const r = Math.hypot(g.cityX, g.cityZ) || 1;
  const x = g.cityX - (g.cityX / r) * back;
  const z = g.cityZ - (g.cityZ / r) * back;
  const ll = latLonFromDir(planToDir(x, z));
  const heading = planHeadingToWorld(x, z, Math.atan2(g.cityX / r, -g.cityZ / r)) * DEG;
  return { lat: ll.lat, lon: ll.lon, alt: 6, heading, pitch: -12 };
}

const divePaths = new WeakMap<object, DivePath>();
const _pose: DivePose = { x: 0, z: 0, alt: 0, heading: 0, pitch: 0, togo: 0 };

/** The dive's ground track for this world's plan (built once per plan). */
export function divePath(ctx: LBContext): DivePath {
  let p = divePaths.get(ctx.world.city);
  if (!p) {
    p = buildDivePath(ctx.world.city, ctx.world.cityIndex);
    divePaths.set(ctx.world.city, p);
  }
  return p;
}

/**
 * The scripted descent at u ∈ [0, 1] (camera/dive.ts): from orbit down through the cloud layer,
 * gliding in along a street to land at eye height on the dive's own landing (camera/landing.ts:
 * the best sunlit pavement spot with a long view down the street), facing down it.
 * Render it at DIVE_SECONDS × fps + 1 frames with glide = 1 / fps, the sim starting at DIVE_T0.
 */
export function diveAt(ctx: LBContext, u: number): ViewSpec {
  const p = divePoseAt(divePath(ctx), u, _pose);
  const ll = latLonFromDir(planToDir(p.x, p.z));
  return { lat: ll.lat, lon: ll.lon, alt: p.alt, heading: planHeadingToWorld(p.x, p.z, p.heading) * DEG, pitch: p.pitch * DEG };
}

export { DIVE_SECONDS };

// ── v2 (S1): the space layer's shots ──
// Poses come through the track service (no space/ import: the debug chunk takes engine modules only
// through the kit), evaluated at the shot's time with a shallow copy of ctx.
type V3 = { x: number; y: number; z: number };

/** The trackable's pose at sim time t, or null. */
function poseAt(ctx: LBContext, id: string, t: number) {
  const tr = ctx.services.track.get(id);
  const V = ctx.camera.position.constructor as new () => typeof ctx.camera.position;
  const out = { pos: new V(), fwd: new V(), up: new V(), speed: 0 };
  if (!tr || !tr.pose({ ...ctx, time: { ...ctx.time, render: t } }, out)) return null;
  return { ...out, radius: tr.radius };
}

/** Heading / pitch (deg) and lat / lon of a camera at world `c` looking at `t`. */
function aim(c: V3, t: V3) {
  const r = Math.hypot(c.x, c.y, c.z);
  const ux = c.x / r;
  const uy = c.y / r;
  const uz = c.z / r;
  const dl = Math.hypot(t.x - c.x, t.y - c.y, t.z - c.z) || 1;
  const dx = (t.x - c.x) / dl;
  const dy = (t.y - c.y) / dl;
  const dz = (t.z - c.z) / dl;
  const lat = Math.asin(uy);
  const lon = Math.atan2(ux, uz);
  const ex = Math.cos(lon);
  const ez = -Math.sin(lon);
  const nx = -Math.sin(lat) * Math.sin(lon);
  const ny = Math.cos(lat);
  const nz = -Math.sin(lat) * Math.cos(lon);
  return { lat: lat * DEG, lon: lon * DEG, heading: Math.atan2(dx * ex + dz * ez, dx * nx + dy * ny + dz * nz) * DEG, pitch: Math.asin(dx * ux + dy * uy + dz * uz) * DEG, r, up: { x: ux, y: uy, z: uz } };
}

/** A trackable at sim time t, seen from k bounding radii away (az from its flight, el above its horizontal). */
function spaceView(ctx: LBContext, id: string, t: number, k: number, azDeg: number, elDeg: number): ViewSpec {
  const p = poseAt(ctx, id, t);
  if (!p) return { lat: CITY_LAT, lon: CITY_LON, alt: 380 };
  const right = p.fwd.clone().cross(p.up);
  const a = azDeg / DEG;
  const e = elDeg / DEG;
  const c = p.pos
    .clone()
    .addScaledVector(p.fwd, Math.cos(e) * Math.cos(a) * k * p.radius)
    .addScaledVector(right, Math.cos(e) * Math.sin(a) * k * p.radius)
    .addScaledVector(p.up, Math.sin(e) * k * p.radius);
  const v = aim(c, p.pos);
  return { lat: v.lat, lon: v.lon, alt: v.r - (CITY_SURFACE_R - PLATEAU_HEIGHT) - ctx.world.planet.surfaceAt(v.up), heading: v.heading, pitch: v.pitch };
}

/** From the plateau-edge viewpoint at 6 m, looking up at a trackable at sim time t (skyline kept in). */
function skyView(ctx: LBContext, id: string, t: number): ViewSpec {
  const vp = ctx.world.city.viewpoints.horizon;
  const dir = planToDir(vp.x, vp.z);
  const p = poseAt(ctx, id, t);
  const rc = CITY_SURFACE_R + 6;
  const v = aim({ x: dir.x * rc, y: dir.y * rc, z: dir.z * rc }, p ? p.pos : { x: 0, y: 0, z: 0 });
  return { lat: v.lat, lon: v.lon, alt: 6, heading: v.heading, pitch: Math.min(70, v.pitch - 12) };
}
