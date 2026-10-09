// Transit system (v2 V1): the region's traffic. A persistent fleet of the capital's cars, compacts,
// delivery trucks and buses on R1's roads (sim.ts on the graph of net.ts, routes.ts the who-goes-where:
// Far Haven busy, the harbour towns lively, a car or two in the villages, bus lines between the towns
// stopping by their squares), and the three ferries on their crossings (ferry.ts). Drawn exactly as the
// capital's fleet: the same meshes and the same vehicle patch (traffic/index.ts: one program; the ferry
// is built from the same parts, so it shares it too), near and far LOD per kind packed by view every
// frame (frustum + horizon, the dither band), shadows from the near meshes only, the night lights of
// traffic/lights.ts. Every vehicle and ferry is a Trackable (track.ts).
//
// The sim runs in fixedUpdate: crossings `busy` (the townsfolk's) in, `blocked` out (TransitService,
// installed first thing in init so the townsfolk find the crossings). It has been driving since well
// before t = 0 (WARM s) and a time jump replays it exactly (up to REPLAY_MAX s, the capital's rule);
// the ferries keep a closed-form timetable, so they land exactly wherever t goes. Reduced motion: no
// body bob or lean, no swell under the ferries (they all still drive and sail).

import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Float32BufferAttribute, Frustum, InstancedBufferAttribute, type InstancedMesh, Matrix4, Vector2 } from 'three';
import type { LBContext, System, TrackPose, TransitService } from '../core/contracts';
import { PALETTE } from '../render/palette';
import { ASPH, groundOf } from '../roads/ground';
import { meshHeight } from '../roads/mesh';
import { terrainData } from '../terrain/data';
import { basis, vehiclePatch } from '../traffic';
import { createFleetLights, type FleetLights } from '../traffic/lights';
import { bodyColours, buildVehicle, VARIANT_COLOURS, VehicleBuilder } from '../traffic/mesh';
import { KINDS } from '../traffic/sim';
import { v3, type Vec3 } from '../world/sphere';
import { townCrossings } from './crossings';
import { buildFerry, FERRY_BEAM, FERRY_HEIGHT, FERRY_LEN, ferryFleet, WAKE, type FerryState, type FerryTrack } from './ferry';
import { buildNetSliced } from './net';
import { buildRoutes } from './routes';
import { createTransitSim, type TransitSim } from './sim';
import { busSub, colourSlot, ferryCard, ferryDetail, fleetCards, fleetDetail } from './track';

/** Sim seconds the fleet has driven at t = 0, and the most of t replayed exactly on a jump (traffic/). */
const WARM = 40;
const REPLAY_MAX = 90;
const SEED_LABEL = 0x7a2517;
/** Near-LOD radius × tan(fov / 2), the dither band, the shadow fade (traffic/index.ts). */
const NEAR_K = 24;
const BAND = 4;
const SH_TO = 100;
/** How far under its design height the drawn road may dip (roads/ground.ts SLACK). */
const SLACK = 0.02;
/** A bus's open doors: the variant shown while they are (its parts' aHub.w = 3 + 4). */
const DOORS = 4;
/** Character variants by kind and slot: [kind, slot, variant] (1 taxi, 3 ice-cream van). */
const VARIANTS = [
  [0, 5, 1],
  [0, 17, 1],
  [1, 3, 3],
];
const FERRY_COLOURS = [PALETTE.accent, PALETTE.roofs[0], PALETTE.walls[3]];

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

