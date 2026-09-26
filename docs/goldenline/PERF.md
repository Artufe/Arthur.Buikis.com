# GOLDENLINE — performance

Target: 90 FPS sustained at 2560×1440 on an RTX 5070 Ti (11.1 ms), 60 FPS floor, no frame above
median + 4 ms. Dev proxy: Apple M3 (base), 1280×720, preset `high`, median ≤ 22 ms.
Measure with `node scripts/goldenline-shot.mjs --shot <name> --perf 10 --size 1280x720`.

## Budget (5070 Ti ms)

| System | Budget | M3 measured | 5070 Ti measured | Notes |
|---|---|---|---|---|
| atmosphere (sky, CSM) | 0.5 | | | |
| ocean (FFT + clipmap) | 1.0 | | | |
| water shading | 1.6 | | | |
| breaking waves + whitewater | 1.8 | | | |
| beach + sand + far field | 1.1 | | | |
| pier | 0.6 | | | |
| surface state | 0.4 | | | |
| player + board + arms | 0.6 | | | |
| surf (ride, wake, fans) | 0.8 | | | shares spray |
| ambient vfx | 0.3 | | | |
| post chain | 1.9 | | | TRAA, GTAO, SSR, DOF, MB, bloom, AgX, grain, sharpen |
| **total / headroom** | 10.6 / 0.5 | | | |

## Log

- [orchestrator] Base with stubs, `beach-sun` 1280×720 high on M3: median 8.3 ms, 1% low 9.2 ms, 6 draws, 0.30 M tris.
