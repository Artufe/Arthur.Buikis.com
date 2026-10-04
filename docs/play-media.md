# /play media: how the clips and posters are made

The `/play` page and the home Play strip show looping clips rendered **from the games themselves**,
frame by frame. There's no screen recording and no parameter tweaks. This file is the recipe to
regenerate them when either game changes. The scripts live in `scripts/play-media/` and run against
the dev server.

| File (`public/play/`) | What | Size |
|---|---|---|
| `goldenline.jpg` | Cover still: a barrel throwing spray, pier on the horizon (1600×1000) | ~265 KB |
| `goldenline.mp4` | Trailer: crash → ride → ashore, 0.5 s crossfades, seamless loop (1280×800, 30 fps, 15 s) | ~5.9 MB |
| `snake-dark.jpg` / `snake-light.jpg` | Posters (1600×1000) | ~285 KB |
| `snake-dark.mp4` / `snake-light.mp4` | Gameplay loop, same path in both themes (1280×800, 30 fps, 9 s) | ~1.8 MB |

Budgets are enforced by `tests/content/play-media.test.ts`: posters < 350 KB, the GOLDENLINE
trailer < 6 MB, Snake clips < 2 MB.

## Ground rules

- **Dev server:** run `pnpm dev`, and pass `--url http://localhost:<port>` if it isn't on 3000. The
  scripts drive headless Chromium with real WebGPU (Metal ANGLE).
- **One WebGPU browser at a time.** Two renders sharing the GPU lose the device mid-sequence (it
  happened on the first pass).
- **Render each sequence whole, as the only job in a fresh boot.** Neither game is bit-identical
  across browser sessions:
  - GOLDENLINE's wet-sand and foam state advances per rendered frame, and a second job in the same
    boot inherits the first one's state.
  - So never splice a partial re-render onto existing frames.
- **Keep `settle: 20`.** Every frame gets 20 frozen rAFs, so TAA converges and the wet-sand look
  matches between frames.
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
