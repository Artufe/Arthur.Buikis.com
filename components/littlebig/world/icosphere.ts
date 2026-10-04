// Indexed unit icosphere by recursive 4-way subdivision. Pure. Detail d has 10·4^d + 2 vertices
// and 20·4^d triangles (d 6: 40 962 / 81 920; d 7: 163 842 / 327 680). Triangles are close to
// equilateral, which keeps flat-shaded facets clean (no slivers).

export interface Icosphere {
  /** Unit vertex directions, xyz interleaved. */
  positions: Float32Array;
  /** Triangle indices, counter-clockwise seen from outside. */
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

const cache = new Map<number, Icosphere>();

/** Cached: the same detail returns the same arrays. Treat them as read-only. */
export function icosphere(detail: number): Icosphere {
  const hit = cache.get(detail);
  if (hit) return hit;
  const res = build(detail);
  cache.set(detail, res);
  return res;
}

function build(detail: number): Icosphere {
  const vCount = 10 * 4 ** detail + 2;
  const pos = new Float64Array(vCount * 3);
  const t = (1 + Math.sqrt(5)) / 2;
  const base = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let n = 0;
  for (const [x, y, z] of base) {
    const l = Math.hypot(x, y, z);
    pos[n * 3] = x / l;
    pos[n * 3 + 1] = y / l;
    pos[n * 3 + 2] = z / l;
    n++;
  }
  let faces = new Uint32Array([
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ]);
  for (let d = 0; d < detail; d++) {
    const mid = new Map<number, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * vCount + b : b * vCount + a;
      const hit = mid.get(key);
      if (hit !== undefined) return hit;
      const x = pos[a * 3] + pos[b * 3];
      const y = pos[a * 3 + 1] + pos[b * 3 + 1];
      const z = pos[a * 3 + 2] + pos[b * 3 + 2];
      const l = Math.hypot(x, y, z);
      pos[n * 3] = x / l;
      pos[n * 3 + 1] = y / l;
      pos[n * 3 + 2] = z / l;
      mid.set(key, n);
      return n++;
    };
    const next = new Uint32Array(faces.length * 4);
    let k = 0;
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f];
      const b = faces[f + 1];
      const c = faces[f + 2];
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.set([a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca], k);
      k += 12;
    }
    faces = next;
  }
  return {
    positions: Float32Array.from(pos),
    indices: faces,
    vertexCount: vCount,
    triangleCount: faces.length / 3,
  };
}
