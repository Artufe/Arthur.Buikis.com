// The space layer (v2, S1): a cartoon space station and ten cartoon satellites on inclined orbits
// between SPACE_MIN and SPACE_MAX, crossing in front of the planet from orbit, moving lights over
// the street at night, and things you can ride ('alongside') up close.
//
//   - Orbits (orbits.ts): closed-form in sim time, each body at its own height (no two ever
//     meet); a body passing near the eye slides aside (`dodge`), so nothing flies through the camera
//     (except the ridden one, which the camera keeps its distance from by itself).
//   - Bodies (models.ts → one merged geometry, one draw call): per body a transform, a sun-tracking
//     panel angle, a sunlit factor (the planet's shadow) and a reveal start, written each frame
//     into a uniform array the vertex shader reads (shaders.ts). Solar wings turn to the sun about
//     their axis; the solar sail and the deep-space telescope face it whole; the drum spins.
//   - Lights (one points draw): blinking beacons (red / green / white / amber), and a sunlit glint
//     per body so a satellite reads as a moving star from the ground at night (gone in the
//     planet's shadow, gone up close where the mesh carries it).
//   - Every body is a registered Trackable ('station:0', 'satellite:N', view 'alongside'); the
//     station also has a WorldLabel that tracks it.

import { AdditiveBlending, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Mesh, Points, ShaderMaterial, Vector3, Vector4 } from 'three';
import { LAYER_NO_INK, type LBContext, type System, type Trackable, type WorldLabel } from '../core/contracts';
import { SKY, smooth, spaceAmount } from '../sky/rig';
import { R } from '../world/config';
import { buildSpace, type ModelInfo } from './models';
import { ATTITUDE, dodge, ORBITS, orbitSpeed, orbitState, SAT_SCALE, sunlit } from './orbits';
import { bodyFrag, bodyVert, lightFrag, lightVert } from './shaders';

const NB = ORBITS.length;
/** Reveal: the station first, then the satellites one after another (s). */
const REVEAL_STAGGER = 0.09;
const REVEAL_DUR = 0.8;
/** The eye keeps at least this far (m) beyond a body's bounding radius. */
const CLEAR = 3.5;
/** Orbit trails: dots per body, arc length (m), on while the body is under TRAIL_PX[0] px, off by [1]. */
const TRAIL_DOTS = 22;
const TRAIL_LEN = 80;
const TRAIL_PX = [36, 80];
/**
 * From space a body smaller than BOOST_PX (bounding radius, px) is drawn bigger, up to BOOST_MAX×,
 * so it keeps a readable cartoon silhouette from the orbit view instead of a speck (most passes are
 * on the far side of the planet). Never the ridden body; up close (or from the air) nothing changes.
 */
const BOOST_PX = 28;
/** Per model: the radius of what reads as its body on screen, × its bounding radius (Trackable.bodyRadius). */
const BODY_K = [0.55, 0.38, 0.38, 0.42, 0.55, 0.8, 0.38, 0.4, 0.38, 0.38, 0.38, 0.38];
const BOOST_PX_STATION = 34;
const BOOST_MAX = 5;
/**
 * From space, a satellite's beacons fade out under this size (bounding radius, px, boosted: its body
 * is a third of that): coloured specks round a small body read as a smear, not as lights.
 */
const BEACON_PX = [30, 48];
/** The sky haze (from inside the air by day) fades off a body as it grows on screen (px). */
const HAZE_PX = [6, 40];
/** How far the wings turn toward the sun (1 = all the way). */
const TRACK_K = 0.7;

