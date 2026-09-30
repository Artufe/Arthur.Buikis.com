# surf/: the ride, the wipeout, the rail spray and wake, the pier exit demos (B1)

The surf system registers a `RideDriver` with A6's player (`rig.setRideDriver`) and takes the
board over from the pop-up to the kick-out or wipeout. It reads the breaker through A8's
`ocean.gpu.breaking.breaker()` / `ocean.wave()` / `ocean.sample()` (always fresh from
`ctx.services.ocean`, which A8 wraps) and writes the board pose, the rider's stance and the camera
effects back into the rig. The player still renders the body, board and camera.

## Files

| file | what |
|---|---|
| `index.ts` | the system: params (`surf.*`), wiring, the debug chase camera, the demo trigger, logs |
| `ride.ts` | `Ride` (the `RideDriver`): controls → yaw rate, the pocket drive, board attitude, stance, camera, endings |
| `sim.ts` | `BoardSim`: board physics on the moving surface (substeps ≤ 1/180 s) |
| `wipeout.ts` | the tumble: rider thrown and dragged in the whitewater, board flies then the leash reels it in |
| `fx.ts` | foam trail + rail foam + wake into `state`, the tail spray fan (+ its shadow proxies), speed sheet, tube drips, landing / wipeout / pier-entry splashes |
| `script.ts`, `demos.ts` | deterministic input playback (`surf.demo`): the ride, the pier run, a wipeout |

Player-side pieces this needs (all marked `// [surf]` in `player/`): `Stance.bodyX/Y/Z`, `guard`,
`reach`, `tumble`, `eyeX/Y/Z`; `rig.intent`, `rig.externalIntent`, `rig.viewTurn`;
`RideDriver.popup`; the `climb` mode, the pier jump and the water entry in `controller.ts`; the
lean axis, the tumble and the climb poses in `poses.ts`. The pier opening and ladder are in
`pier/plan.ts` (`GAP`, `LADDER`) and `pier/service.ts` (`exit`, `ladder`, the doorway in
`clampToDeck`).

## Controls (riding)

| input | does |
|---|---|
| mouse look | chooses the line: the board carves toward the view (`surf.lookGain` per radian) |
| A / D | rail to rail: carve left / right at the carve limit (`surf.carveG`); the head is carried round |
| W | pump and trim: rhythmic thrust (1.4 Hz), weight forward; in the pocket, run ahead of the curl |
| S | stall: tail drag, nose up; in the pocket, sit back into the tube |
| Space | kick out (sit back onto the board, paddle) |

A look beyond ~75° over the shoulder is a glance, not a line: its pull fades out by ~115°, so
you can look back at your trail without turning round. The carve limit falls off below 4 m/s
(a slow board pivots little). Yaw acceleration is rate-limited (`surf.railRate`), so every carve is eased; the rail angle
follows the coordinated bank `tan ρ = v·ω / g`; the body leans along the effective gravity (carve,
drop, pump / brake), which is what the horizon bank (`surf.bank`) shows. FOV pushes with speed
(`surf.fov`), shake on landings, skids, the drop and whitewater hits. All camera effects go
through `rig.cam`, so reduced motion (no shake, no FOV kick, gentler tumble) and
`ctx.debug.cameraLocked` are honoured by the player's camera.

## The physics (sim.ts)

The board is a point on the ridable surface with a full 3-D velocity. Per substep:

1. `ocean.sample()` under the board: height, normal (down-slope is +n), water velocity, whitewater.
2. Contact with a surface that **translates** with the wave (U = the breaker's crest speed along
   its direction, or the shallow-water swell speed): the board keeps the surface's normal velocity
   U·n. A small normal component (following a curve) keeps the speed magnitude (a frictionless
   curve does no work); an impact is inelastic. Leaving faster than the surface follows (`sepV`)
   goes airborne until it lands (the landing speed drives spray, shake and the flat-landing wipeout).
3. Forces: gravity along the surface; planing drag against the water (linear + quadratic,
   + whitewater drag, + stall drag); pump thrust (worth more on a steep face); the pocket drive;
   the fins' lateral grip up to a limit (`latMax`, less in whitewater) beyond which the tail skids;
   induced drag from the fin force.
4. The fins hold the line in the **wave's frame** on a breaking face (its water travels with it),
   blended to the still-water frame on the flat by the slope. A face steeper than ~60° can't be
   held on a rail (the grip fades out), or the barrel's vertical wall would pin the board to it.

