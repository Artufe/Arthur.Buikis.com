import {
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import type { Food } from '../engine/types';
import { groundHeight } from './terrain-shape';

export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

function contactShadowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.3)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

type Item = { food: Food; group: Group; fruit: Mesh; ring: Mesh | null; shadow: Mesh; born: number };

export class FoodView {
  readonly group = new Group();
  private readonly items = new Map<number, Item>();
  private readonly normalLight = new PointLight('#ff4a6e', 0, 4.5, 2);
  private readonly goldenLight = new PointLight('#ffb52e', 0, 5.5, 2);
  private readonly fruitGeo = new SphereGeometry(0.34, 32, 24).scale(1, 1.15, 1);
  private readonly crownGeo = new CylinderGeometry(0.09, 0.12, 0.07, 12);
  private readonly gemGeo = new OctahedronGeometry(0.42, 0).scale(1, 1.3, 1);
  private readonly ringGeo = new TorusGeometry(0.62, 0.025, 8, 72);
  private readonly shadowGeo = new PlaneGeometry(1.25, 1.25).rotateX(-Math.PI / 2);
  private readonly normalMat = new MeshPhysicalMaterial({
    color: '#c71f4f',
    emissive: '#ff2f5f',
    emissiveIntensity: 0.9,
    roughness: 0.42,
    clearcoat: 0.7,
    clearcoatRoughness: 0.25,
    sheen: 0.4,
    sheenColor: new Color('#ff9fb4'),
  });
  private readonly goldenMat = new MeshPhysicalMaterial({
    color: '#ff9a10',
    metalness: 0,
    roughness: 0.15,
    emissive: '#ff7a00',
    emissiveIntensity: 2.4,
    clearcoat: 1,
    flatShading: true,
  });
  private readonly crownMat = new MeshStandardMaterial({ color: '#6b8f3a', roughness: 0.8 });
  private readonly ringMat = new MeshBasicMaterial({ color: new Color(3.4, 2.1, 0.35) });
  private readonly shadowTex = contactShadowTexture();
  private readonly shadowMat = new MeshBasicMaterial({
    color: 0x000000,
    alphaMap: this.shadowTex,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  private glow = 1;
  private reduced = false;

  constructor() {
    this.group.add(this.normalLight, this.goldenLight);
  }

  sync(food: Food[], engineTime: number, clock: number): void {
    const live = new Set<number>();
    for (const f of food) {
      live.add(f.id);
      const item = this.items.get(f.id) ?? this.create(f, clock);
      item.food = f;
    }
    for (const [id, item] of this.items) {
      if (!live.has(id)) {
        this.group.remove(item.group, item.shadow);
        this.items.delete(id);
      }
    }

    let normalLit = false;
    let goldenLit = false;
    for (const item of this.items.values()) {
      const f = item.food;
      const gy = groundHeight(f.pos.x, f.pos.z);
      const appear = this.reduced ? 1 : easeOutBack(Math.min(1, (clock - item.born) / 0.4));
      const bob = this.reduced ? 0 : Math.sin(clock * 2.4 + f.id) * 0.12;
      item.group.position.set(f.pos.x, gy + 0.55 + bob, f.pos.z);
      item.group.scale.setScalar(Math.max(0.001, appear));
      item.fruit.rotation.y = this.reduced ? 0 : clock * 0.9;
      if (item.ring) item.ring.rotation.set(Math.PI / 2 + Math.sin(clock) * 0.3, 0, clock * 1.2);
      const blinking = f.expiresAt !== null && f.expiresAt - engineTime < 1.5;
      const visible = !blinking || Math.floor(clock * (this.reduced ? 3 : 8)) % 2 === 0;
      item.group.visible = visible;
      item.shadow.position.set(f.pos.x, gy + 0.03, f.pos.z);
      item.shadow.scale.setScalar(Math.max(0.001, appear * (1 - bob)));

      const golden = f.kind === 'golden';
      const light = golden ? this.goldenLight : this.normalLight;
      light.position.set(f.pos.x, gy + 0.9, f.pos.z);
      light.intensity =
        (golden ? 5 : 3.5) * this.glow * appear * (visible ? 1 : 0.3) * (0.85 + 0.15 * Math.sin(clock * 3 + f.id));
      if (golden) goldenLit = true;
      else normalLit = true;
    }
    if (!normalLit) this.normalLight.intensity = 0;
    if (!goldenLit) this.goldenLight.intensity = 0;
  }

  setGlow(glow: number): void {
    this.glow = glow;
    this.normalMat.emissiveIntensity = 0.9 * glow;
    this.goldenMat.emissiveIntensity = 2.4 * glow;
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on;
  }

  clear(): void {
    for (const item of this.items.values()) this.group.remove(item.group, item.shadow);
    this.items.clear();
  }

  dispose(): void {
    this.clear();
    for (const d of [
      this.fruitGeo,
      this.crownGeo,
      this.gemGeo,
      this.ringGeo,
      this.shadowGeo,
      this.normalMat,
      this.goldenMat,
      this.crownMat,
      this.ringMat,
      this.shadowTex,
      this.shadowMat,
    ]) {
      d.dispose();
    }
  }

  private create(f: Food, clock: number): Item {
    const group = new Group();
    const golden = f.kind === 'golden';
    // The golden prize is a faceted gem; the normal food is a fruit with a leafy crown.
    const fruit = new Mesh(golden ? this.gemGeo : this.fruitGeo, golden ? this.goldenMat : this.normalMat);
    if (!golden) {
      const crown = new Mesh(this.crownGeo, this.crownMat);
      crown.position.y = 0.4;
      fruit.add(crown);
    }
    group.add(fruit);
    let ring: Mesh | null = null;
    if (f.kind === 'golden') {
      ring = new Mesh(this.ringGeo, this.ringMat);
      group.add(ring);
    }
    const shadow = new Mesh(this.shadowGeo, this.shadowMat);
    this.group.add(group, shadow);
    const item: Item = { food: f, group, fruit, ring, shadow, born: clock };
    this.items.set(f.id, item);
    return item;
  }
}
