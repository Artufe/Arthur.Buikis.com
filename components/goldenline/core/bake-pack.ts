// [polish] Structured-clone packing for boot bakes run in workers: DataTextures and
// BufferGeometries become plain records whose typed arrays are transferred, not copied.

import { BufferAttribute, BufferGeometry, DataTexture } from 'three/webgpu';

type Packed = unknown;
const TEX_PROPS = ['name', 'format', 'type', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'generateMipmaps', 'anisotropy', 'colorSpace', 'flipY', 'unpackAlignment', 'internalFormat'] as const;

export function pack(v: unknown, transfer: Transferable[]): Packed {
  if (v === null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) {
    if (!transfer.includes(v.buffer as ArrayBuffer)) transfer.push(v.buffer as ArrayBuffer);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => pack(x, transfer));
  const t = v as DataTexture & { isDataTexture?: boolean };
  if (t.isDataTexture) {
    const props: Record<string, unknown> = {};
    for (const k of TEX_PROPS) props[k] = (t as unknown as Record<string, unknown>)[k];
    const img = t.image as { data: ArrayBufferView; width: number; height: number };
    return { __tex: true, data: pack(img.data, transfer), width: img.width, height: img.height, props };
  }
  const g = v as BufferGeometry & { isBufferGeometry?: boolean };
  if (g.isBufferGeometry) {
    const attrs: Record<string, unknown> = {};
    for (const k in g.attributes) {
      const a = g.attributes[k] as BufferAttribute;
      attrs[k] = { array: pack(a.array, transfer), itemSize: a.itemSize, normalized: a.normalized };
    }
    return { __geo: true, attrs, index: g.index ? pack(g.index.array, transfer) : null };
  }
  const out: Record<string, unknown> = {};
  for (const k in v as Record<string, unknown>) out[k] = pack((v as Record<string, unknown>)[k], transfer);
  return out;
}

/** Rebuild three objects from a packed record. Typed arrays are shared with the record. */
export function unpack<T>(v: Packed): T {
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v as T;
  if (Array.isArray(v)) return v.map((x) => unpack(x)) as T;
  const r = v as Record<string, unknown>;
  if (r.__tex) {
    const tex = new DataTexture(r.data as ArrayBufferView as never, r.width as number, r.height as number);
    Object.assign(tex, r.props as object);
    tex.needsUpdate = true;
    return tex as T;
  }
  if (r.__geo) {
    const g = new BufferGeometry();
    const attrs = r.attrs as Record<string, { array: ArrayLike<number>; itemSize: number; normalized: boolean }>;
    for (const k in attrs) g.setAttribute(k, new BufferAttribute(attrs[k].array as never, attrs[k].itemSize, attrs[k].normalized));
    if (r.index) g.setIndex(new BufferAttribute(r.index as never, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g as T;
  }
  const out: Record<string, unknown> = {};
  for (const k in r) out[k] = unpack(r[k]);
  return out as T;
}