The pocket drive (`surf.pocket`, 0 = pure physics): the curl here peels at 16–18 m/s along the
crest (A8's `swellDir` +18°), far faster than trim physics on a 3 m face (~9 m/s), so a board that
drops into the barrel could never outrun it. The ride estimates the peel speed from the board's
own motion (`peel = v_line / (1 − T_s·dφ/dt)`, smoothed; the tracker's per-column peel is too
ripply) and servoes φ at the board toward a target the rider sets (W runs ahead, S sits deeper),
capped a little above the peel. Only along the line and on the face near the curl.

## Endings

| ending | when |
|---|---|
| kick-out | Space (after 0.5 s) → `paddle` |
| slow | < 1.6 m/s for 0.7 s (the wave has gone) → `paddle` |
| over the back | behind the crest and slower than 0.6 c for 0.6 s → `paddle` |
| shallow | < 0.45 m of water → `paddle` |
| caught inside | φ past the collapse in whitewater for 0.25 s → wipeout |
| over the falls | at the pitching lip, high on the face, for 0.15 s → wipeout |
| rail | rail > 57° under 4.5 m/s for 0.3 s → wipeout |
| piling | within 0.32 m of a piling → wipeout |
| landing | a landing faster than 5.5 m/s → wipeout |

The wipeout (1.75 s) keeps the head above the surface (it floats 0.3 m over it and is dragged
with the bore), rolls and pitches the camera (×0.3 under reduced motion), throws a whiteout of
foam and mist round the lens (never on it), spins the board free and reels it back on the leash,
then hands back to `paddle` with the board under the chest (the player's 0.95 s blend).

## Effects (fx.ts)

All through bulk paths: `state.reserve()` + `state.splatData`, `spray.reserve()` + `spray.emitData`.

- **Foam trail**: SPLAT_FOAM along the tail's path, a splat every 0.25 m with a strength per
  point of the path (not per frame: a board crossing each point once at 17 m/s would leave
  nothing), more on a loaded rail; rail foam and SPLAT_WAKE behind the fins every frame. The
  foam lives in A5's state, so the line stays on the water after the wave has passed.
- **Fan**: off the tail when the lateral load passes ~0.55 g (or on a skid or stall): five
  elevation slices of droplets thrown outward and up, a whiter core and a little mist; the shared
  spray lights them (backlit glow toward the sun). Sprites can't cast shadows, so each slice also
  spawns clumps in `surf.sprayShadow`, an instanced icosphere cloud whose material is masked out
  of every camera pass (`maskNode`) but drawn into the shadow maps (`maskShadowNode`). 384 clumps,
  ballistic with the spray's drag, written straight into the instance matrices.
- **Speed sheet** off the inside rail above 7 m/s, **tube drips and mist** hanging ahead in the
  barrel, a **landing** burst, the **wipeout** whiteout, the **pier entry** (burst, foam, wake
  ring, a 0.45 s sheet round the lens) and water streaming off on the **climb**.

## Pier exit

- `pier/plan.ts`: a 1.4 m gap in the tip rail (`GAP`), end posts, whipped rope ends tied off, worn
  planks in the doorway; a timber swim ladder (`LADDER`) hung off the tip piles on standoffs, its
  treads in the rails, barnacles and algae below the tide line (the pilings' material).
- `pier/service.ts`: `clampToDeck` lets the body through the doorway only; `exit` and `ladder`
  describe both for the player.
- `player/controller.ts`: Space at the opening (or walking off) jumps (3.1 m/s up, ≥ 2.6 m/s out);
  the water brakes the plunge (the lens stops at the surface) and hands over to `paddle` with the
  board coming under the chest. Paddling into the ladder or Space beside it starts `climb`
  (`CLIMB`: 0.75 s to the bottom tread, rung by rung to 3.9 s, over the edge onto the deck by
  4.75 s), then `walk`.
- `player/poses.ts` `climbPose`: hands on the stiles/rungs, the board tucked under the left arm.

## Demos and shots

`surf.demo` 1 = the ride (paddle into a set at the peak, drop, bottom turn, barrel, out onto the
shoulder by the pier, cutback, rebound, glide), 2 = the pier run (walk out, jump, paddle round,
climb the ladder, walk back, look over the edge), 3 = a wipeout (stall too long in the barrel).
The playback writes intent through `rig.externalIntent`, i.e. the same path as the keyboard.
Scripts are closed-loop (they read the breaker under the board), and the sim is deterministic, so
every run replays the same ride.

Shots (`lab/shots.ts`): `surf-ride` (`--advance 2.4 --seq 48 --interval 0.25`), `surf-wipeout`,
`surf-fanshadow` (a fan thrown over the pier deck, for the shadow; A/B with `surf.fx.shadows=0`),
`pierexit-gap`, `pierexit-ladder`, `pierexit-run` (`--advance 6.4 --seq 48 --interval 0.35`).

Debug: `surf.chase` (1 side, 2 behind, 3 ahead, 4 down-sun, 5 overhead) detaches the camera and
follows the rider (e.g. `--shot surf-ride --advance 4.15 --p surf.chase=3`: the bottom turn under
the lip, fan off the tail); `surf.fx.proxies` shows the shadow clumps; `surf.fx.shadows` /
`surf.fx.shadowScale` switch / size their shadow; `surf.fx.test` throws a test fan over the pier
tip; `surf.log` / `surf.logFrames` print mode changes / per-frame numbers (speed, g, rail, φ, the
pocket drive, the peel estimate).

Checks used in review (scratch scripts, easy to rebuild on `window.__goldenline` +
`window.__surf`): per-frame camera / board / view steps against the local median over a whole
demo (a snap is a step > 3× its neighbours'; none in any demo), the lens height above
`ocean.sample()` (≥ 0.14 m, A6's clearance, everywhere off the deck), and body on/off frame diffs
(`player.body`) for limbs in view.

## Zero allocation

Per-frame state is plain number fields and typed arrays, never three `Vector3`/`Quaternion`
fields (tagged in this app: every changing double stored into one boxes a HeapNumber). The step
(`dt`) and control share are fields, not arguments; eases and clamps are written inline; the
spray fan reads randomness from a fixed table; proxy spawns take their numbers from a scratch
array. The boxing left is at A8's `sample()` / `breaker()` / `wave()` calls (they take doubles)
and the contract writes into `rig.boardPosition` / `boardQuat` / `velocity`. See PERF.md.