export function createSpaceSystem(): System {
  let mesh: Mesh | null = null;
  let points: Points | null = null;
  let bodyMat: ShaderMaterial | null = null;
  let lightMat: ShaderMaterial | null = null;
  let info: ModelInfo[] = [];
  let ready = false;
  let show = { value: true };
  const unregister: Array<() => void> = [];
  const body = new Float32Array(NB * 7 * 4);
  const revealAt = new Float32Array(NB);
  /** Per body: the dodge offset last applied (pose() adds it), its sunlit factor. */
  const offs = Array.from({ length: NB }, () => new Vector3());
  const lit = new Float32Array(NB);
  const haze = new Vector4();
  const skyFill = new Color();
  const p = new Vector3();
  const v = new Vector3();
  const f = new Vector3();
  const u = new Vector3();
  const x = new Vector3();
  const s = new Vector3();
  const a = new Vector3();
  const n0 = new Vector3();
  const tmp = new Vector3();
  const label: WorldLabel = { id: 'station', text: 'sky station', sub: 'crew of three · ride along', kind: 'station', dir: { x: 0, y: 1, z: 0 }, h: ORBITS[0].alt, minAlt: 0, maxAlt: 1e4, track: 'station:0' };

  /** The local frame of body i at its current position/velocity (p, v): writes x, u, f (local X, Y, Z in world). */
  const frame = (i: number, t: number, sun: Vector3) => {
    const o = ORBITS[i];
    f.copy(v).normalize();
    u.copy(p).normalize();
    u.addScaledVector(f, -u.dot(f)).normalize();
    if (o.attitude === ATTITUDE.sun) {
      // Local +Y (or −Y) to the sun; Z as close to the flight as that allows.
      u.copy(sun);
      if (o.flip) u.negate();
      tmp.copy(f).addScaledVector(u, -f.dot(u));
      if (tmp.lengthSq() < 1e-6) tmp.set(0, 1, 0).addScaledVector(u, -u.y);
      f.copy(tmp.normalize());
    }
    x.copy(u).cross(f);
    if (o.spin) {
      // Spin (or tumble) about local Y, or about Z (along the flight).
      const ang = o.spin * t + i * 1.7;
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      if (o.spinZ) {
        tmp.copy(x).multiplyScalar(c).addScaledVector(u, sn);
        u.multiplyScalar(c).addScaledVector(x, -sn);
      } else {
        tmp.copy(x).multiplyScalar(c).addScaledVector(f, sn);
        f.multiplyScalar(c).addScaledVector(x, -sn);
      }
      x.copy(tmp);
    }
  };

  return {
    name: 'space',
    stage: 2,
    async init(ctx: LBContext) {
      show = ctx.params.toggle('space.show', { label: 'space layer (station + satellites)', value: true });
      info = [];
      const steps = buildSpace(ORBITS.map((o) => o.model), info);
      let step = steps.next();
      while (!step.done) {
        await ctx.yield();
        step = steps.next();
      }
      const geo = ctx.track(step.value);
      await ctx.yield();

      bodyMat = ctx.track(
        new ShaderMaterial({
          name: 'space',
          vertexShader: bodyVert,
          fragmentShader: bodyFrag,
          side: DoubleSide,
          defines: { NB: String(NB), ...(ctx.reducedMotion ? { LB_REVEAL_FADE: '' } : {}) },
          uniforms: {
            ...ctx.uniforms,
            uBody: { value: body },
            uRevealDur: { value: REVEAL_DUR },
            uRamp: { value: ctx.toon.ramp },
            uSun: { value: new Color('#fff4e2').multiplyScalar(1.22) },
            uSpaceFill: { value: new Color('#454a9a').multiplyScalar(0.62) },
            uEarthFill: { value: new Color('#86c8ff').multiplyScalar(0.55) },
            uWindow: { value: new Color('#ffcf7a').multiplyScalar(1.1) },
            uHaze: { value: haze },
            uShadowFill: { value: new Color('#5a5f9e').multiplyScalar(0.62) },
            uSkyFill: { value: skyFill },
          },
        }),
      );
      mesh = new Mesh(geo, bodyMat);
      mesh.name = 'space';
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;

      // Lights: every beacon, plus one glint per body at its centre.
      const pos: number[] = [];
      const bi: number[] = [];
      const col: number[] = [];
      const meta: number[] = [];
      info.forEach((m, i) => {
        for (const b of m.beacons) {
          pos.push(...b.p);
          bi.push(i);
          col.push(b.color.r, b.color.g, b.color.b);
          meta.push(b.kind, b.phase + i * 0.37, ORBITS[i].kind === 'station' ? 0.5 : 0.32 * SAT_SCALE);
        }
        pos.push(0, 0, 0);
        bi.push(i);
        col.push(1, 0.96, 0.86);
        meta.push(3, 0, ORBITS[i].radius * 0.5);
        // The dotted trail back along the orbit.
        for (let k = 0; k < TRAIL_DOTS; k++) {
          pos.push(0, 0, 0);
          bi.push(i);
          col.push(0.78, 0.86, 1);
          meta.push(4, k / TRAIL_DOTS, ORBITS[i].kind === 'station' ? 1.1 : 0.8);
        }
      });
      const lgeo = ctx.track(new BufferGeometry());
      lgeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      lgeo.setAttribute('aBody', new Float32BufferAttribute(bi, 1));
      lgeo.setAttribute('aCol', new Float32BufferAttribute(col, 3));
      lgeo.setAttribute('aMeta', new Float32BufferAttribute(meta, 3));
      lightMat = ctx.track(
        new ShaderMaterial({
          name: 'space lights',
          vertexShader: lightVert,
          fragmentShader: lightFrag,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
          defines: { NB: String(NB) },
          uniforms: { ...ctx.uniforms, uBody: { value: body }, uRevealDur: { value: REVEAL_DUR }, uViewH: { value: 800 }, uDark: { value: 1 }, uTrail: { value: 0 }, uTrailLen: { value: TRAIL_LEN } },
        }),
      );
      points = new Points(lgeo, lightMat);
      points.name = 'space lights';
      points.frustumCulled = false;
      points.layers.set(LAYER_NO_INK);
      points.renderOrder = 6;

      // Hidden until the reveal (scale 0); write a first frame of transforms so nothing draws at NaN.
      for (let i = 0; i < NB; i++) revealAt[i] = 1e9;
      writeBodies(ctx);
      ctx.scene.add(mesh, points);
      await ctx.compile();
      const start = ctx.reveal.slot(REVEAL_STAGGER * NB + REVEAL_DUR);
      for (let i = 0; i < NB; i++) revealAt[i] = start + i * REVEAL_STAGGER;

      for (let i = 0; i < NB; i++) unregister.push(ctx.services.track.register(trackable(i)));
      unregister.push(ctx.services.labels.add(label));
      ready = true;
    },

    update(ctx: LBContext) {
      if (!ready || !bodyMat || !lightMat || !mesh || !points) return;
      mesh.visible = points.visible = show.value;
      if (!show.value) return;
      writeBodies(ctx);
      const vw = ctx.view;
      const air = 1 - spaceAmount(vw.altSea);
      const night = ctx.uniforms.lbNight.value;
      // Seen from inside the air by day they are tiny pale shapes against the blue; at night (and
      // from orbit) the sky is dark and their glints and beacons read.
      const fog = ctx.services.sky.fog;
      if (fog) haze.set(fog.color.r, fog.color.g, fog.color.b, 0).lerp(tmpV4.set(SKY.top.r, SKY.top.g, SKY.top.b, 0), 0.5);
      haze.w = air * (1 - night) * 0.45;
      skyFill.setRGB(0.46, 0.43, 0.38).multiplyScalar(air * (1 - night));
      lightMat.uniforms.uDark.value = Math.max(1 - air, smooth(0.2, 0.8, night)) * 0.88 + 0.12;
      // Trails only from space (from inside the air they would be dotted lines across the sky).
      lightMat.uniforms.uTrail.value = 1 - air;
      lightMat.uniforms.uViewH.value = ctx.canvas.height || 800;
      // The station's tag follows it.
      orbitState(ORBITS[0], ctx.time.render, p);
      p.add(offs[0]);
      const l = p.length();
      label.dir.x = p.x / l;
      label.dir.y = p.y / l;
      label.dir.z = p.z / l;
      label.h = l - R;
    },

    onTimeJump() {
      // Closed-form orbits: nothing to rebuild.
    },

    dispose() {
      for (const un of unregister) un();
      unregister.length = 0;
      mesh?.removeFromParent();
      points?.removeFromParent();
      bodyMat?.dispose();
      lightMat?.dispose();
      mesh = null;
      points = null;
      bodyMat = lightMat = null;
      ready = false;
    },
  };

  /** Every body's transform, panel angle, light and reveal into the uniform array. Zero allocation. */
  function writeBodies(ctx: LBContext) {
    const t = ctx.time.render;
    const sun = ctx.uniforms.lbSunDir.value;
    const eye = ctx.view.eye;
    const ride = ctx.view.ride;
    const cam = ctx.camera;
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    const hpx = (ctx.canvas.clientHeight || 800) / 2;
    const space = spaceAmount(ctx.view.altSea);
    for (let i = 0; i < NB; i++) {
      const o = ORBITS[i];
      orbitState(o, t, p, v);
      frame(i, t, sun);
      // Never through the camera (the ridden body excepted: the camera keeps its own distance).
      if (o.id !== ride) {
        dodge(p, f, eye, o.radius, CLEAR, offs[i]);
        p.add(offs[i]);
      } else offs[i].set(0, 0, 0);
      lit[i] = sunlit(p, sun);
      // Sun-tracking angle about the model's axis (local): face the panels to the sun.
      const m = info[i];
      s.set(sun.dot(x), sun.dot(u), sun.dot(f));
      a.set(m.axis[0], m.axis[1], m.axis[2]);
      n0.set(m.rest[0], m.rest[1], m.rest[2]);
      s.addScaledVector(a, -s.dot(a));
      // (70 % of the way: a toy's wings stay readable from above and below, never edge-on.)
      const ang = s.lengthSq() > 1e-8 ? Math.atan2(tmp.copy(n0).cross(s).dot(a), n0.dot(s)) * TRACK_K : 0;
      // The glint fades once the body itself is more than a few pixels across.
      const dist = Math.max(0.1, p.distanceTo(eye));
      const rpx0 = (o.radius / dist / tanHalf) * hpx;
      const target = o.kind === 'station' ? BOOST_PX_STATION : BOOST_PX;
      const boost = o.id === ride ? 1 : 1 + (Math.min(BOOST_MAX, Math.max(1, target / Math.max(rpx0, 0.1))) - 1) * space;
      const rpx = rpx0 * boost;
      const o5 = i * 28;
      body[o5] = x.x;
      body[o5 + 1] = u.x;
      body[o5 + 2] = f.x;
      body[o5 + 3] = p.x;
      body[o5 + 4] = x.y;
      body[o5 + 5] = u.y;
      body[o5 + 6] = f.y;
      body[o5 + 7] = p.y;
      body[o5 + 8] = x.z;
      body[o5 + 9] = u.z;
      body[o5 + 10] = f.z;
      body[o5 + 11] = p.z;
      body[o5 + 12] = a.x;
      body[o5 + 13] = a.y;
      body[o5 + 14] = a.z;
      body[o5 + 15] = ang;
      body[o5 + 16] = lit[i];
      body[o5 + 17] = revealAt[i];
      body[o5 + 18] = (o.kind === 'satellite' ? SAT_SCALE : 1) * boost;
      body[o5 + 19] = 1 - smooth(3, 10, rpx);
      // The flight direction (the dodge aside, the orbit's tangent) and the trail's fade.
      const vl = v.length() || 1;
      body[o5 + 20] = v.x / vl;
      body[o5 + 21] = v.y / vl;
      body[o5 + 22] = v.z / vl;
      body[o5 + 23] = 1 - smooth(TRAIL_PX[0], TRAIL_PX[1], rpx);
      // (The ridden one never hazes: followed up from the street it stays a crisp toy, over the
      // falling-through-clouds overlay too.)
      body[o5 + 24] = o.id === ride ? 0 : 1 - 0.7 * smooth(HAZE_PX[0], HAZE_PX[1], rpx);
      body[o5 + 25] = o.kind === 'station' ? 1 : 1 - space * (1 - smooth(BEACON_PX[0], BEACON_PX[1], rpx));
    }
  }

  function trackable(i: number): Trackable {
    const o = ORBITS[i];
    const speed = orbitSpeed(o);
    // The clouds re-draw it over their falling-through-clouds overlay (every body is in this one
    // shader-placed mesh; the re-draw is scissored to the followed one).
    const objects = mesh ? [mesh] : undefined;
    return {
      id: o.id,
      objects,
      // What reads as its body: the station's modules; a satellite's box between thin panels (a
      // third of its reach); the sail's sheet; the cubesat trio's spread.
      bodyRadius: o.radius * BODY_K[o.model],
      kind: o.kind,
      label: o.label,
      sub: o.sub,
      view: 'alongside',
      radius: o.radius,
      pose(ctx, out) {
        orbitState(o, ctx.time.render, out.pos, out.fwd);
        out.pos.add(offs[i]);
        out.fwd.normalize();
        out.up.copy(out.pos).normalize();
        out.up.addScaledVector(out.fwd, -out.up.dot(out.fwd)).normalize();
        out.speed = speed;
        // Not pickable or rideable while hidden (before its reveal, or with the layer switched off).
        return ready && show.value && ctx.reveal.clock >= revealAt[i];
      },
      detail(ctx) {
        const q = new Vector3();
        orbitState(o, ctx.time.render, q);
        const lap = Math.abs(o.period);
        const lapS = `${Math.floor(lap / 60)}:${String(Math.round(lap % 60)).padStart(2, '0')}`;
        const shade = lit[i] < 0.5 ? " · in the planet's shadow" : '';
        return `${Math.round(o.alt)} m up · ${Math.round(speed * 3.6)} km/h · a lap every ${lapS} · ${over(ctx, q)}${shade}`;
      },
    };
  }
}

const tmpV4 = new Vector4();

/** "over port pebble" (the nearest labelled place under the body), "over land" or "over the sea". */
function over(ctx: LBContext, pos: Vector3): string {
  const d = pos.clone().normalize();
  let best = '';
  let bestA = 0.32;
  for (const l of ctx.services.labels.list()) {
    if (l.track || l.kind === 'station') continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, d.x * l.dir.x + d.y * l.dir.y + d.z * l.dir.z)));
    if (ang < bestA) {
      bestA = ang;
      best = l.text;
    }
  }
  if (best) return `over ${best}`;
  return ctx.world.planet.heightAt(d) > 0 ? 'over land' : 'over the sea';
}
