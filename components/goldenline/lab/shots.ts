// Named camera shots for milestone screenshots and visual review. Shared registry:
// agents may APPEND shots (prefix the name with your area, e.g. 'pier-underdeck'), never
// edit or remove someone else's. `t` pins simulation time so a shot is reproducible.

import type { GLContext } from '../core/contracts';
import type { DebugHook } from '../core/debug';
import { PEAK, PIER, SPAWN, shoreX } from '../world/layout';

export interface Shot {
  /** Camera position; `y` is metres above the terrain unless `absY` is set. */
  x: number;
  y: number;
  z: number;
  absY?: boolean;
  /** Either yaw/pitch (radians) or a look-at target. */
  yaw?: number;
  pitch?: number;
  lookAt?: [number, number, number];
  /** Simulation time (s) to jump to before the shot. */
  t?: number;
  /** Param overrides applied for this shot. */
  params?: Record<string, number | boolean>;
  note: string;
}

/** yaw such that forward points along (dx, dz). */
export const yawToward = (dx: number, dz: number) => Math.atan2(-dx, -dz);

export const SHOTS: Record<string, Shot> = {
  'beach-sun': { x: SPAWN.x - 6, y: 1.68, z: SPAWN.z - 8, lookAt: [PEAK.x, 2, PEAK.z + 40], t: 30, note: 'M2 gate: standing on the sand, looking out at the break with the sun low ahead' },
  'pier-silhouette': { x: PIER.rootX - 12, y: 1.5, z: PIER.z - 14, lookAt: [PIER.tipX, 3, PIER.z + 6], t: 30, note: 'Pier silhouetted against the sun from the sand' },
  'wetsand-reflection': { x: 6, y: 1.9, z: PIER.z - 10, absY: true, lookAt: [PIER.tipX * 0.6, 2, PIER.z + 4], t: 30, note: 'Low over wet sand: pier + sun reflected in the swash film' },
  'shorebreak': { x: 10, y: 1.6, z: 0, lookAt: [-12, 0.4, -6], t: 42, note: 'Shore break dumping, swash sheeting up the sand' },
  'lineup': { x: -104, y: 0.55, z: -62, absY: true, lookAt: [PEAK.x, 1.2, PEAK.z + 10], t: 36, note: 'Paddling eye line in the lineup, set approaching, backlit' },
  'pier-deck': { x: -70, y: PIER.deckHeight + 1.68, z: PIER.z, absY: true, lookAt: [-120, 0, -20], t: 30, note: 'Standing on the deck looking at the reef break' },
  'pier-under': { x: 12, y: 1.4, z: PIER.z + 0.4, lookAt: [-40, 1.2, PIER.z], t: 30, note: 'Under the pier: plank-gap light stripes, caustics on the deck underside' },
  'aerial': { x: 80, y: 70, z: -60, absY: true, lookAt: [-90, 0, 10], t: 30, note: 'Layout overview (debug only, not a beauty shot)' },
  'ocean-reef-plan': { x: -60, y: 190, z: -40, absY: true, lookAt: [-125, 0, -45], t: 40, note: 'Ocean: high over the reef, swell lines bending and sets arriving (debug view)' },
  'ocean-side': { x: -128, y: 1.2, z: -150, absY: true, lookAt: [-118, 0.6, -40], t: 40, note: 'Ocean: low, looking along the crests toward the pier: swell profile and steepening over the reef' },
  'ocean-arm': { x: -250, y: 0.5, z: -60, absY: true, yaw: -1.2, pitch: -0.28, t: 40, note: 'Ocean: 0.5 m over deep water looking down-sun-away: near-field faceting, tiling, three scales' },
  'ocean-horizon': { x: -70, y: 5.9, z: 48, absY: true, yaw: 0.6, pitch: -0.02, t: 40, note: 'Ocean: from the pier deck toward the open horizon (off-sun): far-field aliasing, swell lines' },
  'ocean-sets': { x: 20, y: 45, z: -60, absY: true, lookAt: [-140, 0, -60], t: 0, note: 'Ocean: elevated from behind the beach over the reef, for --seq set/lull rhythm (use ocean.view=3)' },
  'ocean-profile': { x: -168, y: 1.6, z: -150, absY: true, lookAt: [-128, 0.9, -78], t: 40, note: 'Ocean: low beyond the peak, looking along the reef edge: set waves jacking up on the ledge' },
  'ocean-backlit': { x: -95, y: 0.9, z: -40, absY: true, lookAt: [-140, 1.0, -70], t: 40, note: 'Ocean: low inside the reef looking back out at an incoming set, sun behind the waves' },
  'water-shallows': { x: 5, y: 1.7, z: -100, lookAt: [-9, -1.2, -104], t: 30, note: 'Water: standing at the waterline looking down into 0.3-1.5 m: turquoise over sand, caustics, refraction' },
  'water-glitter': { x: -104, y: 0.55, z: -62, absY: true, lookAt: [-201, 0.2, -46.6], t: 36, note: 'Water: paddling eye line straight down the sun path: glitter roll-off and stability (use --seq)' },
  'water-foam': { x: -10, y: 1.9, z: 19.5, absY: true, lookAt: [-16, 0, 14], t: 34, params: { 'state.debugScene': true }, note: 'Water: the state debug foam patch shaded (fresh bubbly foam → lace → dissolving; use --seq)' },
  'water-crest': { x: -115, y: 0.95, z: -95, absY: true, lookAt: [-134.8, 1.05, -91.9], t: 30, note: 'Water: backlit steep crest (boot with --p water.testCrest=1 until A8 breakers exist): SSS gold → green with thickness' },
  'water-foamtest': { x: -10.5, y: 3.2, z: 21, absY: true, lookAt: [-17, 0, 14], t: 30, params: { 'water.foamTest': true }, note: 'Water debug: foam coverage ramp (0 → 1 toward +X) × age ramp (fresh → old toward +Z)' },
  'beach-dry': { x: 40, y: 1.68, z: 0, lookAt: [18, 1.2, -120], t: 30, note: 'Dry upper beach looking along the shore toward the headland, sun to the right' },
  'beach-feet': { x: 38, y: 1.68, z: 6, yaw: Math.PI / 2, pitch: -1.05, t: 30, params: { 'beach.debugPrints': 12 }, note: 'Looking down at dry sand: ripples, grain, a debug footprint trail' },
  'beach-wetfeet': { x: 16, y: 1.68, z: 6, yaw: Math.PI / 2 + 0.3, pitch: -0.75, t: 30, note: 'Looking down the beach face at damp and wet sand toward the sun' },
  'beach-seabed': { x: -60, y: -2.6, z: 36, absY: true, yaw: 0.86, pitch: -0.25, t: 30, note: 'Under water in the channel, looking at the reef flank: coral heads, reef rock, sand ripples (seabed shading)' },
  'beach-headland': { x: 10, y: 1.7, z: -200, lookAt: [-320, 25, -600], t: 30, note: 'The volcanic headland across the water, aerial perspective' },
  'beach-dune': { x: 42, y: 1.68, z: -14, lookAt: [92, 6, 22], t: 30, note: 'Looking landward at the dune line, grass and palms (front-lit)' },
  'beach-wrack': { x: 17, y: 1.68, z: 14, lookAt: [14.5, 0.6, 9], t: 30, note: 'Looking down at the high-tide wrack line: dried seaweed, shells, coral rubble' },
  'beach-palms': { x: 58, y: 3.4, z: -48, lookAt: [-40, 8, 10], t: 30, note: 'From the dune toe toward the sun: backlit palms and grass against the sea' },
  'beach-wetsand': { x: 12, y: 1.3, z: 24, lookAt: [-40, 0.2, 50], t: 30, note: 'Low over the swash zone toward pier and sun: wet-sand gloss, film reflection' },
  'state-footprints': { x: 43.1, y: 1.15, z: 2.2, lookAt: [41.4, 1.75, -2.2], t: 30, params: { 'state.debugScene': true }, note: 'State debug: dry-sand footprint trail (add --p state.debug=2 for the lit relief view); --seq 8 --interval 10 shows it hold, then erased at +66 s' },
  'state-wetprints': { x: shoreX(6) + 7.4, y: 1.2, z: 8.4, lookAt: [shoreX(6) + 5.2, -0.7, 2.4], t: 30, params: { 'state.debugScene': true }, note: 'State debug: prints in saturated sand filling with water; a swash erases the lower half at +40 s' },
  'state-foam': { x: -9, y: 13, z: 19, absY: true, lookAt: [-17, 0, 13.5], t: 30, params: { 'state.debugScene': true }, note: 'State debug: a foam patch drifting, breaking into lace and dissolving over ~50 s, wake V and rings beside it (add --p state.debug=1 for the channel overlay)' },
  'state-channels': { x: 6, y: 60, z: 8, absY: true, yaw: Math.PI / 2, pitch: -1.35, t: 30, params: { 'state.debugScene': true, 'state.debug': 1 }, note: 'State debug: every channel over the near window from above' },
  'pier-piling': { x: -46.3, y: 0.85, z: 45.3, absY: true, lookAt: [-44, 0.45, PIER.z - 1.42], t: 30, note: 'Paddling height beside a piling, sun behind: tide band, algae, barnacles, foam collar' },
  'pier-rail': { x: -30, y: PIER.deckHeight + 1.62, z: PIER.z + 0.9, absY: true, lookAt: [-33.2, PIER.deckHeight + 0.55, PIER.z + 1.7], t: 30, note: 'Arm\'s length on the deck: planks, gaps, nails, rope railing and hitches' },
  'pier-stairs': { x: 45, y: 1.68, z: 43, lookAt: [34, 3.2, PIER.z], t: 30, note: 'The root of the pier from the dry sand: stairs up to the deck' },
  'pier-spray': { x: -50, y: 1.6, z: 39, absY: true, lookAt: [-63, 1.0, PIER.z], t: 16, params: { 'pier.surge': 1 }, note: 'Debug surge: whitewater bore hitting the pilings (use --advance 2); spray bursts + collars' },
  'pier-under-water': { x: -24, y: 1.3, z: PIER.z + 0.5, absY: true, lookAt: [-70, 1.6, PIER.z - 0.4], t: 30, note: 'Under the deck over the water: cool underside, dancing caustics, plank-gap stripes' },
  'pier-down': { x: -52, y: PIER.deckHeight + 1.68, z: PIER.z - 0.3, absY: true, yaw: Math.PI / 2, pitch: -1.2, t: 30, note: 'Looking down through the plank gaps at the water below' },
  'player-lineup': { x: -104, y: 0.55, z: -62, absY: true, lookAt: [PEAK.x, 1.2, PEAK.z + 10], t: 36, params: { 'player.follow': true }, note: 'Player: the lineup shot with the body under the camera: board nose and paddling hands' },
  'player-carry': { x: 20, y: 1.7, z: 4, t: 30, params: { 'player.demo': 6, 'player.demoAt': 3 }, note: 'Player (demo 6): walking the sand with the board under the arm' },
  'player-feet': { x: 22, y: 1.7, z: 16, t: 30, params: { 'player.demo': 5, 'player.demoAt': 2.6 }, note: 'Player (demo 5): looking down while walking: feet, footprints on the landing frame' },
  'player-wade': { x: 16, y: 1.7, z: 6, t: 30, params: { 'player.demo': 2, 'player.demoAt': 9 }, note: 'Player (demo 2): wading out, board floating alongside' },
  'player-paddle': { x: -104, y: 0.6, z: -62, absY: true, t: 36, params: { 'player.demo': 3, 'player.demoAt': 3 }, note: 'Player (demo 3): prone paddling in the lineup, strokes and board' },
  'player-deck': { x: SPAWN.x, y: 1.7, z: SPAWN.z, t: 30, params: { 'player.demo': 1, 'player.demoAt': 26 }, note: 'Player (demo 1): out on the pier deck after climbing the steps' },
  'player-catch': { x: PEAK.x, y: 0.6, z: PEAK.z, absY: true, t: 36, params: { 'player.demo': 4, 'player.demoAt': 0 }, note: 'Player (demo 4): at the peak, paddling for a wave and popping up (use --seq)' },
  'atmosphere-probes': { x: 18, y: 1.7, z: 7, lookAt: [17.5, 0.2, 0], t: 30, params: { 'atmosphere.probes': true }, note: 'Atmosphere: calibration spheres, slatted fence (near-shadow crispness at 2 m), SSR mirror, pole shadow' },
  'atmosphere-antisun': { x: SPAWN.x - 10, y: 1.7, z: SPAWN.z - 6, lookAt: [120, 18, -40], t: 30, note: 'Atmosphere: facing away from the sun: anti-solar sky gradient, lit dune faces, shadow colour' },
  'atmosphere-sun': { x: SPAWN.x - 6, y: 1.68, z: SPAWN.z - 8, lookAt: [SPAWN.x - 6 - 982, 1.68 + 191, SPAWN.z - 8 + 156], t: 30, note: 'Atmosphere: straight at the sun: disc, limb darkening, aureole, glitter roll-off' },
  'atmosphere-sun-disc': { x: SPAWN.x - 6, y: 1.68, z: SPAWN.z - 8, lookAt: [SPAWN.x - 6 - 982, 1.68 + 191, SPAWN.z - 8 + 156], t: 30, params: { 'core.exposure': 0.004, 'post.bloom': false, 'atmosphere.sunSize': 3 }, note: 'Atmosphere: exposure-bracketed (-8 EV) sun, disc enlarged 3x to show the per-channel limb darkening' },
  'atmosphere-shadow-near': { x: 20.6, y: 1.7, z: 2.6, lookAt: [21.6, 0.05, 0.6], t: 30, params: { 'atmosphere.probes': true }, note: 'Atmosphere: fence (plank-gap sized slats) shadow ~2 m from the eye: near-cascade PCSS crispness' },
  'atmosphere-pier-shadow': { x: 12, y: 14, z: 26, absY: true, lookAt: [-150, 0, 44], t: 30, note: 'Atmosphere: the pier shadow on the water out to 150+ m (far cascades)' },
  'breaking-peel': { x: 13, y: 1.7, z: 22, lookAt: [-112, 0.8, -40], t: 36, note: 'Breaking (M3 gate): from the sand at the waterline, the first set peeling down the reef toward the pier (use --seq 60 --interval 1)' },
  'breaking-tube': { x: -116.4, y: 0.4, z: -45, absY: true, lookAt: [-117, 0.7, -28], t: 42, note: 'Breaking: inside the barrel looking down the line at the opening (use --advance 0.5)' },
  'breaking-front': { x: -92, y: 2.2, z: -98, absY: true, lookAt: [-110, 1, -120], t: 39.5, note: 'Breaking: from the lagoon, the peak barrel and its whitewater explosion (use --advance 1.5)' },
  'breaking-shoulder': { x: -100, y: 2, z: -8, absY: true, lookAt: [-118, 1.2, -45], t: 41.5, note: 'Breaking: on the shoulder, the set wave peeling toward the camera, veil streaming off the lip (use --advance 1.5)' },
  'breaking-swash': { x: 6, y: 1.25, z: 2, lookAt: [-4, -0.3, -2], t: 41, note: 'Breaking: the shore break and the swash sheet running up the beach face (use --advance 2.8, or --seq 12 --interval 0.5)' },
};

export function applyShot(ctx: GLContext, s: Shot, hook: DebugHook) {
  if (s.t !== undefined) hook.setTime(s.t);
  if (s.params) for (const k in s.params) ctx.params.set(k, s.params[k]);
  const y = s.absY ? s.y : ctx.services.terrain.height(s.x, s.z) + s.y;
  let yaw = s.yaw ?? 0;
  let pitch = s.pitch ?? 0;
  if (s.lookAt) {
    const dx = s.lookAt[0] - s.x;
    const dy = s.lookAt[1] - y;
    const dz = s.lookAt[2] - s.z;
    yaw = yawToward(dx, dz);
    pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }
  hook.camera(s.x, y, s.z, yaw, pitch);
}
