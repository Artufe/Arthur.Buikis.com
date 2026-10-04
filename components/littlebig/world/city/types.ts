// LITTLEBIG city contract. Pure data types, no three.js.
//
// Consumers: A2 (produces the plan, renders it), B1 (cars on lanes + connectors), B2 (people on the
// walk graph), A1 (trees/rocks only where the index says the ground is free), A4 (camera/FPV
// collision through CityIndex), shots (viewpoints). Additive changes only; note them in
// docs/littlebig/DECISIONS.md.
//
// ── Space ──
// The city is planned in a 2D chart around the city centre (world/city/frame.ts): plan point
// (x, z) in metres, +x = east, +z = south at the centre, mapped onto the plateau by the
// exponential map (toSphere / fromSphere). Heights are metres above the plateau surface
// (PLATEAU_HEIGHT above sea level): the bare plateau is h = 0, a carriageway's top ROAD_H, a
// sidewalk's top ROAD_H + CURB_H, park/plaza/garden ground AREA_H (world/config.ts), and a 20 m
// tower's roof h = 20. CityIndex.groundH(x, z) gives the walking/driving surface at any point.
// The plateau is flat: every plan point inside CITY_PLAN_RADIUS is on it.
//
// ── Chart distortion ──
// The exponential map is exact along rays from the centre, but circumferential distances shrink by
// sin θ/θ (−5 % at the plateau edge). Validation and collision work in plan space. A RENDERER that
// places a footprinted thing (building, lot, bench) as one rigid instance must build its matrix from
// frame.ts planBasis() (unnormalised Jacobian columns), not planFrame()'s unit tangents, or the
// rendered box is up to 5 % wider than its plan footprint and neighbours overlap on screen.
//
// ── Read-only ──
// One plan is shared by every engine instance; treat every array as immutable (deep-frozen in dev).
//
// ── Handedness ──
// Seen from above (from outside the planet), the right-hand side of a 2D direction (dx, dz) is
// (−dz, dx) (world/sphere.ts rightOf). Traffic drives on the RIGHT.
// "Plan angle" = atan2(dz, dx). Because +z is south, increasing plan angle turns CLOCKWISE seen
// from above (east → south). "Positive winding" of a polygon = Σ (x_i·z_{i+1} − x_{i+1}·z_i) > 0,
// which is also clockwise seen from above; every outline in the plan uses positive winding.
//
// ── Polylines ──
// Every path (road centreline, lane, turn connector, sidewalk) is a Polyline: points sampled at
// most 1 m apart, with cumulative arc length, so movers can advance by distance (path.ts).

/** A sampled 2D curve in plan space. Build with path.ts (polyline(), fromPoints(), arc()). */
export interface Polyline {
  /** x, z interleaved: [x0, z0, x1, z1, ...]. Consecutive samples ≤ 1 m apart. */
  pts: Float64Array;
  /** Cumulative arc length at each sample (s[0] = 0, s[last] = length). */
  s: Float64Array;
  /** Total length (m). */
  length: number;
  /** True if the last sample equals the first (a loop). */
  closed: boolean;
}

// ── Roads ──

/**
 * Two turn connectors at the same node whose paths come closer than this (m) are listed as
 * conflicts even if they never cross: a 2.4 m bus on each needs 2.4 m plus margin.
 */
export const VEHICLE_CLEARANCE = 2.9;
/** Distance (m) from an arm's patch edge to the centre line of its zebra crossing. */
export const CROSSING_SETBACK = 2.0;

export type RoadKind = 'ring' | 'avenue' | 'street' | 'lane' | 'rural';

/**
 * A road graph node: an intersection, a dead end or a junction where the road kind changes.
 * Edge centrelines stop at `radius` from the node centre; the disc (with rounded corners, see
 * Intersection) is the intersection patch, crossed by Connectors.
 */
