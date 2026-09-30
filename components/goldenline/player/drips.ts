// Water shed by the body: drips off the fingertips on each stroke's recovery, a flick of
// droplets where the hand enters, and runs off the elbows. A tiny pooled CPU particle set drawn
// as one instanced mesh of streak-stretched droplets. Zero allocation per frame.

import { InstancedMesh, Matrix4, MeshPhysicalNodeMaterial, Quaternion, SphereGeometry, Vector3 } from 'three/webgpu';
import { color, float } from 'three/tsl';
import { mulberry32 } from './tex';

const N = 160;
const G = 9.81;

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _v = new Vector3();
const _up = new Vector3(0, 1, 0);
const ZERO = new Matrix4().makeScale(0, 0, 0);

export class Drips {
  readonly mesh: InstancedMesh;
  private readonly pos = new Float32Array(N * 3);
  private readonly vel = new Float32Array(N * 3);
  private readonly life = new Float32Array(N);
  private readonly size = new Float32Array(N);
  private head = 0;
  private readonly rnd = mulberry32(3);
  private readonly geo: SphereGeometry;
  private readonly mat: MeshPhysicalNodeMaterial;

  constructor() {
    this.geo = new SphereGeometry(1, 10, 8);
    // Clear water: almost no diffuse, a glassy clearcoat that catches the sun and sky.
    const m = new MeshPhysicalNodeMaterial();
    m.colorNode = color(0.02, 0.035, 0.04);
    m.roughnessNode = float(0.04);
    m.metalnessNode = float(0);
    m.clearcoatNode = float(1);
    m.clearcoatRoughnessNode = float(0.02);
    m.specularIntensityNode = float(1);
    this.mat = m;
    this.mesh = new InstancedMesh(this.geo, m, N);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    for (let i = 0; i < N; i++) this.mesh.setMatrixAt(i, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Emit one droplet at p with velocity v (world), radius in metres. */
  emit(px: number, py: number, pz: number, vx: number, vy: number, vz: number, r: number) {
    const i = this.head;
    this.head = (this.head + 1) % N;
    this.pos[i * 3] = px;
    this.pos[i * 3 + 1] = py;
    this.pos[i * 3 + 2] = pz;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = 0.9 + this.rnd() * 0.6;
    this.size[i] = r;
  }

  /** A few droplets with a random spread around (vx, vy, vz). */
  burst(p: Vector3, vx: number, vy: number, vz: number, n: number, spread: number, r: number) {
    for (let k = 0; k < n; k++) {
      const a = this.rnd() * Math.PI * 2;
      const s = spread * (0.3 + this.rnd());
      this.emit(p.x, p.y, p.z, vx + Math.cos(a) * s, vy + this.rnd() * spread, vz + Math.sin(a) * s, r * (0.5 + this.rnd()));
    }
  }

  get random() {
    return this.rnd;
  }

  /** Step and upload. `water(x, z)` gives the surface height; droplets die when they reach it. */
  update(dt: number, water: (x: number, z: number) => number) {
    if (dt <= 0) return;
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const b = i * 3;
      this.vel[b + 1] -= G * dt;
      // A little air drag so the streaks don't read as bullets.
      const k = 1 - Math.min(1, 0.6 * dt);
      this.vel[b] *= k;
      this.vel[b + 2] *= k;
      this.pos[b] += this.vel[b] * dt;
      this.pos[b + 1] += this.vel[b + 1] * dt;
      this.pos[b + 2] += this.vel[b + 2] * dt;
      if (this.life[i] <= 0 || this.pos[b + 1] < water(this.pos[b], this.pos[b + 2])) {
        this.life[i] = 0;
        this.mesh.setMatrixAt(i, ZERO);
        continue;
      }
      _v.set(this.vel[b], this.vel[b + 1], this.vel[b + 2]);
      const sp = _v.length();
      if (sp > 1e-4) _q.setFromUnitVectors(_up, _v.divideScalar(sp));
      else _q.identity();
      const r = this.size[i];
      // Stretch along the motion, about one frame's travel (a camera-shutter streak).
      _s.set(r, r + sp * 0.004, r);
      _p.set(this.pos[b], this.pos[b + 1], this.pos[b + 2]);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}
