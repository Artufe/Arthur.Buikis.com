// Lighting probes for review (param `atmosphere.probes`, off by default): calibration spheres
// (albedo 0.18 / 0.5 / 0.85), a slatted fence 2 m from the camera to judge near-shadow crispness
// (plank-gap sized gaps), a mirror sheet that opts into SSR, and a 6 m pole whose long shadow
// crosses open sand. Shot: `atmosphere-probes` in lab/shots.ts.

import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardNodeMaterial, PlaneGeometry, SphereGeometry, type Scene } from 'three/webgpu';
import { float } from 'three/tsl';
import type { TerrainService } from '../core/contracts';
import { ssrOptIn } from '../post/ssr';

export const PROBE_ORIGIN = { x: 20, z: 2 };

export function createProbes(scene: Scene, terrain: TerrainService) {
  const group = new Group();
  group.name = 'goldenline.atmosphereProbes';
  const geos: { dispose(): void }[] = [];
  const mats: MeshStandardNodeMaterial[] = [];
  const mat = (color: number, roughness: number, metalness = 0) => {
    const m = new MeshStandardNodeMaterial({ color, roughness, metalness });
    mats.push(m);
    return m;
  };
  const add = (mesh: Mesh, x: number, dy: number, z: number) => {
    mesh.position.set(x, terrain.height(x, z) + dy, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const { x: ox, z: oz } = PROBE_ORIGIN;

  const sphere = new SphereGeometry(0.35, 64, 32);
  geos.push(sphere);
  // albedos 0.18 / 0.5 / 0.85 in linear (the Color hex is sRGB)
  add(new Mesh(sphere, mat(0x767676, 0.7)), ox - 3, 0.35, oz - 3.2);
  add(new Mesh(sphere, mat(0xbcbcbc, 0.7)), ox - 3, 0.35, oz - 2.2);
  add(new Mesh(sphere, mat(0xeeeeee, 0.7)), ox - 3, 0.35, oz - 1.2);

  // slatted fence: 6 cm slats with 2 cm gaps, like deck planks, 1.1 m tall
  const slat = new BoxGeometry(0.02, 1.1, 0.06);
  geos.push(slat);
  const wood = mat(0x8a6a4a, 0.8);
  for (let i = 0; i < 24; i++) add(new Mesh(slat, wood), ox - 1.4, 0.55, oz - 1.6 + i * 0.08);

  // mirror sheet (SSR opt-in): weight 1, roughness 0.03
  const sheetGeo = new PlaneGeometry(2.2, 2.2);
  sheetGeo.rotateX(-Math.PI / 2);
  geos.push(sheetGeo);
  const mirror = mat(0xffffff, 0.03, 1);
  mirror.mrtNode = ssrOptIn(float(1), float(0.03));
  add(new Mesh(sheetGeo, mirror), ox - 4.5, 0.03, oz + 1.6).castShadow = false;

  // tall pole with a long low-sun shadow
  const pole = new CylinderGeometry(0.06, 0.06, 6, 16);
  geos.push(pole);
  add(new Mesh(pole, wood), ox - 7, 3, oz - 1);

  const box = new BoxGeometry(0.3, 0.3, 0.3);
  geos.push(box);
  add(new Mesh(box, mat(0xbcbcbc, 0.8)), ox - 2.2, 0.15, oz + 0.2);

  scene.add(group);
  return {
    dispose() {
      scene.remove(group);
      for (let i = 0; i < geos.length; i++) geos[i].dispose();
      for (let i = 0; i < mats.length; i++) mats[i].dispose();
    },
  };
}