/** Merge two indexed geometries with the same attributes (the bus and its open doors). */
function merge(a: BufferGeometry, b: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry();
  for (const name of Object.keys(a.attributes)) {
    const x = a.getAttribute(name);
    const y = b.getAttribute(name);
    const arr = new Float32Array(x.array.length + y.array.length);
    arr.set(x.array as Float32Array);
    arr.set(y.array as Float32Array, x.array.length);
    out.setAttribute(name, new Float32BufferAttribute(arr, x.itemSize));
  }
  const n = a.getAttribute('position').count;
  const ia = a.getIndex()!.array;
  const ib = b.getIndex()!.array;
  const idx = new Uint32Array(ia.length + ib.length);
  idx.set(ia);
  for (let k = 0; k < ib.length; k++) idx[ia.length + k] = ib[k] + n;
  out.setIndex(new BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  a.dispose();
  b.dispose();
  return out;
}

/** The bus with its doors (the right-hand side's front pair, +x is left) drawn open as variant DOORS. */
function buildBus(lo: boolean): BufferGeometry {
  const K = KINDS[3];
  const d = new VehicleBuilder(lo).variant(DOORS, (b) => {
    b.box(-1.205, 1.38, 3.0, 0.03, 1.6, 0.96, 0, new Color('#2a2438'));
    b.box(-1.25, 0.42, 3.0, 0.12, 0.08, 0.9, 0.02, new Color('#c4c7d6'));
  });
  return merge(buildVehicle(K, lo), d.geometry());
}

export function createTransitSystem(): System {
  let sim: TransitSim | null = null;
  let lights: FleetLights | null = null;
  let service: TransitService | null = null;
  let shown = true;
  let unsub: (() => void) | null = null;
  const packs: Pack[] = [];
  let ferryPack: Pack | null = null;
  const tracks: FerryTrack[] = [];
  const fst: FerryState[] = [];
  const phase: number[] = [];
  let steer = new Float64Array(0);
  let pitch = new Float64Array(0);
  let roll = new Float64Array(0);
  let colour = new Float32Array(0);
  let vari = new Float32Array(0);
  let reveal = new Float32Array(0);
  let ferryReveal = new Float32Array(0);
  let revealStart = 0;
  let revealDone = false;
  const untrack: Array<() => void> = [];
  const cards: Array<{ sub?: string }> = [];
  let lastStop = new Int16Array(0);
  const vp = new Vector2();
  const lodR = { value: new Vector2(30, 38) };
  const ferryLod = { value: new Vector2(1e6, 1e6 + 1) };
  const frustum = new Frustum();
  const pm = new Matrix4();
  // scratch (zero allocation per frame)
  const P = v3();
  const U = v3();
  const fwd = v3();
  const left = v3();
  const up = v3();
  const bp = v3();
  const mo = new Float64Array(2);
  const fp = v3();
  const ff = v3();
  const dq = v3();

  const replaySteps = (ctx: LBContext) => Math.round((WARM + Math.min(Math.max(ctx.time.t, 0), REPLAY_MAX)) / ctx.time.fixedDt);
  const replay = (ctx: LBContext) => {
    if (!sim) return;
    sim.setObstacle(false, null);
    sim.reset();
    const n = replaySteps(ctx);
    for (let k = 0; k < n; k++) sim.step(ctx.time.fixedDt, null, k === n - 1 ? service!.blocked : null);
  };

  /** Vehicle i's interpolated frame at render fraction a: body centre P (on the road), U the local up, fwd / left / up the body's axes. */
  function frame(i: number, a: number) {
    const s = sim!;
    const o = i * 3;
    P.x = s.pC[o] + (s.C[o] - s.pC[o]) * a;
    P.y = s.pC[o + 1] + (s.C[o + 1] - s.pC[o + 1]) * a;
    P.z = s.pC[o + 2] + (s.C[o + 2] - s.pC[o + 2]) * a;
    const pl = Math.sqrt(P.x * P.x + P.y * P.y + P.z * P.z) || 1;
    U.x = P.x / pl;
    U.y = P.y / pl;
    U.z = P.z / pl;
    // the chord rear axle → front axle (graded: the body pitches with the road)
    let fx = s.pF[o] + (s.F[o] - s.pF[o]) * a - (s.pRr[o] + (s.Rr[o] - s.pRr[o]) * a);
    let fy = s.pF[o + 1] + (s.F[o + 1] - s.pF[o + 1]) * a - (s.pRr[o + 1] + (s.Rr[o + 1] - s.pRr[o + 1]) * a);
    let fz = s.pF[o + 2] + (s.F[o + 2] - s.pF[o + 2]) * a - (s.pRr[o + 2] + (s.Rr[o + 2] - s.pRr[o + 2]) * a);
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    fwd.x = fx;
    fwd.y = fy;
    fwd.z = fz;
    let lx = U.y * fz - U.z * fy;
    let ly = U.z * fx - U.x * fz;
    let lz = U.x * fy - U.y * fx;
    const ll = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
    lx /= ll;
    ly /= ll;
    lz /= ll;
    left.x = lx;
    left.y = ly;
    left.z = lz;
    up.x = fy * lz - fz * ly;
    up.y = fz * lx - fx * lz;
    up.z = fx * ly - fy * lx;
  }

  function put(p: Pack, i: number) {
    const j = p.n++;
    basis(p.mat, j * 16, left, up, fwd, P);
    p.col[j * 3] = colour[i * 3];
    p.col[j * 3 + 1] = colour[i * 3 + 1];
    p.col[j * 3 + 2] = colour[i * 3 + 2];
    p.mo[j * 4] = mo[0];
    p.mo[j * 4 + 1] = steer[i];
    p.mo[j * 4 + 2] = mo[1];
    p.mo[j * 4 + 3] = roll[i];
    p.st[j * 3] = sim!.brake[i];
    p.st[j * 3 + 1] = sim!.signal[i];
    p.st[j * 3 + 2] = pitch[i];
    p.rv[j] = reveal[i];
    p.va[j] = sim!.door[i] ? DOORS : vari[i];
  }

  /** Is a body of radius r at P in the frustum (P, r as doubles inlined: zero alloc). */
  function inView(r: number) {
    const pl = frustum.planes;
    for (let q = 0; q < 6; q++) {
      const n = pl[q].normal;
      if (n.x * P.x + n.y * P.y + n.z * P.z + pl[q].constant < -r) return false;
    }
    return true;
  }

  function draw(ctx: LBContext) {
    if (!sim || !lights || !ferryPack) return;
    const a = ctx.time.alpha;
    const dt = ctx.time.dt;
    const kS = dt > 0 ? 1 - Math.exp(-dt * 7) : 1;
    const rm = ctx.reducedMotion;
    const v = ctx.view;
    const beamsOn = shown && v.altTerrain < 260;
    const bm = lights.beams.instanceMatrix.array as Float32Array;
    const sp6 = lights.pos;
    const sd = lights.dir;
    const rn = NEAR_K / Math.tan((v.fov * Math.PI) / 360);
    lodR.value.set(rn - BAND, rn + BAND);
    const farR = v.horizon + 34;
    const cam = ctx.camera;
    frustum.setFromProjectionMatrix(pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const E = v.eye;
    for (let k = 0; k < packs.length; k++) packs[k].n = 0;
    let nl = 0;
    for (let i = 0; shown && i < sim.n; i++) {
      const kind = KINDS[sim.kind[i]];
      frame(i, a);
      // steering: the front axle's travel against the body's heading (+ turns left: +x is left)
      const o = i * 3;
      const vx = sim.F[o] - sim.pF[o];
      const vy = sim.F[o + 1] - sim.pF[o + 1];
      const vz = sim.F[o + 2] - sim.pF[o + 2];
      if (vx * vx + vy * vy + vz * vz > 1e-6) {
        const st = Math.max(-0.55, Math.min(0.55, 1.5 * Math.atan2(vx * left.x + vy * left.y + vz * left.z, vx * fwd.x + vy * fwd.y + vz * fwd.z)));
        steer[i] += (st - steer[i]) * kS;
      }
      const sp = sim.v[i];
      const kappa = (2 * Math.tan(steer[i] / 1.5)) / kind.wheelbase;
      roll[i] += (rm ? -roll[i] : Math.max(-0.06, Math.min(0.06, sp * sp * kappa * 0.012)) - roll[i]) * kS;
      pitch[i] += (Math.max(-0.05, Math.min(0.03, sim.acc[i] * 0.011)) - pitch[i]) * kS;
      mo[0] = sim.odo[i] / kind.wheelR;
      mo[1] = rm ? 0 : 0.012 * Math.min(1, sp / 4) * Math.sin(sim.odo[i] * 1.7 + i * 1.3);
      const ex = P.x - E.x;
      const ey = P.y - E.y;
      const ez = P.z - E.z;
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const hl = kind.len / 2;
      if (d > farR || !inView(hl + 7)) continue;
      const k = sim.kind[i] * 2;
      if (d < rn + BAND + hl) put(packs[k], i);
      if (d > rn - BAND - hl) put(packs[k + 1], i);
      if (!beamsOn) continue;
      // night lights, packed: the beam from the bumper, the head / tail sparks
      bp.x = P.x + fwd.x * hl + U.x * 0.012;
      bp.y = P.y + fwd.y * hl + U.y * 0.012;
      bp.z = P.z + fwd.z * hl + U.z * 0.012;
      basis(bm, nl * 16, left, U, fwd, bp);
      const lh = 0.8;
      sp6[nl * 6] = P.x + fwd.x * (hl + 0.05) + U.x * lh;
      sp6[nl * 6 + 1] = P.y + fwd.y * (hl + 0.05) + U.y * lh;
      sp6[nl * 6 + 2] = P.z + fwd.z * (hl + 0.05) + U.z * lh;
      sp6[nl * 6 + 3] = P.x - fwd.x * (hl + 0.05) + U.x * (lh + 0.06);
      sp6[nl * 6 + 4] = P.y - fwd.y * (hl + 0.05) + U.y * (lh + 0.06);
      sp6[nl * 6 + 5] = P.z - fwd.z * (hl + 0.05) + U.z * (lh + 0.06);
      for (let e = 0; e < 2; e++) {
        sd[nl * 8 + e * 4] = fwd.x;
        sd[nl * 8 + e * 4 + 1] = fwd.y;
        sd[nl * 8 + e * 4 + 2] = fwd.z;
        sd[nl * 8 + e * 4 + 3] = sim.brake[i];
      }
      nl++;
    }
    // the ferries: bobbing on the swell, the wake while under way
    const fpk = ferryPack;
    fpk.n = 0;
    const t = ctx.time.render;
    for (let k = 0; shown && k < tracks.length; k++) {
      const st = tracks[k].at(t, phase[k], fst[k]);
      tracks[k].pose(st, P, fwd);
      const pl = Math.sqrt(P.x * P.x + P.y * P.y + P.z * P.z) || 1;
      U.x = P.x / pl;
      U.y = P.y / pl;
      U.z = P.z / pl;
      const ex = P.x - E.x;
      const ey = P.y - E.y;
      const ez = P.z - E.z;
      if (Math.sqrt(ex * ex + ey * ey + ez * ez) > farR + FERRY_LEN || !inView(FERRY_LEN / 2 + 9)) continue;
      left.x = U.y * fwd.z - U.z * fwd.y;
      left.y = U.z * fwd.x - U.x * fwd.z;
      left.z = U.x * fwd.y - U.y * fwd.x;
      const j = fpk.n++;
      basis(fpk.mat, j * 16, left, U, fwd, P);
      const c = FERRY_COLOURS[k % FERRY_COLOURS.length];
      fpk.col[j * 3] = c.r;
      fpk.col[j * 3 + 1] = c.g;
      fpk.col[j * 3 + 2] = c.b;
      fpk.mo[j * 4] = 0;
      fpk.mo[j * 4 + 1] = 0;
      // (no swell under reduced motion)
      const sw = rm ? 0 : 1;
      fpk.mo[j * 4 + 2] = sw * 0.05 * Math.sin(t * 1.1 + k * 2.1);
      fpk.mo[j * 4 + 3] = sw * 0.012 * Math.sin(t * 0.8 + k);
      fpk.st[j * 3] = 0;
      fpk.st[j * 3 + 1] = 0;
      fpk.st[j * 3 + 2] = sw * 0.008 * Math.sin(t * 0.63 + k * 1.7);
      fpk.rv[j] = ferryReveal[k];
      fpk.va[j] = st.v > 0.8 ? WAKE : 0;
    }
    // shadows from the near meshes only, high tier, below SH_TO (dithered out by the depth patch)
    const cast = ctx.quality === 'high' && v.altTerrain < SH_TO;
    for (let k = 0; k < packs.length; k++) {
      const p = packs[k];
      p.mesh.count = p.n;
      p.mesh.visible = p.n > 0;
      p.mesh.castShadow = cast && (k & 1) === 0;
      if (p.n) for (let q = 0; q < p.attrs.length; q++) p.attrs[q].needsUpdate = true;
    }
    fpk.mesh.count = fpk.n;
    fpk.mesh.visible = fpk.n > 0;
    fpk.mesh.castShadow = cast;
    if (fpk.n) for (let q = 0; q < fpk.attrs.length; q++) fpk.attrs[q].needsUpdate = true;
    const night = ctx.uniforms.lbNight.value;
    lights.beams.count = nl;
    lights.beams.visible = beamsOn && night > 0.01 && nl > 0;
    if (lights.beams.visible) lights.beams.instanceMatrix.needsUpdate = true;
    lights.sparks.visible = nl > 0;
    lights.sparks.geometry.setDrawRange(0, nl * 2);
    lights.posAttr.needsUpdate = true;
    lights.dirAttr.needsUpdate = true;
  }

  /** The player's / a townsperson's collision: push a disc out of every vehicle's body box (each in its own tangent plane). */
  function collide(dir: Vec3, r: number, out: Vec3): boolean {
    const s = sim;
    out.x = dir.x;
    out.y = dir.y;
    out.z = dir.z;
    if (!s) return false;
    let moved = false;
    for (let i = 0; i < s.n; i++) {
      const K = KINDS[s.kind[i]];
      const hl = K.len / 2;
      const hw = K.width / 2;
      const o = i * 3;
      const cl = Math.sqrt(s.C[o] * s.C[o] + s.C[o + 1] * s.C[o + 1] + s.C[o + 2] * s.C[o + 2]);
      // (the body's centre direction, and the disc's offset from it in metres on the tangent plane)
      const cx = s.C[o] / cl;
      const cy = s.C[o + 1] / cl;
      const cz = s.C[o + 2] / cl;
      let dx = (out.x - cx) * cl;
      let dy = (out.y - cy) * cl;
      let dz = (out.z - cz) * cl;
      const R0 = hl + hw + r;
      if (dx * dx + dy * dy + dz * dz > R0 * R0) continue;
      let ux = s.F[o] - s.Rr[o];
      let uy = s.F[o + 1] - s.Rr[o + 1];
      let uz = s.F[o + 2] - s.Rr[o + 2];
      const ud = ux * cx + uy * cy + uz * cz;
      ux -= cx * ud;
      uy -= cy * ud;
      uz -= cz * ud;
      const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
      ux /= ul;
      uy /= ul;
      uz /= ul;
      // w: the body's left (up × forward)
      const wx = cy * uz - cz * uy;
      const wy = cz * ux - cx * uz;
      const wz = cx * uy - cy * ux;
      let u = dx * ux + dy * uy + dz * uz;
      let w = dx * wx + dy * wy + dz * wz;
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
      dx = cx * cl + u * ux + w * wx;
      dy = cy * cl + u * uy + w * wy;
      dz = cz * cl + u * uz + w * wz;
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      out.x = dx / l;
      out.y = dy / l;
      out.z = dz / l;
      moved = true;
    }
    return moved;
  }

  return {
    name: 'transit',
    stage: 2,
    async init(ctx) {
      const region = ctx.world.region;
      // the crossings first: the townsfolk read them in their init (they come after us)
      const crossings = townCrossings(region);
      service = { crossings, busy: new Uint8Array(crossings.length), blocked: new Uint8Array(crossings.length), collide };
      ctx.services.transit = service;
      const showP = ctx.params.toggle('transit.show', { label: 'transit: the region traffic and ferries', value: true });
      shown = showP.value;
      unsub = ctx.params.onChange((p) => {
        if (p === showP) shown = showP.value;
      });

      // the graph on the road as drawn (the carriageway on the rendered ground, a span at its deck)
      const ground = groundOf(region, meshHeight(terrainData(ctx.world.planet, ctx.q.terrainDetail)));
      const nL = region.lanes.length;
      const net = await buildNetSliced(
        region,
        {
          surface(d, h, g, s) {
            if (g < nL) {
              const l = region.lanes[g];
              const e = region.edges[l.edge];
              if (e.bridges.length) {
                const L = e.centre.length;
                const sc = (e.lanesAB.includes(l.id) ? s : l.path.length - s) * (L / l.path.length);
                for (const b of e.bridges) if (sc > region.bridges[b].s0 - 1.5 && sc < region.bridges[b].s1 + 1.5) return h;
              }
            }
            return Math.max(ground(d) + ASPH, h - SLACK);
          },
        },
        () => ctx.yield(),
      );
      const seed = ctx.world.seed ^ SEED_LABEL;
      const routes = buildRoutes(net, seed);
      sim = createTransitSim(net, routes, seed);
      const n = sim.n;
      steer = new Float64Array(n);
      pitch = new Float64Array(n);
      roll = new Float64Array(n);
      colour = new Float32Array(n * 3);
      vari = new Float32Array(n);
      reveal = new Float32Array(n).fill(1e6);
      lastStop = new Int16Array(n).fill(-1);
      sim.reset();
      const steps = replaySteps(ctx);
      for (let k = 0; k < steps; k++) {
        sim.step(ctx.time.fixedDt, null, k === steps - 1 ? service.blocked : null);
        if ((k & 15) === 15) await ctx.yield();
      }
      // the ferries' timetables (boats sharing a pier take turns at it)
      const fleet = ferryFleet(region.ferries, seed);
      fleet.tracks.forEach((tr, k) => {
        tracks.push(tr);
        phase.push(fleet.phase[k]);
        fst.push({ s: 0, v: 0, docked: 0, toward: 1, left: 0 });
      });
      ferryReveal = new Float32Array(tracks.length).fill(1e6);

      // body colours by kind slot, the characters, the trucks' liveries
      const count = new Int32Array(KINDS.length);
      for (let i = 0; i < n; i++) {
        const k = sim.kind[i];
        const j = count[k]++;
        let c = bodyColours(KINDS[k].name)[colourSlot(sim, i, j)];
        if (k === 2) vari[i] = 1 + (j % 3);
        for (const [vk, vj, vv] of VARIANTS)
          if (vk === k && vj === j) {
            vari[i] = vv;
            c = VARIANT_COLOURS[vv]!;
          }
        colour[i * 3] = c.r;
        colour[i * 3 + 1] = c.g;
        colour[i * 3 + 2] = c.b;
      }
      await ctx.yield();

      const opts = { vertexColors: true, reveal: 'instance', revealDuration: 0.55, rim: 0.42 } as const;
      const mats = [ctx.toon.material({ name: 'transit', patch: vehiclePatch(lodR, 1), ...opts }), ctx.toon.material({ name: 'transit:far', patch: vehiclePatch(lodR, 2), ...opts })];
      const pack = (geo: BufferGeometry, mat: (typeof mats)[number], cnt: number, name: string): Pack => {
        const dyn = (size: number) => new InstancedBufferAttribute(new Float32Array(cnt * size), size).setUsage(DynamicDrawUsage);
        const mo = dyn(4);
        const st = dyn(3);
        const rv = dyn(1);
        const va = dyn(1);
        geo.setAttribute('aMotion', mo);
        geo.setAttribute('aState', st);
        geo.setAttribute('aReveal', rv);
        geo.setAttribute('aVar', va);
        const mesh = ctx.toon.instanced(geo, mat, cnt, { cast: true, receive: true });
        mesh.name = name;
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.instanceColor = dyn(3);
        mesh.frustumCulled = false; // packed per frame (view + horizon)
        mesh.count = 0;
        const attrs = [mesh.instanceMatrix, mesh.instanceColor, mo, st, rv, va] as InstancedBufferAttribute[];
        return { mesh, mat: mesh.instanceMatrix.array as Float32Array, col: mesh.instanceColor.array as Float32Array, mo: mo.array as Float32Array, st: st.array as Float32Array, rv: rv.array as Float32Array, va: va.array as Float32Array, attrs, n: 0 };
      };
      for (let k = 0; k < KINDS.length; k++) {
        const cnt = Math.max(1, count[k]);
        for (let lod = 0; lod < 2; lod++) {
          const geo = ctx.track(k === 3 ? buildBus(lod > 0) : buildVehicle(KINDS[k], lod > 0));
          packs.push(pack(geo, mats[lod], cnt, `transit:${KINDS[k].name}${lod ? ':far' : ''}`));
        }
        await ctx.yield();
      }
      const ferryMat = ctx.toon.material({ name: 'transit:ferry', patch: vehiclePatch(ferryLod, 1), ...opts });
      ferryPack = pack(ctx.track(buildFerry()), ferryMat, Math.max(1, tracks.length), 'transit:ferry');
      lights = createFleetLights(ctx, n);
      draw(ctx);
      // warm every program (colour + shadow) with something drawn in each pack
      for (const p of [...packs, ferryPack]) {
        p.mesh.count = 1;
        p.mesh.visible = true;
        p.mesh.castShadow = true;
      }
      ctx.scene.add(...packs.map((p) => p.mesh), ferryPack.mesh, lights.beams, lights.sparks);
      if (ctx.shotMode) packs[0].mesh.userData.transitSim = sim;
      await ctx.compile();

      // reveal: the fleet pops onto the roads after the roads, nearest the capital first
      const start = ctx.reveal.slot(1.4);
      revealStart = start;
      const cd = ctx.world.planet.cityDir;
      const far = (i: number) => -(sim!.C[i * 3] * cd.x + sim!.C[i * 3 + 1] * cd.y + sim!.C[i * 3 + 2] * cd.z);
      const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => far(p) - far(q));
      order.forEach((i, r) => (reveal[i] = start + (r / n) * 1.0));
      ferryReveal.fill(start + 0.6);
      const r0 = ctx.reveal.instant ? 1 : 0;
      lights.beamMat.uniforms.uReveal.value = r0;
      lights.sparkMat.uniforms.uReveal.value = r0;
      revealDone = ctx.reveal.instant;

      // every vehicle and ferry a Trackable
      fleetCards(sim, vari, ctx.world.seed).forEach((card, i) => {
        const K = KINDS[sim!.kind[i]];
        const t = {
          id: card.id,
          kind: card.kind,
          label: card.label,
          sub: card.sub,
          view: 'chase' as const,
          radius: Math.round(Math.hypot(K.len, K.width, K.height) * 50) / 100,
          pose(c: LBContext, out: TrackPose) {
            if (!sim) return false;
            frame(i, c.time.alpha);
            const h = K.height / 2;
            out.pos.set(P.x + up.x * h, P.y + up.y * h, P.z + up.z * h);
            out.fwd.set(fwd.x, fwd.y, fwd.z);
            out.up.set(up.x, up.y, up.z);
            out.speed = sim.v[i];
            return shown;
          },
          detail: () => (sim ? fleetDetailOf(i) : ''),
        };
        cards.push(t);
        untrack.push(ctx.services.track.register(t));
      });
      tracks.forEach((tr, k) => {
        const card = ferryCard(region, k);
        untrack.push(
          ctx.services.track.register({
            id: card.id,
            kind: card.kind,
            label: card.label,
            sub: card.sub,
            view: 'chase',
            radius: Math.round(Math.hypot(FERRY_LEN, FERRY_BEAM, FERRY_HEIGHT) * 50) / 100,
            pose(c, out) {
              const st = tr.at(c.time.render, phase[k], fst[k]);
              tr.pose(st, fp, ff);
              const l = Math.sqrt(fp.x * fp.x + fp.y * fp.y + fp.z * fp.z) || 1;
              out.up.set(fp.x / l, fp.y / l, fp.z / l);
              out.pos.set(fp.x + out.up.x * 1.6, fp.y + out.up.y * 1.6, fp.z + out.up.z * 1.6);
              out.fwd.set(ff.x, ff.y, ff.z);
              out.speed = st.v;
              return shown;
            },
            detail(c) {
              const st = tr.at(c.time.render, phase[k], fst[k]);
              tr.pose(st, fp, ff);
              const l = Math.sqrt(fp.x * fp.x + fp.y * fp.y + fp.z * fp.z) || 1;
              dq.x = fp.x / l;
              dq.y = fp.y / l;
              dq.z = fp.z / l;
              return ferryDetail(region, k, st, dq, ff);
            },
          }),
        );
      });
    },
    fixedUpdate(ctx) {
      if (!sim || !service) return;
      const v = ctx.view;
      // the walking player is an obstacle in the street: vehicles stop short of them
      sim.setObstacle(v.mode === 'explore' && v.street, v.focus);
      sim.step(ctx.time.fixedDt, service.busy, service.blocked);
    },
    update(ctx) {
      if (!sim || !lights) return;
      if (!revealDone) {
        const p = ctx.reveal.progress(revealStart + 0.6, 1.0);
        lights.beamMat.uniforms.uReveal.value = p;
        lights.sparkMat.uniforms.uReveal.value = p;
        revealDone = p >= 1;
      }
      // a bus's card follows its line: 'far haven → clover'
      for (let i = 0; i < sim.n; i++)
        if (sim.kind[i] === 3 && sim.stop[i] !== lastStop[i]) {
          lastStop[i] = sim.stop[i];
          cards[i].sub = busSub(sim, i);
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
      for (const off of untrack) off();
      untrack.length = 0;
      unsub?.();
      unsub = null;
      if (ctx.services.transit === service) delete ctx.services.transit;
      service = null;
      sim = null;
      lights = null;
      packs.length = 0;
      ferryPack = null;
      tracks.length = 0;
      fst.length = 0;
      phase.length = 0;
      cards.length = 0;
    },
  };

  function fleetDetailOf(i: number) {
    return sim ? fleetDetail(sim, i) : '';
  }
}
