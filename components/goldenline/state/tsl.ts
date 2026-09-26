// Untyped re-export of the TSL functions this system uses. The three TSL typings are too
// narrow for generic node code (see TSLNode in core/contracts.ts), so the state code builds
// its graphs through this module.

import * as T from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const A = T as any;
type F = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const Fn: F = A.Fn;
export const If: F = A.If;
export const Loop: F = A.Loop;
export const abs: F = A.abs;
export const clamp: F = A.clamp;
export const dot: F = A.dot;
export const exp: F = A.exp;
export const exp2: F = A.exp2;
export const log2: F = A.log2;
export const float: F = A.float;
export const floor: F = A.floor;
export const fract: F = A.fract;
export const int: F = A.int;
export const ivec2: F = A.ivec2;
export const length: F = A.length;
export const max: F = A.max;
export const min: F = A.min;
export const mix: F = A.mix;
export const mod: F = A.mod;
export const normalize: F = A.normalize;
export const sin: F = A.sin;
export const smoothstep: F = A.smoothstep;
export const sqrt: F = A.sqrt;
export const storage: F = A.storage;
export const texture: F = A.texture;
export const textureStore: F = A.textureStore;
export const transformNormalToView: F = A.transformNormalToView;
export const uint: F = A.uint;
export const uniform: F = A.uniform;
export const uniformArray: F = A.uniformArray;
export const vec2: F = A.vec2;
export const vec3: F = A.vec3;
export const vec4: F = A.vec4;
export const globalId = A.globalId;
export const localId = A.localId;
export const workgroupId = A.workgroupId;
export const positionLocal = A.positionLocal;
export const positionGeometry = A.positionGeometry;
export const positionWorld = A.positionWorld;
export const varying: F = A.varying;

/**
 * A base texture node for `.sample(uv)` / `.load(coord)` clones. Built with a placeholder uv so
 * three doesn't apply the texture matrix (it enables that for uv-less nodes, and every clone
 * inherits it; in compute it also fails to compile).
 */
export const baseTex = (t: unknown) => A.texture(t, A.vec2(0, 0));
