// Traffic system (B1): a persistent fleet of toy cars, compacts, delivery trucks and buses on A2's
// lanes (sim.ts), drawn as two instanced toon meshes per kind (near and far LOD, ONE program), plus
// the night lights (lights.ts). Wheels spin and the front ones steer, bodies bob, pitch under
// braking and lean in turns (all in the vertex patch, per-instance attributes); tail lights flare
// when braking, indicators blink before turns, a few character variants (taxi, police car,
// ice-cream van) show their roof parts and box trucks carry one of three liveries. The sim runs in
// fixedUpdate and writes the zebra handshake (ctx.services.crossings.blocked); poses are
// interpolated between fixed steps for drawing.
//
// Packing: every frame each vehicle in view (frustum + a shadow margin, out to where it drops
// below the planet's horizon) is written into its kind's near pack (within ~34 m at a 70° FOV,
// scaled by the FOV) and/or far pack (beyond it), so neither pass draws the whole fleet's near
// meshes. Across a 4 m band either side of the switch the two meshes are drawn with
// COMPLEMENTARY dither by fragment distance (each pixel by exactly one of them). Shadows dither
// out over 60–100 m altTerrain.

import { BufferGeometry, DynamicDrawUsage, Frustum, InstancedBufferAttribute, type InstancedMesh, Matrix4, Vector2 } from 'three';
import type { LBContext, System } from '../core/contracts';
import type { ToonPatch } from '../render/toon';
import { ROAD_H } from '../world/config';
import { planFrame, toSphere } from '../world/city/frame';
import type { PathSample } from '../world/city/types';
import { v3, type Vec3 } from '../world/sphere';
import { createFleetLights, type FleetLights } from './lights';
import { bodyColours, buildVehicle, VARIANT_COLOURS } from './mesh';
import { createTrafficSim, FLEET, KINDS, type TrafficSim } from './sim';

/** Sim seconds the fleet has already driven at t = 0, and the most of t replayed exactly on a jump. */
const WARM = 20;
const REPLAY_MAX = 90;
const SEED_LABEL = 0x7aff1c;
/** Near-LOD radius × tan(fov / 2) (m): 34 m at a 70° FOV, further with a narrower one. */
const NEAR_K = 24;
/** Half-width of the near/far dither band (m). */
const BAND = 4;
/** Shadows dither out over this altTerrain band (m), then stop. */
const SH_FROM = 60;
const SH_TO = 100;
/** Character variants by kind and instance slot: [kind, slot, variant] (1 taxi, 2 police, 3 ice-cream van). */
const VARIANTS = [
  [0, 2, 1],
  [0, 13, 1],
  [0, 7, 2],
  [1, 4, 3],
];

