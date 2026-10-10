# /play media: how the clips and posters are made

The `/play` page and the home Play strip show looping clips rendered **from the games themselves**,
frame by frame. There's no screen recording and no parameter tweaks. This file is the recipe to
regenerate them when a game changes. The scripts live in `scripts/play-media/` and run against
the dev server.

| File (`public/play/`) | What | Size |
|---|---|---|
| `goldenline.jpg` | Cover still: a barrel throwing spray, pier on the horizon (1600×1000) | ~265 KB |
| `goldenline.mp4` | Trailer: crash → ride → ashore, 0.5 s crossfades, seamless loop (1280×800, 30 fps, 15 s) | ~5.9 MB |
| `littlebig.jpg` | Cover still: the tiny planet from the dive's high swoop, downtown rising on its curve against space (1600×1000) | ~305 KB |
| `littlebig.mp4` | The scripted dive: orbit → cloud layer → a lively downtown street, a 2 s hold, a 0.5 s dissolve back to the globe, seamless loop (1280×800, 30 fps, 12 s, both themes) | ~1.9 MB |
| `littlebig-trailer.mp4` | The 30 s trailer with its score, opened from the card (1920×1080, 30 fps, H.264 + AAC) | ~15.2 MB |
| `littlebig-trailer.jpg` / `littlebig-ch1…4.jpg` | Its poster (the opening title, 1920×1080) and chapter thumbnails (480×300) | ~160 KB / 12–33 KB |
| `snake-dark.jpg` / `snake-light.jpg` | Posters (1600×1000) | ~285 KB |
| `snake-dark.mp4` / `snake-light.mp4` | Gameplay loop, same path in both themes (1280×800, 30 fps, 9 s) | ~1.8 MB |

Budgets are enforced by `tests/content/play-media.test.ts`: posters < 350 KB, the GOLDENLINE
trailer < 6 MB, Snake and LITTLEBIG clips < 2 MB, the LITTLEBIG trailer < 16 MB (chapter thumbnails < 60 KB).

## Ground rules

- **Dev server:** run `pnpm dev`, and pass `--url http://localhost:<port>` if it isn't on 3000. The
  scripts drive headless Chromium with real WebGPU (Metal ANGLE); LITTLEBIG's use WebGL2 on the same
  Metal ANGLE backend.
- **One GPU render at a time.** Two WebGPU renders sharing the GPU lose the device mid-sequence (it
  happened on the first pass).
- **Render each sequence whole, as the only job in a fresh boot.** Snake and GOLDENLINE aren't
  bit-identical across browser sessions:
  - GOLDENLINE's wet-sand and foam state advances per rendered frame, and a second job in the same
    boot inherits the first one's state.
  - So never splice a partial re-render onto existing frames.
  - LITTLEBIG re-derives its world from the sim time at every `setTime`, so one boot can render the
    pre-roll and then the dive (see its notes). It still renders every frame of a sequence in
    order: the sims step forward from the start time.
- **Keep `settle: 20`** (GOLDENLINE). Every frame gets 20 frozen rAFs, so TAA converges and the
  wet-sand look matches between frames.
- **Write frames as JPEG q95** (1280×800). The PNGs come to about 1.6 GB per pass.

## GOLDENLINE

Each scene is **165 frames**: 15 handle frames + 135 core + 15 handle, with the sim stepped
1/30 s per frame. The camera keyframes are interpolated linearly through all 165 frames, so motion
never stops inside a handle. The job files are in `scripts/play-media/jobs/`.

| Scene | Helper | Job | Sim time (frame 0 → 164) | Camera |
|---|---|---|---|---|
| crash | `gl-media-crash.mjs` | `jobs/crash.json` | 40.20 → 45.67 (core 40.70 → 45.17) | Reef flat looking down the line, FOV 45. Trucks ~5 m while panning 10° (yaw 164.2° → 174.2°) with the peel. |
| ride | `gl-media-ride.mjs` | `jobs/ride.json` | 40.73 → 46.20 (core 41.23 → 45.70) | The player's own first-person camera on the game's scripted demo ride (`surf.demo = 1`). Bottom turn into the barrel, with the pier in the opening. |
| ashore | `gl-media-ashore.mjs` | `jobs/ashore.json` | 42.25 → 47.72 (core 42.75 → 47.22) | Low (0.9 m above sand), native FOV 72. Slides ~4 m toward the pier while panning 7° toward the sun. |

