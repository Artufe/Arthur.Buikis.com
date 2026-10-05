// The review tooling's handle on the engine's modules (see core/kit.ts): filled by the engine
// before core/debug.ts loads (and by core/kit-fill.ts in specs), so debug-side modules may read it
// at module level. Debug-side modules import only this and types from the engine side.

import type { Kit } from './kit';

export const K = {} as Kit;

export function useKit(kit: Kit): void {
  Object.assign(K, kit);
}
