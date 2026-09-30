// Hooks other systems use to feed the beach materials. Code against these instead of importing
// beach internals. Setting a hook after the beach has built its materials recompiles them, so
// set it in your init() (the water system initialises before the beach) or in warmup().

import type { TSLNode } from '../core/contracts';

/**
 * Caustics on the seabed (A7). Called once while the seabed material is built:
 * (worldPos: vec3, normal: vec3 world, albedo: vec3) => vec3 extra radiance (linear, before fog).
 * The beach multiplies the result by its own underwater mask, so return caustics everywhere.
 */
export type CausticsHook = (worldPos: TSLNode, normal: TSLNode, albedo: TSLNode) => TSLNode;

type Listener = () => void;

const state: { caustics: CausticsHook | null; listeners: Listener[] } = { caustics: null, listeners: [] };

export function setCausticsHook(fn: CausticsHook | null) {
  state.caustics = fn;
  for (let i = 0; i < state.listeners.length; i++) state.listeners[i]();
}

export function getCausticsHook() {
  return state.caustics;
}

/** Internal: the beach registers here so a late hook rebuilds its material. */
export function onHooksChanged(fn: Listener) {
  state.listeners.push(fn);
  return () => {
    const i = state.listeners.indexOf(fn);
    if (i >= 0) state.listeners.splice(i, 1);
  };
}