const PATCH_VERT_PARS = /* glsl */ `
attribute float aTint;
attribute vec4 aHub;
attribute vec3 aLamp;
attribute vec4 aMotion;
attribute vec3 aState;
attribute float aVar;
varying vec4 vGlow;
varying vec4 vGlass;
varying vec4 vLiv;
varying float vPol;
`;
const PATCH_VERT = /* glsl */ `
{
vec3 q=position;
if(aHub.w>0.5&&aHub.w<2.5){
vec3 o=q-aHub.xyz;
float c=cos(aMotion.x);
float s=sin(aMotion.x);
o=vec3(o.x,c*o.y-s*o.z,s*o.y+c*o.z);
if(aHub.w>1.5){
float cs=cos(aMotion.y);
float sn=sin(aMotion.y);
o=vec3(cs*o.x+sn*o.z,o.y,-sn*o.x+cs*o.z);
}
q=aHub.xyz+o;
}else{
q.y+=aMotion.z+q.z*aState.z+q.x*aMotion.w;
q.x-=(q.y-0.5)*aMotion.w;
if(aHub.w>3.5&&abs(aHub.w-3.0-aVar)>0.5)q=vec3(0.0);
}
#if (defined(LB_REVEAL_INSTANCE) || defined(LB_REVEAL_OBJECT)) && !defined(LB_REVEAL_FADE)
q*=lbSpring(lbP);
#endif
transformed=q;
vLiv=vec4(1.0,1.0,1.0,aTint>1.5?aVar:0.0);
#if defined(USE_COLOR) && defined(USE_INSTANCING_COLOR)
vColor.rgb=color.rgb*mix(vec3(1.0),instanceColor.rgb,aTint>1.5?0.0:max(aTint,0.0));
vLiv.rgb=instanceColor.rgb;
#endif
vGlass=vec4(step(aTint,-0.5),position);
float blink=step(0.45,fract(lbTime*1.5));
float pol=step(2.0,abs(aLamp.z));
vGlow=vec4(aLamp.x,aLamp.y,aLamp.y*aState.x,blink*step(0.5,aLamp.z*aState.y)*(1.0-pol));
vPol=pol*sign(aLamp.z)*step(0.5,fract(lbTime*2.2+0.25*sign(aLamp.z)));
}
`;
// LOD: uLodR = the dither band (fragment distance), uLodM 1 near / 2 far: complementary.
const PATCH_FRAG_PARS = /* glsl */ `
varying vec4 vGlow;
varying vec4 vGlass;
varying vec4 vLiv;
varying float vPol;
uniform vec2 uLodR;
uniform float uLodM;
bool lbTrafficCull(){
float v=1.0-lbSmooth01((distance(vLbWorld,lbCamPos)-uLodR.x)/(uLodR.y-uLodR.x));
float b=lbBayer4(gl_FragCoord.xy);
return uLodM<1.5?v<b:v>=b;
}
`;
// Box-truck liveries on the cargo box sides (and the flower on its back), by aVar: 1 a flower in a
// disc over a base band, 2 a diagonal band with an amber pinstripe, 3 a wave with a darker crest line. The albedo
// change is applied to the lit colour as a ratio (lighting is linear in albedo).
const PATCH_FRAG = /* glsl */ `
if(lbTrafficCull())discard;
{
float lbNt=lbNightAt(vLbWorld);
float u=vGlass.z*1.6+(vGlass.y+vGlass.w)*0.8;
float f=fract(u);
float st=vGlass.x*step(0.5,fract(u*0.5))*(step(0.62,f)*step(f,0.8)+step(0.86,f)*step(f,0.92));
outgoingLight=mix(outgoingLight,vec3(0.72,0.86,1.0),st*0.45*(1.0-lbNt)*(1.0-lbNt));
vec3 p=vGlass.yzw;
float side=step(1.0,abs(p.x));
if(vLiv.w>0.5&&(side>0.5||(p.z<-2.5&&vLiv.w<1.5))){
vec2 q=side>0.5?vec2((p.z+0.75)*sign(p.x),p.y-1.61):vec2(p.x,p.y-1.61);
float aa=max(fwidth(q.x)+fwidth(q.y),1e-3);
vec3 B=vLiv.rgb;
vec3 tgt=vColor.rgb;
float m=vLiv.w;
if(m<1.5||side<0.5){
vec2 c=q-vec2(0.0,0.08);
float d=length(c);
float pr=0.3+0.09*cos(5.0*atan(c.y,c.x));
tgt=mix(tgt,B,1.0-smoothstep(0.58-aa,0.58+aa,d));
tgt=mix(tgt,vec3(0.96,0.94,0.9),(1.0-smoothstep(pr-aa,pr+aa,d))*smoothstep(0.1-aa,0.1+aa,d));
tgt=mix(tgt,B,side*(1.0-smoothstep(-0.78-aa,-0.78+aa,q.y)));
}else if(m<2.5){
float t=q.x*0.62+q.y;
tgt=mix(tgt,B,1.0-smoothstep(0.3-aa,0.3+aa,abs(t+0.05)));
tgt=mix(tgt,vec3(1.0,0.47,0.1),1.0-smoothstep(0.055-aa,0.055+aa,abs(t-0.42)));
}else{
float w=-0.28+0.13*sin(q.x*3.3+0.6);
tgt=mix(tgt,B,smoothstep(w+aa,w-aa,q.y));
tgt=mix(tgt,B*0.55,1.0-smoothstep(0.05-aa,0.05+aa,abs(q.y-w-0.2)));
}
outgoingLight*=tgt/max(vColor.rgb,vec3(0.02));
}
outgoingLight+=vGlow.x*vec3(1.0,0.86,0.58)*(0.1+2.4*lbNt)
+vGlow.y*vec3(1.0,0.1,0.07)*(1.5*lbNt)
+vGlow.z*vec3(1.0,0.12,0.08)*1.6
+vGlow.w*vec3(1.0,0.5,0.08)*2.4
+max(vPol,0.0)*vec3(1.0,0.12,0.1)*2.6
+max(-vPol,0.0)*vec3(0.2,0.4,1.0)*2.6;
}
`;
const PATCH_DEPTH = /* glsl */ `
if(lbTrafficCull()||1.0-lbSmooth01((lbCamAlt-${SH_FROM.toFixed(1)})/${(SH_TO - SH_FROM).toFixed(1)})<lbBayer4(gl_FragCoord.xy))discard;
`;

