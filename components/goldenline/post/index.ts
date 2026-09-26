// STUB (orchestrator). OWNER: atmosphere agent (post chain) — replace wholesale.
import type { GLContext, GLSystem } from '../core/contracts';
import { stubPost } from '../core/stubs';

export function createPostSystem(): GLSystem {
  return {
    name: 'post',
    init(ctx: GLContext) {
      ctx.services.post = stubPost();
    },
  };
}