export interface RoadNode {
  id: number;
  x: number;
  z: number;
  /** Incident edge ids sorted by increasing plan angle of their departure direction (clockwise seen
   *  from above). Consecutive arms i, i+1 (cyclic) share a street corner on arm i's right. */
  edges: number[];
  /** Distance (m) from the node centre at which incident edge centrelines begin. */
  radius: number;
  /** 'junction' (≥3 edges), 'bend' (2), 'end' (1, cars U-turn on a connector). */
  kind: 'junction' | 'bend' | 'end';
  /** Traffic control hint for B1: who yields. 'yield' = give way to the major road. */
  control: 'none' | 'yield' | 'stop' | 'roundabout';
}

/**
 * A road segment between two nodes. `centre` runs from node `a` to node `b` (trimmed to the node
 * patches). Lanes in the a→b direction lie to the right of the centreline (right-hand traffic).
 */
export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  kind: RoadKind;
  centre: Polyline;
  /** Carriageway width curb to curb (m). 6.5 for a two-lane street. */
  width: number;
  /** Sidewalk width on each side (m), 0 for none. Curb top is +0.15 m. */
  sidewalk: number;
  /** Lane ids in the a→b direction, from the centre line outward (index 0 = next to the centre). */
  lanesAB: number[];
  /** Lane ids in the b→a direction, from the centre line outward. */
  lanesBA: number[];
  /** Speed limit (m/s). */
  speed: number;
}

/** One lane of one edge, in its travel direction. */
export interface Lane {
  id: number;
  edge: number;
  /** +1 if it runs a→b along the edge centreline, −1 if b→a. */
  dir: 1 | -1;
  /** Node it leaves from / arrives at. */
  from: number;
  to: number;
  /** Signed lateral offset of the lane centre from the edge centreline, measured to the right of
   *  the a→b direction (m). Positive for a→b lanes, negative for b→a lanes. */
  offset: number;
  /**
   * Stop line: arc length along `path` that a waiting vehicle's FRONT must not pass (m). Before the
   * zebra crossing at the `to` end if there is one (≥ 1 m clear of its strip), otherwise the lane
   * end (= path.length, the patch edge).
   */
  stopS: number;
  /** Walk-edge id of the crossing over this lane near its `to` end / `from` end, or -1. */
  crossingAtEnd: number;
  crossingAtStart: number;
  /** Lane centre in travel direction. Starts at the `from` patch edge, ends at the `to` patch edge. */
  path: Polyline;
  /** Connector ids leaving from the end of this lane (at node `to`). Never empty. */
  next: number[];
  /** Connector ids arriving at the start of this lane (at node `from`). Never empty. */
  prev: number[];
}

export type Turn = 'straight' | 'left' | 'right' | 'uturn';

/**
 * A turn curve through an intersection patch, joining the end of `fromLane` to the start of
 * `toLane`. path's first sample equals fromLane.path's last; its last equals toLane.path's first
 * (lanes are continuous through intersections — validate.ts checks it).
 */
export interface Connector {
  id: number;
  node: number;
  fromLane: number;
  toLane: number;
  turn: Turn;
  path: Polyline;
  /** Connector ids at the same node whose paths cross or merge with this one (for yielding). */
  conflicts: number[];
  /** Priority for yielding: higher goes first (major-road straight > minor > turns). */
  priority: number;
}

/** The paved patch of an intersection: a closed outline with rounded corners. */
export interface Intersection {
  node: number;
  /** Closed polygon outline (x, z interleaved, positive winding, last ≠ first), corners rounded. */
  outline: Float64Array;
}

// ── People ──

export type WalkKind = 'sidewalk' | 'corner' | 'crossing' | 'footpath' | 'plaza' | 'park';

/** A node of the pedestrian graph (sidewalk corners, path forks, plaza points). */
export interface WalkNode {
  id: number;
  x: number;
  z: number;
  edges: number[];
}

/**
 * A pedestrian path between two walk nodes. 'crossing' edges cross car lanes (zebra crossings at
 * intersections or mid-block); `road` and `lanes` say which, so B2 can wait for gaps. A crossing's
 * `width` is the zebra strip's extent ALONG the road (its half-width is width / 2), and its strip
 * never overlaps an intersection patch or a turn connector. The runtime handshake with traffic is
 * ctx.services.crossings (core/contracts.ts CrossingState).
 */
