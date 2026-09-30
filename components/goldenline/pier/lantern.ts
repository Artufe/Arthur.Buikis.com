// Unlit hurricane lanterns hung from iron brackets on the taller posts: black paint worn to rust,
// a salt-hazed glass globe. They exist for the silhouette against the sun, so the profile
// (bail, cap, bulged globe, guard wires, fount) is modelled with care; the rest is shading.

import { BufferGeometry, InstancedMesh, LatheGeometry, Matrix4, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, Vector2 } from 'three/webgpu';
import { float, mix, positionWorld, smoothstep, texture, vec3, vec4, positionGeometry } from 'three/tsl';
import { boardGeometry, mergeGeometries, tubeGeometry } from './geometry';
import { LAMP, type PierPlan } from './plan';
import type { PierTextures } from './textures';

function lathe(profile: number[][], seg = 28, ox = 0, oy = 0, oz = 0): BufferGeometry {
  const g = new LatheGeometry(
    profile.map((p) => new Vector2(p[0], p[1])),
    seg,
  );
  g.translate(ox, oy, oz);
  return g;
}

/** Bracket + lantern metalwork in the lamp's local frame: post top at the origin, arm toward -Z. */
function metalGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const ax = -LAMP.arm;
  const hy = -0.12;
  // Arm and diagonal strut (square iron bar).
  const arm = boardGeometry(0.022, 0.022, LAMP.arm + 0.06, 0.004);
  arm.translate(0, hy, ax / 2 - 0.02);
  parts.push(arm);
  const strut = boardGeometry(0.018, 0.018, 0.42, 0.003);
  strut.rotateX(-Math.atan2(0.3, 0.26));
  strut.translate(0, hy - 0.16, -0.19);
  parts.push(strut);
  // Scroll at the arm tip and the hook.
  const hook: number[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const a = t * Math.PI * 1.3;
    hook.push(0, hy - 0.011 - 0.028 * (1 - Math.cos(a)), ax + 0.028 * Math.sin(a));
  }
  parts.push(tubeGeometry(hook, 0.0045, 6));
  // Lantern, hanging from the hook: origin at the top of the bail.
  const ly = hy - 0.07;
  const bail: number[] = [];
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI;
    bail.push(Math.cos(a) * 0.075, ly - 0.085 + Math.sin(a) * 0.07, ax);
  }
  parts.push(tubeGeometry(bail, 0.0035, 6));
  // Cap: vent chimney, cone, rolled rim.
  parts.push(
    lathe(
      [
        [0.0, 0.0],
        [0.022, 0.0],
        [0.024, -0.004],
        [0.024, -0.03],
        [0.03, -0.034],
        [0.068, -0.068],
        [0.079, -0.074],
        [0.079, -0.08],
        [0.07, -0.082],
      ],
      28,
      0,
      ly - 0.078,
      ax,
    ),
  );
  // Guard wires round the globe.
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const w: number[] = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const r = 0.062 + 0.026 * Math.sin(t * Math.PI);
      w.push(Math.cos(a) * r, ly - 0.16 - t * 0.16, ax + Math.sin(a) * r);
    }
    parts.push(tubeGeometry(w, 0.0028, 5));
  }
  // Fount (fuel tank) with a burner collar.
  parts.push(
    lathe(
      [
        [0.0, 0.0],
        [0.05, 0.0],
        [0.056, -0.006],
        [0.058, -0.012],
        [0.078, -0.03],
        [0.082, -0.05],
        [0.078, -0.07],
        [0.07, -0.078],
        [0.0, -0.078],
      ],
      28,
      0,
      ly - 0.325,
      ax,
    ),
  );
  parts.push(
    lathe(
      [
        [0.0, 0.03],
        [0.016, 0.03],
        [0.02, 0.0],
        [0.0, 0.0],
      ],
      16,
      0,
      ly - 0.325,
      ax,
    ),
  );
  for (const p of parts) {
    if (!p.index) {
      const n = p.attributes.position.count;
      const idx: number[] = [];
      for (let i = 0; i < n; i++) idx.push(i);
      p.setIndex(idx);
    }
  }
  // LatheGeometry has uv; board has aEnd (dropped by the merge).
  return mergeGeometries(parts.map((p) => stripTo3(p)));
}

function stripTo3(g: BufferGeometry) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  if (g.attributes.uv && g.attributes.uv.itemSize !== 2) g.deleteAttribute('uv');
  return g;
}

function glassGeometry(): BufferGeometry {
  const ly = -0.12 - 0.07;
  return lathe(
    [
      [0.03, 0],
      [0.045, -0.02],
      [0.066, -0.07],
      [0.07, -0.1],
      [0.064, -0.13],
      [0.05, -0.155],
      [0.046, -0.162],
    ],
    32,
    0,
    ly - 0.165,
    -LAMP.arm,
  );
}

export interface Lanterns {
  metal: InstancedMesh;
  glass: InstancedMesh;
  dispose(): void;
}

export function createLanterns(plan: PierPlan, tex: PierTextures): Lanterns {
  const n = plan.lamps.length;
  const metalMat = new MeshStandardNodeMaterial();
  const rust = texture(tex.noise, positionWorld.xz.mul(1.7).add(positionWorld.y.mul(2.3))).g;
  const rustM = smoothstep(0.5, 0.72, rust.add(positionGeometry.y.mul(-0.4)));
  metalMat.colorNode = vec4(mix(vec3(0.028, 0.027, 0.026), vec3(0.2, 0.075, 0.03), rustM), 1);
  metalMat.roughnessNode = mix(float(0.42), float(0.9), rustM);
  metalMat.metalnessNode = mix(float(0.35), float(0.0), rustM);

  const glassMat = new MeshPhysicalNodeMaterial({ transparent: true, depthWrite: false });
  const haze = texture(tex.noise, positionWorld.xz.mul(9).add(positionWorld.y.mul(11))).a;
  glassMat.colorNode = vec4(0.62, 0.64, 0.6, 1);
  glassMat.roughnessNode = mix(float(0.06), float(0.4), haze.mul(0.6));
  glassMat.opacityNode = mix(float(0.1), float(0.34), haze.mul(0.7));
  glassMat.metalnessNode = float(0);

  const metal = new InstancedMesh(metalGeometry(), metalMat, n);
  const glass = new InstancedMesh(glassGeometry(), glassMat, n);
  const m = new Matrix4();
  const r = new Matrix4();
  for (let i = 0; i < n; i++) {
    const l = plan.lamps[i];
    // Arm toward the deck's centre line: -Z for the +Z side.
    r.makeRotationY(l.side > 0 ? 0 : Math.PI);
    m.makeTranslation(l.x, LAMP.top, l.z).multiply(r);
    metal.setMatrixAt(i, m);
    glass.setMatrixAt(i, m);
  }
  metal.castShadow = true;
  metal.receiveShadow = true;
  glass.renderOrder = 3;
  return {
    metal,
    glass,
    dispose() {
      metal.geometry.dispose();
      glass.geometry.dispose();
      metal.dispose();
      glass.dispose();
      metalMat.dispose();
      glassMat.dispose();
    },
  };
}