/** Write a rigid instance matrix (columns: left, up, forward, position) at offset o. */
function basis(m: Float32Array, o: number, l: Vec3, u: Vec3, f: Vec3, x: number, y: number, z: number) {
  m[o] = l.x;
  m[o + 1] = l.y;
  m[o + 2] = l.z;
  m[o + 4] = u.x;
  m[o + 5] = u.y;
  m[o + 6] = u.z;
  m[o + 8] = f.x;
  m[o + 9] = f.y;
  m[o + 10] = f.z;
  m[o + 12] = x;
  m[o + 13] = y;
  m[o + 14] = z;
  m[o + 15] = 1; // the 0 entries stay 0 (instance buffers start zeroed)
}

/** One drawn pack: a kind's near or far mesh and its per-frame instance buffers. */
interface Pack {
  mesh: InstancedMesh;
  mat: Float32Array;
  col: Float32Array;
  mo: Float32Array;
  st: Float32Array;
  rv: Float32Array;
  va: Float32Array;
  attrs: InstancedBufferAttribute[];
  n: number;
}

export function createTrafficSystem(): System {
  let sim: TrafficSim | null = null;
  let lights: FleetLights | null = null;
  /** packs[kind · 2 + lod] */
  const packs: Pack[] = [];
  let steer = new Float64Array(0);
  let pitch = new Float64Array(0);
  let roll = new Float64Array(0);
  /** Static per vehicle: body colour (rgb), variant / livery, reveal delay. */
  let colour = new Float32Array(0);
  let vari = new Float32Array(0);
  let reveal = new Float32Array(0);
  /** Drawn body boxes in plan space (centre, unit forward), for the player's collision. */
  let bx = new Float64Array(0);
  let bz = new Float64Array(0);
  let bux = new Float64Array(0);
  let buz = new Float64Array(0);
  let revealStart = 0;
  let revealDone = false;
  const vp = new Vector2();
  const lodR = { value: new Vector2(30, 38) };
  const frustum = new Frustum();
  const pm = new Matrix4();
  // scratch (zero allocation per frame)
  const F = { up: v3(), ax: v3(), az: v3() };
  const P = v3();
  const fwd = v3();
  const left = v3();
  const ps: PathSample = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };

  /** Replay the fleet from its seeded layout up to ctx.time.t (deterministic: same t, same streets). */
  const replaySteps = (ctx: LBContext) => Math.round((WARM + Math.min(Math.max(ctx.time.t, 0), REPLAY_MAX)) / ctx.time.fixedDt);
  // The last step publishes `blocked`, so people placed after it never step out in front of a car.
  const replayStep = (ctx: LBContext, last: boolean) => {
    const b = ctx.services.crossings.blocked;
    sim!.step(ctx.time.fixedDt, null, last && b.length ? b : null);
  };
  const replay = (ctx: LBContext) => {
    if (!sim) return;
    sim.setObstacle(false, 0, 0);
    sim.reset();
    const n = replaySteps(ctx);
    for (let k = 0; k < n; k++) replayStep(ctx, k === n - 1);
  };

  /** Wheel spin angle and bob of the vehicle being packed. */
  let mo0 = 0;
  let mo2 = 0;
  /** Copy vehicle i's instance data (the pose in left / F.up / fwd / P) into pack p's next slot. */
  function put(p: Pack, i: number) {
    const j = p.n++;
    basis(p.mat, j * 16, left, F.up, fwd, P.x, P.y, P.z);
    p.col[j * 3] = colour[i * 3];
    p.col[j * 3 + 1] = colour[i * 3 + 1];
    p.col[j * 3 + 2] = colour[i * 3 + 2];
    p.mo[j * 4] = mo0;
    p.mo[j * 4 + 1] = steer[i];
    p.mo[j * 4 + 2] = mo2;
    p.mo[j * 4 + 3] = roll[i];
    p.st[j * 3] = sim!.brake[i];
    p.st[j * 3 + 1] = sim!.signal[i];
    p.st[j * 3 + 2] = pitch[i];
    p.rv[j] = reveal[i];
    p.va[j] = vari[i];
  }

  function draw(ctx: LBContext) {
    if (!sim || !lights) return;
    const a = ctx.time.alpha;
    const dt = ctx.time.dt;
    const kS = dt > 0 ? 1 - Math.exp(-dt * 7) : 1;
    const night = ctx.uniforms.lbNight.value;
    const v = ctx.view;
    const beamsOn = v.altTerrain < 260;
    const bm = lights.beams.instanceMatrix.array as Float32Array;
    // LOD radius by screen size; draw out to where a 3 m bus drops below the horizon (+ margin)
    const rn = NEAR_K / Math.tan((v.fov * Math.PI) / 360);
    lodR.value.set(rn - BAND, rn + BAND);
    const farR = v.horizon + 34;
    const cam = ctx.camera;
    frustum.setFromProjectionMatrix(pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const E = v.eye;
    for (let k = 0; k < packs.length; k++) packs[k].n = 0;
    for (let i = 0; i < sim.n; i++) {
      const kind = KINDS[sim.kind[i]];
      const fx = sim.pfx[i] + (sim.fx[i] - sim.pfx[i]) * a;
      const fz = sim.pfz[i] + (sim.fz[i] - sim.pfz[i]) * a;
      const rx = sim.prx[i] + (sim.rx[i] - sim.prx[i]) * a;
      const rz = sim.prz[i] + (sim.rz[i] - sim.prz[i]) * a;
      let dx = fx - rx;
      let dz = fz - rz;
      const dl = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= dl;
      dz /= dl;
      const cx = (fx + rx) / 2;
      const cz = (fz + rz) / 2;
      bx[i] = cx;
      bz[i] = cz;
      bux[i] = dx;
      buz[i] = dz;
      planFrame(cx, cz, F);
      toSphere(cx, cz, ROAD_H, P);
      fwd.x = F.ax.x * dx + F.az.x * dz;
      fwd.y = F.ax.y * dx + F.az.y * dz;
      fwd.z = F.ax.z * dx + F.az.z * dz;
      const fl = Math.sqrt(fwd.x * fwd.x + fwd.y * fwd.y + fwd.z * fwd.z) || 1;
      fwd.x /= fl;
      fwd.y /= fl;
      fwd.z /= fl;
      const U = F.up;
      left.x = U.y * fwd.z - U.z * fwd.y;
      left.y = U.z * fwd.x - U.x * fwd.z;
      left.z = U.x * fwd.y - U.y * fwd.x;
      // steering: the path tangent at the front axle against the body's heading
      sim.pointBack(i, (kind.len - kind.wheelbase) / 2, ps);
      const st = Math.max(-0.55, Math.min(0.55, 1.5 * Math.atan2(dx * ps.tz - dz * ps.tx, dx * ps.tx + dz * ps.tz) * -1));
      steer[i] += (st - steer[i]) * kS;
      const sp = sim.v[i];
      const kappa = (2 * Math.tan(steer[i] / 1.5)) / kind.wheelbase;
      roll[i] += (Math.max(-0.06, Math.min(0.06, sp * sp * kappa * 0.012)) - roll[i]) * kS;
      pitch[i] += (Math.max(-0.05, Math.min(0.03, sim.acc[i] * 0.011)) - pitch[i]) * kS;
      mo0 = sim.odo[i] / kind.wheelR;
      mo2 = 0.012 * Math.min(1, sp / 4) * Math.sin(sim.odo[i] * 1.7 + i * 1.3);
      // packing: in view (with a shadow margin) and above the horizon; near and / or far by distance
      const ex = P.x - E.x;
      const ey = P.y - E.y;
      const ez = P.z - E.z;
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const hl = kind.len / 2;
      if (d < farR && inView(P, hl + 7)) {
        const k = sim.kind[i] * 2;
        if (d < rn + BAND + hl) put(packs[k], i);
        if (d > rn - BAND - hl) put(packs[k + 1], i);
      }
      // night lights: the headlight pool from the bumper, the head / tail sparks
      if (beamsOn) basis(bm, i * 16, left, U, fwd, P.x + fwd.x * hl + U.x * 0.012, P.y + fwd.y * hl + U.y * 0.012, P.z + fwd.z * hl + U.z * 0.012);
      const sp6 = lights.pos;
      const sd = lights.dir;
      const lh = 0.8;
      sp6[i * 6] = P.x + fwd.x * (hl + 0.05) + U.x * lh;
      sp6[i * 6 + 1] = P.y + fwd.y * (hl + 0.05) + U.y * lh;
      sp6[i * 6 + 2] = P.z + fwd.z * (hl + 0.05) + U.z * lh;
      sp6[i * 6 + 3] = P.x - fwd.x * (hl + 0.05) + U.x * (lh + 0.06);
      sp6[i * 6 + 4] = P.y - fwd.y * (hl + 0.05) + U.y * (lh + 0.06);
      sp6[i * 6 + 5] = P.z - fwd.z * (hl + 0.05) + U.z * (lh + 0.06);
      for (let e = 0; e < 2; e++) {
        sd[i * 8 + e * 4] = fwd.x;
        sd[i * 8 + e * 4 + 1] = fwd.y;
        sd[i * 8 + e * 4 + 2] = fwd.z;
        sd[i * 8 + e * 4 + 3] = sim.brake[i];
      }
    }
    // shadows on the high tier only, dithered out over SH_FROM…SH_TO (depth patch), then off
    const cast = ctx.quality === 'high' && v.altTerrain < SH_TO;
    for (let k = 0; k < packs.length; k++) {
      const p = packs[k];
      p.mesh.count = p.n;
      p.mesh.visible = p.n > 0;
      p.mesh.castShadow = cast;
      if (p.n) for (let q = 0; q < p.attrs.length; q++) p.attrs[q].needsUpdate = true;
    }
    lights.beams.visible = beamsOn && night > 0.01;
    if (lights.beams.visible) lights.beams.instanceMatrix.needsUpdate = true;
    lights.posAttr.needsUpdate = true;
    lights.dirAttr.needsUpdate = true;
  }

  /** Sphere (centre c, radius r) against the camera frustum. */
  function inView(c: Vec3, r: number) {
    const pl = frustum.planes;
    for (let k = 0; k < 6; k++) {
      const n = pl[k].normal;
      if (n.x * c.x + n.y * c.y + n.z * c.z + pl[k].constant < -r) return false;
    }
    return true;
  }

  /** The player's collision: push a disc out of every drawn body box (plan space). */
  function collide(x: number, z: number, r: number, out: { x: number; z: number }): boolean {
    if (!sim) return false;
    let moved = false;
    for (let pass = 0; pass < 2; pass++)
      for (let i = 0; i < sim.n; i++) {
        const K = KINDS[sim.kind[i]];
        const hl = K.len / 2;
        const hw = K.width / 2;
        const dx = x - bx[i];
        const dz = z - bz[i];
        const R = hl + hw + r;
        if (dx * dx + dz * dz > R * R) continue;
        const ux = bux[i];
        const uz = buz[i];
        let u = dx * ux + dz * uz;
        let w = dz * ux - dx * uz;
        const cu = Math.max(-hl, Math.min(hl, u));
        const cw = Math.max(-hw, Math.min(hw, w));
        const du = u - cu;
        const dw = w - cw;
        const d2 = du * du + dw * dw;
        if (d2 >= r * r) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          u += (du * (r - d)) / d;
          w += (dw * (r - d)) / d;
        } else if (hl - Math.abs(u) < hw - Math.abs(w)) u = (u < 0 ? -1 : 1) * (hl + r);
        else w = (w < 0 ? -1 : 1) * (hw + r);
        x = bx[i] + u * ux - w * uz;
        z = bz[i] + u * uz + w * ux;
        moved = true;
      }
    out.x = x;
    out.z = z;
    return moved;
  }

  return {
    name: 'traffic',
    stage: 2,
    async init(ctx) {
      const plan = ctx.world.city;
      sim = createTrafficSim(plan, ctx.world.seed ^ SEED_LABEL, FLEET, ctx.world.cityIndex);
      const n = sim.n;
      steer = new Float64Array(n);
      pitch = new Float64Array(n);
      roll = new Float64Array(n);
      colour = new Float32Array(n * 3);
      vari = new Float32Array(n);
      reveal = new Float32Array(n).fill(1e6);
      bx = new Float64Array(n);
      bz = new Float64Array(n);
      bux = new Float64Array(n);
      buz = new Float64Array(n);
      // the fleet has been driving for a while: replay in slices (the first frame is already up)
      sim.reset();
      const steps = replaySteps(ctx);
      for (let k = 0; k < steps; k++) {
        replayStep(ctx, k === steps - 1);
        if (k % 50 === 49) await ctx.yield();
      }

      // body colours by kind slot; character variants; box-truck liveries (1 circle, 2 band, 3 wave)
      const count = new Int32Array(KINDS.length);
      for (let i = 0; i < n; i++) {
        const k = sim.kind[i];
        const j = count[k]++;
        const cols = bodyColours(KINDS[k].name);
        let c = cols[(j * 7 + k * 3) % cols.length];
        if (KINDS[k].name === 'truck') vari[i] = 1 + (j % 3);
        for (const [vk, vj, vv] of VARIANTS)
          if (vk === k && vj === j) {
            vari[i] = vv;
            c = VARIANT_COLOURS[vv]!;
          }
        colour[i * 3] = c.r;
        colour[i * 3 + 1] = c.g;
        colour[i * 3 + 2] = c.b;
      }

      const opts = { vertexColors: true, reveal: 'instance', revealDuration: 0.55, rim: 0.42 } as const;
      const patch = (m: number): ToonPatch => ({
        key: 'traffic',
        vertexPars: PATCH_VERT_PARS,
        vertex: PATCH_VERT,
        fragmentPars: PATCH_FRAG_PARS,
        fragment: PATCH_FRAG,
        depthFragment: PATCH_DEPTH,
        uniforms: { uLodR: lodR, uLodM: { value: m } },
      });
      const mats = [ctx.toon.material({ name: 'traffic', patch: patch(1), ...opts }), ctx.toon.material({ name: 'traffic:far', patch: patch(2), ...opts })];
      for (let k = 0; k < KINDS.length; k++) {
        const cnt = Math.max(1, count[k]);
        for (let lod = 0; lod < 2; lod++) {
          const geo = ctx.track(buildVehicle(KINDS[k], lod > 0) as BufferGeometry);
          const dyn = (size: number) => new InstancedBufferAttribute(new Float32Array(cnt * size), size).setUsage(DynamicDrawUsage);
          const mo = dyn(4);
          const st = dyn(3);
          const rv = dyn(1);
          const va = dyn(1);
          geo.setAttribute('aMotion', mo);
          geo.setAttribute('aState', st);
          geo.setAttribute('aReveal', rv);
          geo.setAttribute('aVar', va);
          const mesh = ctx.toon.instanced(geo, mats[lod], cnt, { cast: true, receive: true });
          mesh.name = `traffic:${KINDS[k].name}${lod ? ':far' : ''}`;
          mesh.instanceMatrix.setUsage(DynamicDrawUsage);
          mesh.instanceColor = dyn(3);
          mesh.frustumCulled = false; // packed per frame (view + horizon)
          mesh.count = 0;
          const attrs = [mesh.instanceMatrix, mesh.instanceColor, mo, st, rv, va] as InstancedBufferAttribute[];
          packs.push({ mesh, mat: mesh.instanceMatrix.array as Float32Array, col: mesh.instanceColor.array as Float32Array, mo: mo.array as Float32Array, st: st.array as Float32Array, rv: rv.array as Float32Array, va: va.array as Float32Array, attrs, n: 0 });
        }
        await ctx.yield();
      }
      lights = createFleetLights(ctx, n);
      draw(ctx);
      // warm every program (colour + shadow) with something drawn in each pack
      for (const p of packs) {
        p.mesh.count = 1;
        p.mesh.visible = true;
        p.mesh.castShadow = true;
      }
      ctx.scene.add(...packs.map((p) => p.mesh), lights.beams, lights.sparks);
      await ctx.compile();

      // reveal: the fleet pops onto the streets one after another, centre outward
      const start = ctx.reveal.slot(1.6);
      revealStart = start;
      const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => Math.hypot(sim!.fx[p], sim!.fz[p]) - Math.hypot(sim!.fx[q], sim!.fz[q]));
      order.forEach((i, r) => (reveal[i] = start + (r / n) * 1.1));
      const r0 = ctx.reveal.instant ? 1 : 0;
      lights.beamMat.uniforms.uReveal.value = r0;
      lights.sparkMat.uniforms.uReveal.value = r0;
      revealDone = ctx.reveal.instant;
      ctx.services.traffic = { collide };
    },
    fixedUpdate(ctx) {
      if (!sim) return;
      const c = ctx.services.crossings;
      const v = ctx.view;
      // the player in the street (walking, or the top of a 3 m jump) is an obstacle: vehicles stop
      // short of the eye instead of driving through it
      sim.setObstacle(v.altTerrain < 4 && v.cityDist < ctx.world.city.radius + 10, v.cityX, v.cityZ);
      sim.step(ctx.time.fixedDt, c.busy.length ? c.busy : null, c.blocked.length ? c.blocked : null);
    },
    update(ctx) {
      if (!sim || !lights) return;
      if (!revealDone) {
        const p = ctx.reveal.progress(revealStart + 0.8, 1.0);
        lights.beamMat.uniforms.uReveal.value = p;
        lights.sparkMat.uniforms.uReveal.value = p;
        revealDone = p >= 1;
      }
      ctx.renderer.getDrawingBufferSize(vp);
      (lights.sparkMat.uniforms.uViewport.value as Vector2).copy(vp);
      draw(ctx);
    },
    onTimeJump(ctx) {
      replay(ctx);
      steer.fill(0);
      pitch.fill(0);
      roll.fill(0);
    },
    dispose(ctx) {
      if (ctx.services.traffic?.collide === collide) delete ctx.services.traffic;
      sim = null;
      lights = null;
      packs.length = 0;
    },
  };
}