```bash
G=/tmp/gl-media   # any scratch dir with ~200 MB free
for s in crash ride ashore; do
  mkdir -p $G/v2-$s
  node scripts/play-media/gl-media-$s.mjs --url http://localhost:3000 --size 1280x800 --q ultra \
    --jobs scripts/play-media/jobs/$s.json --out $G/v2-$s/
done
# The crash and ride helpers write to <out>/frames/. The ashore helper writes to <out>/frames_v3/,
# so rename that folder to frames/.
python3 scripts/play-media/gl-assemble.py $G public/play/goldenline.mp4 --kbps 3100 --denoise 2:1.5:3:2.5
```

**Notes:**
- **Assembly:** `gl-assemble.py` crossfades each scene's tail handle into the next scene's head
  handle (`xfade`, 0.5 s). Ashore's tail fades into crash's head, so the last frame leads into the
  first. It converts the full-range JPEG frames to limited-range yuv420p, then does a two-pass H.264
  encode.
- **Why the denoise:** `--denoise` strips the game's film grain before encoding. The grain otherwise
  eats the bitrate the ride's spray needs. At 3100 kb/s the denoised ride is close to a CRF 16
  master, while the plain encode smears the reef and spray.
- **Cover still:** `goldenline.jpg` is the v1 crash camera, a static `from (-105, 2.5, -75)` →
  `lookAt (-126, 2.5, 46)` at FOV 45, captured at t = 42.05 and 1600×1000. The original was
  `t 39.6`, `advance 2.25`, then frame 4 of a 0.05 s `seq`. A one-job `gl-media.mjs` run with
  `{"from":[-105,2.5,-75],"lookAt":[-126,2.5,46],"absY":true,"fov":45,"t":39.6,"advance":2.25,
  "seq":5,"interval":0.05}` reproduces it; keep frame 4. Then save it as JPEG q90, progressive, under 300 KB.
- **Probes:** `gl-probe.mjs` (a breaking timeline along the reef), `gl-map.mjs` (an ASCII map of
  where breaking happens) and `gl-terrain.mjs` (sand height) help when re-framing a scene after
  the ocean changes.

## LITTLEBIG

The clip is the game's own **scripted dive** (`camera/dive.ts`, driven through `window.__littlebig.dive`
in `?shot=1` mode): 301 frames at 30 fps from the top-down globe, tipping onto the planet's limb,
through the cloud layer's white-out, swooping in down a downtown street to land at eye height on the
pavement. Each frame advances the sim by 1/30 s, so cars, people, planes, balloons and clouds move
with the camera. Then the camera holds on the landing for 2 s (life going on), and the last 0.5 s
of the hold dissolves into a 15-frame pre-roll on the opening globe, so the clip loops.

