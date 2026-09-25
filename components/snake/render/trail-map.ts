import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  Color,
  CustomBlending,
  DynamicDrawUsage,
  HalfFloatType,
  LinearFilter,
  MaxEquation,
  Mesh,
  OneFactor,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import {
  RIBBON_HALF,
  TRAIL_HALF_EXTENT,
  TRAIL_HOLD,
  TRAIL_LIFE,
  TRAIL_MAX_POINTS,
  TRAIL_MIN_STEP,
} from './trail-constants';

// The ribbon is drawn straight into clip space: x → x, z → y, so texel (u, v) maps to world
// (x, z) = ((u - 0.5), (v - 0.5)) × 2 × TRAIL_HALF_EXTENT — the same mapping the sand shader uses.
const VERT = /* glsl */ `
attribute vec2 aPerp;
attribute float aSide;
attribute float aBirth;
uniform float uClock;
uniform float uHalfExtent;
uniform float uHold;
uniform float uLife;
uniform float uRibbonHalf;
varying float vAcross;
varying float vShape;
float shapeOf(float age) {
  if (age <= uHold) return 1.0;
  float t = clamp((age - uHold) / (uLife - uHold), 0.0, 1.0);
  return 1.0 - t * t * (3.0 - 2.0 * t);
}
void main() {
  float s = shapeOf(uClock - aBirth);
  vShape = s;
  vAcross = aSide;
  vec2 p = position.xz + aPerp * aSide * uRibbonHalf * s;
  gl_Position = vec4(p / uHalfExtent, 0.0, 1.0);
}
`;

// R = groove depth, G = rim height, B = freshness. Max blending keeps overlapping passes sane.
const FRAG = /* glsl */ `
varying float vAcross;
varying float vShape;
void main() {
  float u = abs(vAcross);
  float core = max(0.0, 1.0 - (u / 0.5) * (u / 0.5));
  float groove = pow(core, 0.8);
  float rim = smoothstep(0.35, 0.55, u) * (1.0 - smoothstep(0.62, 1.0, u));
  float depth = pow(vShape, 0.6);
  gl_FragColor = vec4(groove * depth, rim * depth, vShape * (1.0 - u), 1.0);
}
`;

type Point = { x: number; z: number; birth: number };

export class TrailMap {
  readonly texel: number;
  private readonly target: WebGLRenderTarget;
  private readonly points: Point[] = [];
  private readonly scene = new Scene();
  private readonly camera = new Camera();
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly position: BufferAttribute;
  private readonly perp: BufferAttribute;
  private readonly side: BufferAttribute;
  private readonly birth: BufferAttribute;
  private readonly clearColor = new Color();

  constructor(resolution: number) {
    this.target = new WebGLRenderTarget(resolution, resolution, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    this.texel = (2 * TRAIL_HALF_EXTENT) / resolution;
    const verts = TRAIL_MAX_POINTS * 2;
    this.position = new BufferAttribute(new Float32Array(verts * 3), 3).setUsage(DynamicDrawUsage);
    this.perp = new BufferAttribute(new Float32Array(verts * 2), 2).setUsage(DynamicDrawUsage);
    this.side = new BufferAttribute(new Float32Array(verts), 1);
    this.birth = new BufferAttribute(new Float32Array(verts), 1).setUsage(DynamicDrawUsage);
    for (let v = 0; v < verts; v++) this.side.setX(v, v % 2 === 0 ? -1 : 1);
    const index = new Uint32Array((TRAIL_MAX_POINTS - 1) * 6);
    for (let i = 0; i < TRAIL_MAX_POINTS - 1; i++) {
      const a = i * 2;
      index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('aPerp', this.perp);
    this.geometry.setAttribute('aSide', this.side);
    this.geometry.setAttribute('aBirth', this.birth);
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uClock: { value: 0 },
        uHalfExtent: { value: TRAIL_HALF_EXTENT },
        uHold: { value: TRAIL_HOLD },
        uLife: { value: TRAIL_LIFE },
        uRibbonHalf: { value: RIBBON_HALF },
      },
      blending: CustomBlending,
      blendEquation: MaxEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const mesh = new Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  get texture() {
    return this.target.texture;
  }

  push(x: number, z: number, clock: number): void {
    const last = this.points[this.points.length - 1];
    if (last && (last.x - x) ** 2 + (last.z - z) ** 2 < TRAIL_MIN_STEP * TRAIL_MIN_STEP) return;
    this.points.push({ x, z, birth: clock });
    if (this.points.length > TRAIL_MAX_POINTS) this.points.shift();
  }

  clear(): void {
    this.points.length = 0;
  }

  render(renderer: WebGLRenderer, clock: number): void {
    let expired = 0;
    while (expired < this.points.length && clock - this.points[expired].birth >= TRAIL_LIFE) expired++;
    if (expired > 0) this.points.splice(0, expired);
    this.rebuild();
    this.material.uniforms.uClock.value = clock;

    const previous = renderer.getRenderTarget();
    renderer.getClearColor(this.clearColor);
    const previousAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    if (this.points.length > 1) renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
    renderer.setClearColor(this.clearColor, previousAlpha);
  }

  dispose(): void {
    this.target.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }

  private rebuild(): void {
    const pts = this.points;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let tx = b.x - a.x;
      let tz = b.z - a.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      for (let s = 0; s < 2; s++) {
        const v = i * 2 + s;
        this.position.setXYZ(v, pts[i].x, 0, pts[i].z);
        this.perp.setXY(v, -tz, tx);
        this.birth.setX(v, pts[i].birth);
      }
    }
    this.position.needsUpdate = true;
    this.perp.needsUpdate = true;
    this.birth.needsUpdate = true;
    this.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
  }
}