export interface WalkEdge {
  id: number;
  a: number;
  b: number;
  kind: WalkKind;
  path: Polyline;
  /** Walkable width (m). People may spread laterally within it. */
  width: number;
  /** For crossings: the road edge crossed and the lane ids it crosses. */
  road?: number;
  lanes?: number[];
  /** For crossings: arc length along each `lanes[i]` path where the crossing's centre line lies. */
  laneS?: number[];
}

// ── Lots, buildings, areas ──

export type Zone = 'downtown' | 'midrise' | 'residential' | 'civic' | 'park' | 'plaza' | 'industrial';
export type BuildingStyle = 'tower' | 'office' | 'midrise' | 'shop' | 'house' | 'landmark';
export type RoofKind = 'flat' | 'gable' | 'hip' | 'stepped' | 'dome' | 'spire';

/**
 * A building as an oriented box in plan space (the collision shape) plus style data for the
 * renderer. Its local frame: origin at the footprint centre on the ground, local +x = plan +x
 * rotated by `angle` toward plan +z, local +z = local +x rotated a further +90°. The building's
 * front (street side) faces local −z. Renderers may add detail (setbacks, roof props, awnings)
 * but must stay inside the box (w × d × h): the box is what collision and validation use.
 */
export interface Building {
  id: number;
  x: number;
  z: number;
  /** Rotation of the local +x axis from plan +x toward plan +z (rad). */
  angle: number;
  /** Full footprint extent along local x (frontage) and local z (depth), m. */
  w: number;
  d: number;
  /** Roof height above the plateau (m), excluding thin props (antennae ≤ 3 m may poke above). */
  h: number;
  style: BuildingStyle;
  roof: RoofKind;
  zone: Zone;
  /** Index into the wall palette (BRIEF §3: cream, terracotta, teal, mustard, coral, lilac, glass). */
  wall: number;
  /** Index into the roof palette (red, slate, green). */
  roofColor: number;
  /** Per-building variety seed (windows, props, awnings). */
  seed: number;
  /** The road edge it fronts onto, or -1. */
  frontEdge: number;
  /** Landmark kind, if any ('clocktower', 'stadium', 'mast', …). */
  landmark?: string;
  /** Optional setbacks: tiers from the bottom up, each the height it reaches and its inset (m). */
  tiers?: Array<{ h: number; inset: number }>;
  /**
   * Optional hand-dressing for the renderer (additive, A2): 'cafe' = a corner café (awning, blade
   * sign, tables outside), used on the building the street viewpoint (the dive's landing) looks at.
   */
  decor?: 'cafe';
  /** Local x (m, along the frontage) of the main entrance on the front face. Renderers put the door here. */
  door?: number;
}

export type AreaKind = 'park' | 'plaza' | 'garden' | 'lot' | 'water' | 'field';

/** A ground area (park, plaza, gardens). Trees and benches go here, never on roads. */
export interface Area {
  id: number;
  kind: AreaKind;
  /** Closed polygon (x, z interleaved, positive winding, last ≠ first). */
  outline: Float64Array;
  /**
   * Height of the area's surface above the plateau (m), when it is not AREA_H: downtown lots and the
   * plaza are paved flush with the sidewalks (ROAD_H + CURB_H − 4 mm, tucked under the slab edge),
   * courtyard lawns are raised beds. CityIndex.groundH returns it. (Additive, A2.)
   */
  h?: number;
}

/**
 * A point the city wants seen from (shots and fly-to defaults). `heading` is the look direction in
 * the plan as atan2(dx, −dz): 0 = plan −z (north at the centre), π/2 = plan +x (east). frame.ts
 * planHeadingToWorld() turns it into the true compass heading at (x, z).
 */
export interface Viewpoint {
  x: number;
  z: number;
  heading: number;
}

/**
 * Point features other systems decorate. A2 places them and renders everything except trees; A1
 * renders ALL trees (one instanced tree system, one look) from the 'tree' features, plus its own
 * scatter outside the plan. B2 may gather people at benches, fountains and bus stops.
 */
