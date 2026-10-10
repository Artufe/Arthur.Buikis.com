// Spatial chunks for the nature instances (A1). Each InstancedMesh is culled by three as ONE object,
// so the planet's far side used to draw (and cast shadows) at street level: ~1.3 M triangles. The
// instances of every kind are sorted by chunk (the icosphere's detail-1 face they stand on, plus one
// chunk for the city's trees); each frame the chunks below the horizon or outside the (inflated)
// view frustum are dropped, and when the visible set changes the survivors are compacted to the
// front of the instance buffers (a memcpy of contiguous ranges, then mesh.count). Pure TS.

/** Chunk id of a terrain face at `detail` (its detail-1 ancestor: faces are ordered hierarchically). */
export function chunkOfFace(face: number, detail: number): number {
  return face < 0 ? CITY_CHUNK : face >> (2 * (detail - 1));
}
/** Detail-1 icosphere faces + one chunk for the city's own trees. */
export const CHUNKS = 81;
export const CITY_CHUNK = 80;

export interface ChunkBounds {
  /** Unit centre direction per chunk (xyz), angular radius (rad) and highest instance top (m above R). */
  dir: Float32Array;
  rad: Float32Array;
  top: Float32Array;
  /** acos(R / (R + top)): how far past the eye's horizon the chunk's tallest top still shows. */
  over: Float32Array;
  /** Bounding sphere (world): centre xyz + radius, for the frustum test. */
  sphere: Float32Array;
  used: Uint8Array;
}

/**
 * Chunk bounds from instance bases (world xyz), their chunk ids and heights (m).
 */
export function chunkBounds(pos: Float32Array, chunk: Int32Array, height: Float32Array, count: number, R: number): ChunkBounds {
  const dir = new Float32Array(CHUNKS * 3);
  const rad = new Float32Array(CHUNKS);
  const top = new Float32Array(CHUNKS);
  const over = new Float32Array(CHUNKS);
  const sphere = new Float32Array(CHUNKS * 4);
  const used = new Uint8Array(CHUNKS);
  for (let i = 0; i < count; i++) {
    const c = chunk[i];
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const l = Math.hypot(x, y, z);
    dir[c * 3] += x / l;
    dir[c * 3 + 1] += y / l;
    dir[c * 3 + 2] += z / l;
    top[c] = Math.max(top[c], l - R + height[i]);
    used[c] = 1;
  }
  for (let c = 0; c < CHUNKS; c++) {
    const l = Math.hypot(dir[c * 3], dir[c * 3 + 1], dir[c * 3 + 2]) || 1;
    dir[c * 3] /= l;
    dir[c * 3 + 1] /= l;
    dir[c * 3 + 2] /= l;
  }
  for (let i = 0; i < count; i++) {
    const c = chunk[i];
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const l = Math.hypot(x, y, z);
    const d = (x * dir[c * 3] + y * dir[c * 3 + 1] + z * dir[c * 3 + 2]) / l;
    rad[c] = Math.max(rad[c], Math.acos(Math.min(1, d)));
  }
  for (let c = 0; c < CHUNKS; c++) {
    const rt = R + Math.max(0, top[c]);
    over[c] = Math.acos(Math.min(1, R / rt));
    // Sphere around the cap from sea level to the tops.
    const ca = Math.cos(rad[c]), sa = Math.sin(rad[c]);
    const k = (R * ca + rt) / 2;
    sphere[c * 4] = dir[c * 3] * k;
    sphere[c * 4 + 1] = dir[c * 3 + 1] * k;
    sphere[c * 4 + 2] = dir[c * 3 + 2] * k;
    sphere[c * 4 + 3] = Math.max(Math.hypot(rt * sa, rt * ca - k), Math.hypot(R * sa, R * ca - k), rt - k) + 1;
  }
  return { dir, rad, top, over, sphere, used };
}

/**
 * Horizon test: can anything in chunk c be seen from an eye at unit direction (ex, ey, ez), at
 * distance `de` from the centre, over a sea-level sphere of radius R? `margin` (rad) widens it.
 */
export function chunkAboveHorizon(b: ChunkBounds, c: number, ex: number, ey: number, ez: number, eyeHorizon: number, margin: number): boolean {
  const reach = eyeHorizon + b.over[c] + b.rad[c] + margin;
  if (reach >= Math.PI) return true;
  return ex * b.dir[c * 3] + ey * b.dir[c * 3 + 1] + ez * b.dir[c * 3 + 2] > Math.cos(reach);
}

/**
 * One instanced kind's instances, sorted by chunk, with master copies of every per-instance array.
 * compact() writes the visible chunks' instances contiguously into the live arrays.
 */
export class ChunkedKind {
  readonly start = new Int32Array(CHUNKS + 1);
  readonly order: Int32Array;
  constructor(chunkOfInstance: Int32Array, count: number) {
    const n = new Int32Array(CHUNKS);
    for (let i = 0; i < count; i++) n[chunkOfInstance[i]]++;
    for (let c = 0; c < CHUNKS; c++) this.start[c + 1] = this.start[c] + n[c];
    const fill = this.start.slice(0, CHUNKS);
    this.order = new Int32Array(count);
    for (let i = 0; i < count; i++) this.order[fill[chunkOfInstance[i]]++] = i;
  }
  /** Copy chunk ranges of `master` (stride floats per instance, chunk order) into `live`; returns the instance count. */
  compact(visible: Uint8Array, master: Float32Array, live: Float32Array, stride: number): number {
    let o = 0;
    for (let c = 0; c < CHUNKS; c++) {
      if (!visible[c]) continue;
      const a = this.start[c], e = this.start[c + 1];
      if (e === a) continue;
      live.set(master.subarray(a * stride, e * stride), o * stride);
      o += e - a;
    }
    return o;
  }
}
