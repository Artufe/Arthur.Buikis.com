// STUB (orchestrator). OWNER: pier agent — replace wholesale. See docs/goldenline/TASKS.md.
import { BoxGeometry, CylinderGeometry, InstancedMesh, Matrix4, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import type { GLContext, GLSystem } from '../core/contracts';
import { PIER } from '../world/layout';

export function createPierSystem(): GLSystem {
  let deck: Mesh | null = null;
  let piles: InstancedMesh | null = null;
  let mat: MeshStandardNodeMaterial | null = null;
  return {
    name: 'pier',
    init(ctx: GLContext) {
      mat = new MeshStandardNodeMaterial({ color: 0x8a7458, roughness: 0.85 });
      const len = PIER.rootX - PIER.tipX;
      deck = new Mesh(new BoxGeometry(len, 0.25, PIER.width), mat);
      deck.position.set((PIER.rootX + PIER.tipX) / 2, PIER.deckHeight - 0.125, PIER.z);
      deck.castShadow = deck.receiveShadow = true;
      const n = Math.floor(len / PIER.pilingSpacing) + 1;
      piles = new InstancedMesh(new CylinderGeometry(0.16, 0.18, 14, 10), mat, n * 2);
      const m = new Matrix4();
      for (let i = 0; i < n; i++) {
        const x = PIER.rootX - i * PIER.pilingSpacing;
        for (let s = 0; s < 2; s++) {
          m.makeTranslation(x, PIER.deckHeight - 7.2, PIER.z + (s ? 1 : -1) * (PIER.width / 2 - 0.1));
          piles.setMatrixAt(i * 2 + s, m);
        }
      }
      piles.castShadow = piles.receiveShadow = true;
      ctx.scene.add(deck, piles);
    },
    dispose(ctx: GLContext) {
      if (deck) {
        ctx.scene.remove(deck);
        deck.geometry.dispose();
      }
      if (piles) {
        ctx.scene.remove(piles);
        piles.geometry.dispose();
        piles.dispose();
      }
      mat?.dispose();
    },
  };
}