export interface Feature {
  kind: 'fountain' | 'bench' | 'streetlight' | 'bus-stop' | 'tree' | 'flag' | string;
  x: number;
  z: number;
  /** Facing (rad, plan angle like Building.angle). */
  angle: number;
  /** Collision radius for FPV / people (m). Default by kind: streetlight 0.2, tree 0.4 (trunk), flag 0.15, bench 0.5, bus-stop 0.6, fountain 1.6; others 0 (walk-through). */
  r?: number;
  /** Trees: size (crown height, m, 3–9) and a species/variety seed. */
  size?: number;
  seed?: number;
}

/** The whole city plan. Produced once, deterministically, from the world seed. */
export interface CityPlan {
  seed: number;
  /** Usable radius (m) of the plan around (0, 0); everything lies inside it. */
  radius: number;
  nodes: RoadNode[];
  edges: RoadEdge[];
  lanes: Lane[];
  connectors: Connector[];
  intersections: Intersection[];
  walkNodes: WalkNode[];
  walkEdges: WalkEdge[];
  buildings: Building[];
  areas: Area[];
  features: Feature[];
  /** Named viewpoints. The core shot list uses `street`, `rooftops`, `horizon` and `dusk`. */
  viewpoints: Record<'street' | 'rooftops' | 'horizon' | 'dusk', Viewpoint> & Record<string, Viewpoint>;
}

// ── Queries (built from a plan by world/city/index.ts) ──

/**
 * What lies on the ground at a plan point. 'lot' = a paved building lot (Area kind 'lot': the ground
 * of a downtown block between its buildings) and 'water' = a pond: nothing grows on either. 'free' =
 * bare plateau or an unpaved area (field). Water wins over the area it sits in (a pond in the park).
 */
export type GroundClass = 'road' | 'intersection' | 'sidewalk' | 'building' | 'plaza' | 'park' | 'garden' | 'lot' | 'water' | 'free' | 'outside';

/** A point on a path: position, unit tangent and the sample index it fell in. */
export interface PathSample {
  x: number;
  z: number;
  tx: number;
  tz: number;
  /** Index of the segment start sample (a hint for the next lookup). */
  i: number;
}

/** Spatial queries over a plan. Zero-alloc; all methods are O(1)-ish (uniform grid). */
export interface CityIndex {
  plan: CityPlan;
  /** Ground class at (x, z). Buildings win over everything; then intersections, roads, sidewalks, areas. */
  classify(x: number, z: number): GroundClass;
  /** True if a disc of radius r at (x, z) touches no road, sidewalk, intersection or building, and is inside the plan. */
  isClear(x: number, z: number, r: number): boolean;
  /** Roof height (m above the plateau) of the building under (x, z), or 0. */
  roofAt(x: number, z: number): number;
  /** Highest roof within distance r of (x, z), or 0 (camera ground reference). */
  maxRoofNear(x: number, z: number, r: number): number;
  /** Building ids whose footprint comes within r of (x, z). Writes into out, returns the count. */
  buildingsNear(x: number, z: number, r: number, out: number[]): number;
  /**
   * Push a disc (x, z, radius r) out of every building footprint and point obstacle (streetlights,
   * tree trunks, benches) it overlaps, so walls slide. Writes the resolved centre into out; returns
   * true if it moved.
   */
  collide(x: number, z: number, r: number, out: { x: number; z: number }): boolean;
  /** Nearest point on any road centreline: edge id (or -1 if none within maxDist), distance, s. */
  nearestRoad(x: number, z: number, maxDist: number, out: { edge: number; dist: number; s: number }): number;
  /**
   * Height (m above the plateau) of the walking / driving surface at (x, z): ROAD_H on roads and
   * intersections, ROAD_H + CURB_H on sidewalks (and under buildings), AREA_H in areas, 0 on bare
   * plateau, and the terrain (relative to the plateau) outside the plan.
   */
  groundH(x: number, z: number): number;
  /** Point obstacles from features with a collision radius: [x, z, r] interleaved. collide() includes them. */
  readonly obstacles: Float64Array;
}
