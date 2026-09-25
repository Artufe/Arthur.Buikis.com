import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  NormalBlending,
  Points,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';

export type ParticleSpec = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
  alpha: number;
  color: Color;
  grow?: number; // size multiplier gained over the lifetime
  gravity?: number;
  drag?: number;
};

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  vAlpha = aAlpha;
  vColor = aColor;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uTint;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  gl_FragColor = vec4(vColor * uTint, smoothstep(0.5, 0.0, d) * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class ParticlePool {
  readonly points: Points;
  private count = 0;
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly grow: Float32Array;
  private readonly baseAlpha: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;

  constructor(private readonly capacity: number, additive = false) {
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.baseAlpha = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.geometry.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('aColor', new BufferAttribute(this.col, 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('aSize', new BufferAttribute(this.size, 1).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1).setUsage(DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uScale: { value: 400 }, uTint: { value: new Color(1, 1, 1) } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  emit(p: ParticleSpec): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([p.vx, p.vy, p.vz], i * 3);
    this.col.set([p.color.r, p.color.g, p.color.b], i * 3);
    this.life[i] = 0;
    this.maxLife[i] = p.life;
    this.baseSize[i] = p.size;
    this.size[i] = 0;
    this.grow[i] = p.grow ?? 0;
    this.baseAlpha[i] = p.alpha;
    this.alpha[i] = 0;
    this.gravity[i] = p.gravity ?? 0;
    this.drag[i] = p.drag ?? 0;
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        this.moveLastInto(i);
        continue;
      }
      const k = i * 3;
      const damp = Math.exp(-this.drag[i] * dt);
      this.vel[k] *= damp;
      this.vel[k + 1] = (this.vel[k + 1] - this.gravity[i] * dt) * damp;
      this.vel[k + 2] *= damp;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.size[i] = this.baseSize[i] * (1 + this.grow[i] * t);
      this.alpha[i] = this.baseAlpha[i] * Math.min(1, t * 6) * (1 - t) ** 1.5;
      i++;
    }
    for (const name of ['position', 'aColor', 'aSize', 'aAlpha']) this.geometry.getAttribute(name).needsUpdate = true;
    this.geometry.setDrawRange(0, this.count);
  }

  /** `pixelHeight` is the drawing-buffer height; sizes are then in world units. */
  setScale(pixelHeight: number, fovDeg: number): void {
    this.material.uniforms.uScale.value = pixelHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  setTint(color: Color): void {
    this.material.uniforms.uTint.value.copy(color);
  }

  clear(): void {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private moveLastInto(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.col.copyWithin(i * 3, last * 3, last * 3 + 3);
    for (const a of [this.size, this.alpha, this.life, this.maxLife, this.baseSize, this.grow, this.baseAlpha, this.gravity, this.drag]) {
      a[i] = a[last];
    }
  }
}
