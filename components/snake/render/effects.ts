import { Color, PointLight, type Vector3 } from 'three';
import type { FoodKind, Vec2 } from '../engine/types';
import type { ParticlePool } from './particles';
import { groundHeight } from './terrain-shape';

const WIND = { x: 0.82, z: 0.57 };
const SPARK_NORMAL = new Color(2.4, 0.55, 0.95);
const SPARK_GOLDEN = new Color(2.6, 1.8, 0.5);

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Effects {
  readonly flash = new PointLight(0xffffff, 0, 7, 2);
  private flashLevel = 0;
  private sprayCarry = 0;
  private wispCarry = 0;
  private budget = 1;
  private reduced = false;
  private readonly dust = new Color('#e9c28f');

  constructor(private readonly sand: ParticlePool, private readonly sparks: ParticlePool) {}

  setDust(color: Color): void {
    this.dust.copy(color);
  }

  setBudget(budget: number): void {
    this.budget = budget;
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on;
  }

  spray(head: Vec2, heading: number, speed: number, dt: number): void {
    if (this.reduced) return;
    this.sprayCarry += 34 * (speed / 5) * this.budget * dt;
    const bx = -Math.cos(heading);
    const bz = -Math.sin(heading);
    const gy = groundHeight(head.x, head.z);
    while (this.sprayCarry >= 1) {
      this.sprayCarry -= 1;
      const side = rnd(-1, 1);
      this.sand.emit({
        x: head.x + bx * 0.35,
        y: gy + 0.05,
        z: head.z + bz * 0.35,
        vx: bx * rnd(0.5, 1.5) - bz * side,
        vy: rnd(0.8, 1.8),
        vz: bz * rnd(0.5, 1.5) + bx * side,
        life: rnd(0.5, 0.9),
        size: rnd(0.12, 0.22),
        alpha: 0.55,
        color: this.dust,
        gravity: 6,
        drag: 1.2,
      });
    }
  }

  eatBurst(pos: Vector3, kind: FoodKind): void {
    const scale = this.budget * (this.reduced ? 0.4 : 1);
    const gy = groundHeight(pos.x, pos.z);
    for (let i = 0; i < Math.round(36 * scale); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(1.5, 4);
      this.sand.emit({
        x: pos.x,
        y: gy + 0.1,
        z: pos.z,
        vx: Math.cos(a) * sp,
        vy: rnd(1.5, 3.5),
        vz: Math.sin(a) * sp,
        life: rnd(0.6, 1.1),
        size: rnd(0.14, 0.3),
        alpha: 0.7,
        color: this.dust,
        gravity: 7,
        drag: 1.5,
      });
    }
    const spark = kind === 'golden' ? SPARK_GOLDEN : SPARK_NORMAL;
    for (let i = 0; i < Math.round((kind === 'golden' ? 28 : 14) * scale); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(1, 3);
      this.sparks.emit({
        x: pos.x,
        y: pos.y,
        z: pos.z,
        vx: Math.cos(a) * sp,
        vy: rnd(0.5, 2.5),
        vz: Math.sin(a) * sp,
        life: rnd(0.4, 0.8),
        size: rnd(0.06, 0.12),
        alpha: 1,
        color: spark,
        gravity: 2,
        drag: 2,
      });
    }
    this.flash.color.set(kind === 'golden' ? '#ffc043' : '#ff4a6e');
    this.flash.position.copy(pos);
    this.flashLevel = kind === 'golden' ? 22 : 14;
  }

  puff(pos: Vector3): void {
    for (let i = 0; i < Math.round(14 * this.budget); i++) {
      const a = Math.random() * Math.PI * 2;
      this.sand.emit({
        x: pos.x,
        y: pos.y,
        z: pos.z,
        vx: Math.cos(a) * rnd(0.3, 1),
        vy: rnd(0.2, 0.8),
        vz: Math.sin(a) * rnd(0.3, 1),
        life: rnd(0.6, 1),
        size: rnd(0.2, 0.35),
        alpha: 0.45,
        grow: 0.8,
        color: this.dust,
        drag: 2,
      });
    }
  }

  deathDust(points: Vec2[]): void {
    const scale = this.budget * (this.reduced ? 0.5 : 1);
    for (let i = 0; i < points.length; i += 3) {
      const p = points[i];
      const gy = groundHeight(p.x, p.z);
      for (let j = 0; j < Math.max(1, Math.round(3 * scale)); j++) {
        this.sand.emit({
          x: p.x + rnd(-0.2, 0.2),
          y: gy + 0.15,
          z: p.z + rnd(-0.2, 0.2),
          vx: rnd(-0.6, 0.6),
          vy: rnd(0.3, 1.1),
          vz: rnd(-0.6, 0.6),
          life: rnd(1.4, 2.2),
          size: rnd(0.5, 1.0),
          alpha: 0.5,
          grow: 1.2,
          color: this.dust,
          gravity: -0.3,
          drag: 1.5,
        });
      }
    }
  }

  wisps(dt: number, focus: Vec2): void {
    if (this.reduced) return;
    this.wispCarry += 10 * this.budget * dt;
    while (this.wispCarry >= 1) {
      this.wispCarry -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 24;
      const x = focus.x + Math.cos(a) * r;
      const z = focus.z + Math.sin(a) * r;
      const sp = rnd(2.2, 3.6);
      this.sand.emit({
        x,
        y: groundHeight(x, z) + rnd(0.2, 1.4),
        z,
        vx: WIND.x * sp,
        vy: 0.1,
        vz: WIND.z * sp,
        life: rnd(3.5, 6),
        size: rnd(0.5, 1.1),
        alpha: rnd(0.1, 0.2),
        grow: 0.6,
        color: this.dust,
      });
    }
  }

  update(dt: number): void {
    this.flashLevel *= Math.exp(-dt * 9);
    this.flash.intensity = this.flashLevel < 0.05 ? 0 : this.flashLevel;
    this.sand.update(dt);
    this.sparks.update(dt);
  }

  clear(): void {
    this.flashLevel = 0;
    this.flash.intensity = 0;
    this.sand.clear();
    this.sparks.clear();
  }
}
