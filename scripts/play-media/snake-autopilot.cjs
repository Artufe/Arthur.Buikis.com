// Scripted steering for the snake preview capture. Pure function of the engine state (plus its own
// commanded heading), so it runs identically offline (planner) and in the page (capture).
// Usage: const pilot = makePilot(E, opts); each sim step: h = pilot(state) -> heading | null.
function makePilot(E, opts) {
  const o = Object.assign(
    {
      rate: 2.2, // rad/s the commanded heading may swing (gentler than the engine's 3.6)
      closeRate: 3.4, // allowed when the food is near and off to the side
      wobA: 0.42, // S-curve wobble amplitude (rad)
      wobW: 2.0, // wobble angular frequency (rad/s)
      wobPhase: 0,
      wallStart: 12.5, // start bending inward at this radius
      wallFull: 17.0,
      bodyLook: 3.2, // how far ahead body points repel
    },
    opts || {},
  );
  const { SIM_DT, ARENA_R, SAMPLE_SPACING, SELF_SAFE_ARC } = E;
  let cmd = null;
  let t = 0;
  const wrap = (a) => E.wrapAngle(a);
  const sstep = (a, b, x) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  return function pilot(s) {
    if (s.status !== 'playing') return null;
    t += SIM_DT;
    if (cmd === null) cmd = s.heading;
    const hx = s.head.x;
    const hz = s.head.z;
    // Target: the golden one when present, else the nearest.
    let target = s.food.find((f) => f.kind === 'golden') || null;
    if (!target) {
      let best = Infinity;
      for (const f of s.food) {
        const d = (f.pos.x - hx) ** 2 + (f.pos.z - hz) ** 2;
        if (d < best) {
          best = d;
          target = f;
        }
      }
    }
    let dx = 1;
    let dz = 0;
    let dist = 10;
    if (target) {
      dx = target.pos.x - hx;
      dz = target.pos.z - hz;
      dist = Math.hypot(dx, dz) || 1e-6;
      dx /= dist;
      dz /= dist;
    } else {
      dx = Math.cos(s.heading);
      dz = Math.sin(s.heading);
    }
    // Lazy S-curve on top of the pursuit, fading out on the final approach.
    const wob = o.wobA * Math.sin(o.wobW * t + o.wobPhase) * sstep(1.5, 6, dist);
    let a = Math.atan2(dz, dx) + wob;
    let vx = Math.cos(a);
    let vz = Math.sin(a);
    // Wall: bend inward as the head nears the rock ring.
    const r = Math.hypot(hx, hz);
    const w = sstep(o.wallStart, o.wallFull, r);
    if (w > 0) {
      vx += (-hx / r) * w * 2.2;
      vz += (-hz / r) * w * 2.2;
    }
    // Body: push away from body samples that lie ahead and close.
    const ch = Math.cos(s.heading);
    const sh = Math.sin(s.heading);
    let rx = 0;
    let rz = 0;
    for (let i = 0; i < s.path.length; i++) {
      const arc = s.carry + i * SAMPLE_SPACING;
      if (arc > s.bodyLength) break;
      if (arc <= SELF_SAFE_ARC + 0.6) continue;
      const px = s.path[i].x - hx;
      const pz = s.path[i].z - hz;
      const d = Math.hypot(px, pz);
      if (d > o.bodyLook || d < 1e-6) continue;
      const ahead = (px * ch + pz * sh) / d;
      if (ahead < -0.2) continue;
      const k = (1 - d / o.bodyLook) ** 2 * (0.5 + ahead);
      rx -= (px / d) * k;
      rz -= (pz / d) * k;
    }
    vx += rx * 1.6;
    vz += rz * 1.6;
    let desired = Math.atan2(vz, vx);
    // Food inside the current turning circle can't be reached by turning: run straight to open it up.
    const off = E.angleDiff(s.heading, Math.atan2(dz, dx));
    if (target && dist < 4) {
      const R = s.speed / o.closeRate;
      const side = off > 0 ? 1 : -1;
      const cx = hx + -sh * side * R;
      const cz = hz + ch * side * R;
      const dc = Math.hypot(target.pos.x - cx, target.pos.z - cz);
      if (dc < R - 0.5) desired = s.heading;
    }
    const near = target && dist < 4.5 && Math.abs(off) > 0.5;
    const rate = (near ? o.closeRate : o.rate) * SIM_DT;
    cmd = wrap(cmd + Math.max(-rate, Math.min(rate, E.angleDiff(cmd, desired))));
    // Never let the commanded heading lead the real one by more than the engine can follow sanely.
    const lead = E.angleDiff(s.heading, cmd);
    if (Math.abs(lead) > 0.6) cmd = wrap(s.heading + Math.sign(lead) * 0.6);
    return cmd;
  };
}
if (typeof module !== 'undefined') module.exports = { makePilot };
if (typeof window !== 'undefined') window.makePilot = makePilot;
