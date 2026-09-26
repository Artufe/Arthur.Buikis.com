// World layout: the fixed composition every system agrees on. Orchestrator-owned.
// Changing these moves the whole scene, so propose changes in DECISIONS.md rather than editing.
//
// Seen from above (right-handed, Y up): standing on the beach facing the sea (-X),
// +Z is on your LEFT and -Z on your RIGHT. There is no compass in code; say +Z / -Z.
//
//        +Z  (left, facing the sea)
//         │   channel (no break)      ═══════════════ pier (z = PIER.z) ═════╗ root on dry sand
//         │                                                                   ║
//         │        reef edge ╲  waves peel toward +Z, toward the pier         ║
//  sun ── │ ── -X (open ocean)         ╲                shoreline ~x=0 │ beach → dune → palms (+X)
//         │                    peak ●   ╲                              │
//        -Z  (right, facing the sea)

export const SEA_LEVEL = 0;

/** Sun: golden hour, fixed. Elevation and azimuth in degrees; azimuth 0 = straight out to sea (-X), + = toward +Z (left of centre from the beach). */
export const SUN = { elevationDeg: 11, azimuthDeg: 9 };

/** Shoreward swell direction (unit XZ) and the groundswell's peak period. */
export const SWELL = { dirX: 0.97, dirZ: 0.243, periodS: 12, setSize: [3, 5] as const, setIntervalS: 70 };

/** Offshore breeze: blows from land to sea (toward -X), feathering spray off the lips. */
export const WIND = { dirX: -0.96, dirZ: -0.28, speed: 4.5 };

/** Shoreline at the mean water line: x = shoreX(z). */
export const shoreX = (z: number) => 4 * Math.sin(z / 85) + 2 * Math.sin(z / 31 + 1.3);

/** The reef shelf edge where waves break: a line from REEF.a (-Z) to REEF.b (+Z). */
export const REEF = {
  a: { x: -140, z: -110 }, // -Z end: the peak, where sets first break
  b: { x: -96, z: 30 }, // +Z end, fading into the channel beside the pier
  topDepth: 1.6, // water depth over the reef top (m)
  width: 70, // reef shelf width shoreward of the edge (m)
};

/** Where the surfable peak sits (takeoff zone). */
export const PEAK = { x: -138, z: -100 };

/** The pier: a straight deck along -X at z = PIER.z, from the dry sand into the channel. */
export const PIER = {
  z: 48,
  rootX: 34, // landward end on dry sand
  tipX: -176, // seaward end, past the break, in the channel
  deckHeight: 4.2, // top of deck above sea level (m)
  width: 3.2,
  pilingSpacing: 6,
};

/** The deeper sand channel beside the pier where waves don't break. */
export const CHANNEL = { zMin: 34, zMax: 78, depth: 4.5 };

/** Player spawn: dry sand on the -Z side of the pier root, looking out to sea. yaw: see player contract. */
export const SPAWN = { x: 24, z: 24, yaw: Math.PI / 2 };

/**
 * Camera yaw convention (all systems): forward = (-sin(yaw), 0, -cos(yaw)).
 * yaw = 0 looks toward -Z, yaw = PI/2 looks out to sea (-X).
 */
export const forwardX = (yaw: number) => -Math.sin(yaw);
export const forwardZ = (yaw: number) => -Math.cos(yaw);

/** The area covered by the baked base heightfield (minX, minZ, maxX, maxZ) and its texel (m). */
export const TERRAIN_BOUNDS: [number, number, number, number] = [-512, -384, 256, 384];
export const TERRAIN_TEXEL = 1;