**Start time `t0 = 11`.** The traffic and people sims are chaotic (±0.25 s of start time gives a
different landing), so `t0` is picked by `littlebig-scan.mjs`. It runs the whole dive plus the hold
from each candidate start and scores the landing and hold: how big the biggest car or person gets
in frame, how close a car comes, whether anyone walks at the lens, how much life is in view, and how
close the camera passes over anyone on the low swoop (from 0.6 of the way down, where a head would
poke into the frame's edge). The chosen start is then checked by eye on a contact sheet. `t0 = 11` lands on
a sunlit corner, with a taxi and a blue car pulling away across the junction and a parent and
child walking up the pavement ahead. Nobody is near the lens, and the low swoop passes nobody.
**Re-scan whenever traffic, people, the plan or the dive change.**

| Frames | Sim time | What |
|---|---|---|
| `pre_000…014` | 10.50 → 10.97 | Pre-roll: the camera at the dive's start (u = 0), for the loop dissolve |
| `f_000…300` | 11.00 → 21.00 | The dive (identical to `littlebig-shot.mjs --dive 301 --t 11`) |
| `f_301…360` | 21.03 → 23.00 | Hold on the landing; `f_346…360` dissolve into `pre_000…014` |

```bash
L=/tmp/lb-media   # ~60 MB
node scripts/play-media/littlebig-scan.mjs --t0 0 --t1 14 --dt 0.25 --hold 2 > $L-scan.txt   # ~4 min; lowest `bad` first in the last line
node scripts/play-media/littlebig-clip.mjs --t0 11 --hold 2 --out $L/clip/                    # ~50 s, JPEG q95
python3 scripts/play-media/snake-sheet.py $L/sheet.jpg 8 230 $(ls $L/clip/f_*.jpg | awk 'NR%6==1')   # READ it
python3 scripts/play-media/littlebig-assemble.py $L/clip public/play/littlebig.mp4 --kbps 1300 --start 66
```

**Notes:**
- **Same world in both renders.** The clip helper renders the pre-roll first, then calls `setTime(t0)`
  for the dive. A time jump re-places people and traffic from `t` alone, so the dive is exactly
  the one the scan scored. The one exception is a dog's gait phase, which isn't reset.
- **Encode:** `littlebig-assemble.py` crossfades `f_346…360` into `pre_000…014` (`xfade`, 0.5 s).
  It converts the full-range frames to limited-range yuv420p and runs a two-pass x264 encode
  (veryslow, `-tune animation`, High) with `+faststart`.
- **The clip opens on the poster frame.** `--start 66` rotates the finished loop so playback starts at
  dive frame 66, the cover still. The poster then fades into the identical video frame instead of a
  dark globe, and the loop point (frame 65 → 66) is an ordinary consecutive step of the dive. The
  street → globe dissolve sits about 9.8 s in.
- **Bitrate:** at 1300 kb/s the clip is ~1.9 MB. CRF 26 comes out at ~3.7 MB, because the moving
  city is full-frame detail: at CRF 26 the dive costs ~300–440 KB/s against ~100 KB/s for the hold.
  The frames are clean (no grain), so there's no denoise. At 1:1, the ink lines survive with a
  slight softening.
- **One clip for both themes.** The game has no light or dark mode, and its golden-hour street and
  deep-blue globe read on both page backgrounds (the card's frame and hover overlay are the theme's).
- **Cover still:** dive frame 66 (sim t = 13.2, ~145 m up: the planet's limb all round,
  downtown rising on the curve, clouds and a hot-air balloon). Re-render it losslessly at the poster
  size with `littlebig-clip.mjs --t0 11 --hold 0 --pre 0 --only 66 --fmt png --size 1600x1000 --out $L/poster/`,
  then save it as a progressive JPEG, q92 with 4:2:0 chroma (PIL `quality=92, progressive=True,
  optimize=True, subsampling=2`), which comes to ~305 KB.
- **Why the planet and not the landing for the poster:** the poster is what reduced-motion visitors,
  Low Power Mode and the first paint see. A tiny planet with a city on its curve is the game's idea
  in one frame, and it reads at card size. The landing street could be any cartoon city, and its
  people are a few pixels tall on a card. The video also opens on the globe, so the poster fades
  into a planet, not a jump cut.
- **The landing frame is clean on its own.** The people sim makes way for a camera settling onto
  the pavement (`people/sim.ts` `LensWatch`), so nobody walks up to the lens and stands in it.
  Before that, a start time like `t0 = 0` landed a face 1.1 m from the lens.

### Trailer footage (littlebig-cine.mjs)

`scripts/play-media/littlebig-cine.mjs` renders a shot from a JSON job file, frame by frame, like
the clip helper. The camera is either the game's own (explore, a ride's chase, the bird's chase) or
a free cinematic camera, `window.__littlebig.cine` in `core/debug.ts`. The cine pose replaces the
*rendered* camera after the camera system runs each frame, in every mode. The game camera, a ride
and the bird carry on underneath under their own physics, and get their own pose back before the
next camera update. `ctx.view`, near/far and the lens follow the cine pose, so LOD, culling, the
people's lens watch and town life all see the camera you film with. `where(id)` gives any
Trackable's world pose (`car:3`, `bus:200`, `person:5012`, `ferry:0`, `plane:1`, `station:0`,
`trackables()` lists them) or the bird's (`'bird'`). `geo(lat, lon, alt)` turns lat/lon into a world
point `alt` m over the terrain or sea. The script header documents every job field.

```json
{
  "t0": 189.2, "seconds": 3, "handles": 6,
  "camera": { "lag": 0.4, "keys": [
    { "t": 0, "eyeFrom": { "id": "car:237", "offset": [2.5, 3, 8] }, "lookAt": "car:237", "lookOffset": [0, 0.4, -3], "fov": 40 },
    { "t": 3, "eyeFrom": { "id": "car:237", "offset": [-2, 1.6, 5] }, "lookAt": "car:237", "lookOffset": [0, 0.4, -3], "fov": 40, "ease": false }
  ] }
}
```

```bash
node scripts/play-media/littlebig-cine.mjs shot.json --draft --out /tmp/shot-draft/   # 960x600, every 2nd frame, seconds
node scripts/play-media/littlebig-cine.mjs shot.json --out /tmp/shot/                 # 1920x1200, dpr 2, blur 8
```

- **Output:** `f_000.jpg…` (JPEG q95, the WebGL canvas only, no HTML overlays; `f_<handles>` is
  frame 0), `cine.json` (per frame: the sim time, the eye and its clearance), `sheet.jpg` and
  `preview.mp4`. Renders are deterministic: the same job gives byte-identical frames.
