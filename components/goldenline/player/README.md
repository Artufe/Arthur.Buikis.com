# player/: first-person body, board, locomotion, camera (A6)

`ctx.services.player` is a `PlayerRig` (`player/api.ts`), a superset of the contract's
`PlayerService`. Use `isPlayerRig(ctx.services.player)` before touching the extras.

## Files

| file | what |
|---|---|
| `index.ts` | the system: params, init/warmup/update/dispose, wiring, splats, drips, lab cameras |
| `api.ts` | `PlayerRig`, `RideDriver`, `CameraFx`, `Stance`, `BoardSpec` (the hand-off types) |
| `controller.ts` | `PlayerCore`: state machine + locomotion (walk, wade, paddle, catch, pop-up, ride/wipeout fallbacks) |
| `poses.ts`, `pose.ts` | one pose writer per mode → a world-space `Pose`; mode changes blend two poses |
| `gait.ts` | foot planting; each landing is a frame event that splats the footprint |
| `camera.ts` | head spring, shake, FOV/roll/pitch offsets, the never-below-water floor |
| `board/` | lofted 7'0" funboard (`shape.ts` outline/rocker/foil), pad, TSL material |
| `body/` | SDF-modelled limbs (`models.ts`), surface-nets mesher (`sdf.ts`), skinning (`build.ts`), IK rig (`rig.ts`), skin + shorts material (`skin.ts`) |
| `drips.ts` | pooled drips off the fingertips (160 instanced droplets) |
| `script.ts` | deterministic demo scripts for shots (`player.demo`) |
| `tex.ts` | boot-time CPU bakes: wax, water beads, skin relief, broad noise (all mip-mapped) |

No third-party assets. Everything is procedural and baked at boot (~1–3 s of the loading
screen on an M3, limb meshing dominates).

## State machine

```
walk ⇄ wade ──(depth > 1.05 m, or > 0.62 m + Space / W seaward)──► paddle
wade ◄──(depth < 0.55 m while prone)── paddle
paddle ──(wave face under the board, heading shoreward, paddling or already moving at 0.6 c)──► catch
catch ──(Space once catchProgress > 0.25)──► popup ──(0.55 s)──► ride
catch ──(wave passes)──► paddle
ride ──(driver returns 'wipeout' | 'paddle')──► wipeout / paddle
wipeout ──(driver, or 1.7 s fallback)──► paddle
walk: falling into deep water (feet 0.9 m under, > 1.4 m deep) ──► paddle   (the pier tip is railed, so today only reachable off unrailed edges)
```

Every change goes through `setMode(mode, blendSeconds)`: the outgoing mode's pose is still
evaluated live and blended into the new one with smootherstep (defaults in `controller.ts`
`BLEND`; →paddle 0.95 s, →popup 0.12 s, →ride 0.25 s; the ride fallbacks hand back over 1.0 s). Nothing snaps: the eye,
board, both arms and both legs are all part of the blend. Use `rig.setMode()` from outside
(it is applied at the start of the player's next update).

Controls: WASD / arrows, Shift run / sprint-paddle, Space = slide onto the board (wading),
push up over whitewater (prone, hold), pop up (catching). Mouse look. While prone the head can
turn ±120° from the board heading; paddling steers the board toward the view.

## Surf system (B1) take-over

```ts
import { isPlayerRig, type RideDriver } from '../player/api';
const rig = ctx.services.player;
if (isPlayerRig(rig)) rig.setRideDriver(myDriver);
```

- `begin(ctx, rig)` fires once when the pop-up lands (`mode` becomes `'ride'`). At that moment
  `rig.boardPosition` / `rig.boardQuat` hold the prone board pose, `rig.velocity` and `rig.speed`
  the board's velocity. Start your physics from those.
- `update(ctx, rig, dt)` runs every frame while riding (and while wiping out if
  `handlesWipeout: true`). **Write** `rig.boardPosition`, `rig.boardQuat` (board frame: +X nose,
  +Y deck, +Z right rail), `rig.velocity`, `rig.speed`, and `rig.stance` (feet positions on the
  deck in board metres, crouch 0..1, lean −1..1 heel/toe, fore −1..1, arms 0..1). The player
  renders board, legs (IK to the stance feet), arms and the eye from those, so the feet stay
  planted on the deck exactly. Return `'ride'`, `'wipeout'` or `'paddle'`.
- The mouse still drives `rig.yaw` / `rig.pitch` (the view). Shape the camera through `rig.cam`
  (`CameraFx`): `fovKick` (deg, eased), `roll` (rad, eased), `pitchOffset` (rad, eased),
  `offset` (world m, not eased), `shake(trauma 0..1)` (decays ~0.7 s), `impulse(vx, vy, vz)`
  (kicks the head spring). Shake and FOV kick are suppressed under `ctx.reducedMotion`.
- When your driver hands back `'paddle'` the player eases from the stance to prone over 1 s,
  continuing from the board pose you last wrote.
- Without a driver the player uses a simple glide fallback (so the pop-up is testable now).
- `rig.board` (`BoardSpec`) gives `deckAt(x)` and `halfWidthAt(x)` for rail contact / spray
  emit points. Default stance (regular foot): rear foot on the pad at x = −0.72, front at −0.1.
- Lab wave: `PlayerCore.startLabWave()` (demo 4 used it before breakers existed) injects a
  swell hump into the player's own CPU samples only. Not used by default.

## Other systems

- Footprints: `SPLAT_FOOTPRINT` on the exact landing frame of each foot, at the planted foot's
  mid-foot point, radius 0.13 m, `dir` = foot heading; strength 1 (dry) or 0.6 (in the swash).
  Wet feet (for ~45 s after the water) also splat `SPLAT_WET`. Nothing is splatted on the pier.
- Water: board wake `SPLAT_WAKE` 0.9 m behind the board centre when moving; each hand's pull
  splats a wake, each hand entry a small `SPLAT_FOAM`; wading feet splat wakes.
- Shadows: board, pad, both arms and legs cast; a torso capsule and head sphere cast only
  (they discard in every camera pass via `maskNode`/`maskShadowNode`), so the player's shadow
  on the sand and deck reads as a whole person.
- `rig.eye` is the final lens position (after springs), `rig.wetness` 0..1.

## Params (F1 → player)

`player.demo` (1 pier, 2 water, 3 lineup, 4 catch, 5 feet, 6 carry) + `player.demoAt`
(fast-forward seconds) drive the real controller for shots; `player.follow` puts a paddling
body under a locked debug camera (the `lineup` shot); `player.inspect` 1–9 are lab cameras
around the body; `player.detach` keeps a demo running without owning the camera;
`player.log` logs mode changes. Look: `skinSSS`, `skinTone`, `skinRelief`, `wet` (−1 auto),
`boardTint`, `bob`. Feel: `walkSpeed`, `runSpeed`, `paddleThrust`, `catchAssist`, `sens`.

The player hides itself whenever another system's shot locks the camera (so nobody else's
beauty shots get a stray board), unless `player.follow` is on.

## Known limits

- The torso and head are never seen: the pitch is limited per mode (walk −1.1, prone −0.62)
  and the eye travels forward when you look down, so the lens stays ahead of the chest.
- Hands don't grip the leash / there is no leash cord.
- Underwater hands rely on the water shader (A7) for refraction/absorption.