- **Camera keys:** the eye comes from `eye` / `eyeGeo` / `eyeFrom` (an offset `[right, up, back]` in
  a moving target's level frame), and the look from `look` / `lookGeo` / `lookAt`. Each runs on a
  centripetal Catmull-Rom spline timed by a monotone cubic, so speed is continuous through keys. The
  first and last keys ease to a stop unless `"ease": false`, and the move then carries on through the
  handles. A moving target's heading is smoothed over `camera.lag` s (default 0.3), so a turning car
  swings the camera round instead of snapping it.
- **Defaults and cost** (M-series, 1920x1200, one Chromium): `dpr 2` (supersampled, downscaled with
  the canvas's high-quality filter) and `blur 8` (8 sub-frames over a 180° shutter, summed exactly)
  take 0.4–0.7 s per frame. `dpr 2 blur 4` takes ~0.25 s, `dpr 1 blur 1` ~0.03 s.
- **The cloud layer is 36–48 m.** An eye crossing it, or flying into a puff, plays the game's
  falling-through-the-clouds overlay (cartoon puffs fill the frame and part). That works as a
  transition. Otherwise keep the eye out of the band. The overlay moves too fast for motion blur
  (it steps visibly), so render it with `--blur 1`.
- **Nothing stops the cine eye going through a roof.** The script prints `WARNING` ranges for frames
  where the eye is inside geometry, or within 0.5 m of it: terrain, the capital's roofs, lamp heads
  and crowns, and the towns' roofs. Trees and vehicles aren't checked. Fix the keys and re-draft.
- The near plane is 3 % of the height over the terrain (0.05–30 m). To film something a few
  metres off from high up (the bird at 100 m), cap it with `camera.near` (e.g. 0.3).
- `setup` runs hook calls before frame 0 (`setView`, `fly`, `ride`, `birdInput`, `advance`…). An
  `advance` there moves frame 0 later than `t0`, and `cine.json` records the real times.
- A straight-down look needs a key `up`, the direction for the frame's top. The default up is the
  radial up at the eye.
- **Lamps coming on:** the setup call `["sunClock", pivot, rate]` runs the sun (light, sky, night
  factor, lamps, windows) at `rate` × sim time about sim time `pivot`, while traffic and people keep
  real time. For example, `["sunClock", 76.67, 3.1]` takes dusk from golden light to blue hour in
  4.5 s. A rate of 0 freezes the sun at `pivot`. A rate of 1 resets it.
- **Trailer params** (job `params`): `townsfolk.popLift` (m) lets the towns' people show from
  higher up, and `ocean.glint: 0` hides the toon sun disc on the sea, which reads as a lens smudge
  when it slides through a descent.
- **Traffic depends on the warm-up, not on `t0`.** A time jump replays the region's traffic for
  40 s plus `min(t, 90)` s from a reset, so after `setTime(t ≥ 90)` and a setup `advance` of `w` s,
  frame 0 holds the traffic of `130 + w + handles / fps` s from the reset. Time a bus or a junction
  with the warm-up length, and the light with `t0`.
- **Same light, other extras:** the sun repeats every 480 s and the clouds every 1440 s (0.25°/s),
  so `t0 + 480 k` keeps the light and moves the clouds 120° per day, and `t0 + 1440` keeps both.
  The towns' people are placed from the absolute time, and cars wait for them at crossings, so
  either shift also changes which cars stop or park. It's a cheap way to re-roll a busy street.
- **`hide`** (job field) hides scene objects by name for the whole shot, e.g.
  `["air:contrails", "lighthouse beam"]`: long lenses and timelapses turn both into scratches.
- **Exact curves:** give a key per frame (`t = i / fps`) to drive the camera from your own function
  (a log-space altitude, an orbit). Sparse keys put a small speed ripple at every key.
- **Timelapse:** `"fps": 10` with `seconds` ×3 renders frames 0.1 s of sim apart (3× speed when
  played at 30 fps). Rebuild `preview.mp4` at 30 fps afterwards.

### The trailer (littlebig-trailer.mp4)

One day on the planet in six beats, dawn to night: the planet and the plunge from orbit, the town
square, bird flight, a golden-hour run through the capital, a car's turn signal at dusk, and the
night globe under the title. The twelve shots are jobs in `scripts/play-media/littlebig-trailer/jobs/`
(about 2,900 frames, half an hour of rendering). `cut.py` cuts them into one clip per beat. The titles, the score
and the export come from a Motion film on claude.ai ("LITTLEBIG trailer", the owner's account), which
plays the six clips under toy-box captions.

```bash
T=scripts/play-media/littlebig-trailer; R=/tmp/lb-trailer
for j in $T/jobs/*.json; do node scripts/play-media/littlebig-cine.mjs $j --out $R/$(basename $j .json)/; done
node scripts/play-media/littlebig-cine.mjs $T/jobs/a2-descent.json --only 112-138 --blur 64 --out $R/a2-wipe/
cp $R/a2-wipe/f_1[1-3]*.jpg $R/a2-descent/          # the cloud wipe steps at blur 8; 64 sub-frames smear it
python3 $T/tiltshift.py $R/a3-square $R/a3-square-tiltshift   # miniature falloff outside y 340–860
python3 $T/cut.py $R $R/clips                       # planet, town, bird, city, blinker, night (.mp4)
```

- **The film:** upload the six clips to the film as assets (one `kit.video` per scene), then press
  Export on its page. Offline, the player's own `index.html#tools` entry does the same export:
  `window.__animation.exportFilm({ height: 1080, supersample: 2 })` returns a handle that
  `window.__animation.read(handle, offset, length)` pages out as base64. Use system Chrome for that,
  because Playwright's Chromium can't decode the H.264 clips. Keep the film's type in the faces the
  player ships, because the offline entry fetches no fonts.
- **For the site:** the export is about 24 MB at 6.4 Mbit/s. Encode it twice with x264 at 3900k
  (`-preset slower -maxrate 7000k -bufsize 8000k`, audio copied) for about 15 MB. The poster is the
  opening title at 0.6 s. The chapter thumbnails are centre 16:10 crops scaled to 480×300 (`-q:v 4`)
  at 3.4, 12.9, 17.8 and 23.75 s, past each beat's caption. The chapter times live in `content/play.ts`.
- **Grades** live in `cut.py`. The dawn is warmed toward amber with the night side kept blue, the dusk
  shots get a slight warm contrast, and the night's mid-tones are lifted.

## Snake

The renderer is frozen, and the **real pure engine** (`components/snake/engine/`, bundled with
esbuild) is stepped at 60 Hz with a scripted autopilot. Every second step is drawn, so the 30 fps
timing is exact.
- **Path:** seed **246**, sim time 18.0–27.0 s: three eats, the last a golden one. Both themes
  follow the identical path.
- **Autopilot** (`snake-autopilot.cjs`): it chases the golden food, else the nearest food. It adds
  a slow wobble for S-curves, keeps off the rock ring and its own body, and caps its turn rate.
- **Window choice:** `snake-planner.mjs` ranks seeds and windows by eats and by how well the loop
  seam matches.

```bash
E=$(ls -d node_modules/.pnpm/esbuild@*/node_modules/esbuild | head -1)/bin/esbuild
ENTRY="export * from './components/snake/engine/engine'; export * from './components/snake/engine/math'; export * from './components/snake/engine/types';"
echo "$ENTRY" | $E --bundle --loader=ts --format=iife --global-name=__eng --outfile=scripts/play-media/snake-engine.iife.js
echo "$ENTRY" | $E --bundle --loader=ts --format=esm --outfile=scripts/play-media/snake-engine.mjs
S=/tmp/snake-media
for theme in dark light; do
  node scripts/play-media/snake-media.mjs --url http://localhost:3000 --theme $theme --seed 246 --from 17.4 --to 27.0 --out $S/raw-$theme
  python3 scripts/play-media/snake-assemble.py $S/raw-$theme $S/loop-$theme 18 270   # 0.6 s crossfade loop, Lanczos → 1280×800
  ffmpeg -framerate 30 -i $S/loop-$theme/%04d.png -c:v libx264 -preset veryslow -tune film -b:v 1650k -maxrate 2600k -bufsize 3300k -pix_fmt yuv420p -profile:v high -pass 1 -an -f mp4 /dev/null
  ffmpeg -framerate 30 -i $S/loop-$theme/%04d.png -c:v libx264 -preset veryslow -tune film -b:v 1650k -maxrate 2600k -bufsize 3300k -pix_fmt yuv420p -profile:v high -pass 2 -an -movflags +faststart public/play/snake-$theme.mp4
done
```

- **Posters:** take raw frame 206 (clip t = 6.27 s, the snake curling at the bottom of its "?"
  groove beside the golden column). Re-capture it losslessly with
  `snake-media.mjs … --fmt png --only 206 --out $S/poster-$theme`, then save it as a progressive
  JPEG at the highest quality that stays under 295 KB.
- **Bundles:** the engine bundles `scripts/play-media/snake-engine.*` are generated and gitignored.
- **Theme parity:** effects timed by the renderer's own clock (the golden-gem pulse, stars, sand
  glints) can be out of phase between the themes. Path, grooves, eats, particles and camera are
  identical.
