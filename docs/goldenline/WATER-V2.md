# GOLDENLINE — water v2 (rework plan)

User (2026-09-30): *"Simplify the whole water. It's very buggy. Rework it from the ground up. The main
complaint: the water breaks near the shore and then does not follow through with the momentum. It
breaks, then hits shore and stops. Also the water is buggy; not visually pleasing due to the bugs."*

Checkpoint before any of this: `8f2ebb9` (origin/feat/goldenline).

## Audit (what is on screen now)

Evidence: shots in the session scratch (`audit/`), the 3/4 shore sequence `shore34` and the reef
sequence `reef` (0.5–0.6 s steps).

**Why the shore stops.** Three separate systems play one wave, and none of them carries momentum
onto the sand:

1. The lagoon swell is a Gerstner train whose amplitude saturates at γ·h, so by construction it
   flattens to nothing at the waterline: a glassy hump rolls in and vanishes.
2. The shore breaker (shore ray fan + 3 tracker slots + ribbon layers) plays a canned profile,
   and *fades out over its last metres* before the waterline ("the swash takes over").
3. The swash is a separate 1-D ballistic model that launches only when a bore is past impact + 1,
   still active, and within 3.5 m of the ray end. Often it doesn't fire; when it does, a white
   sheet pops onto the sand with a new, unrelated speed, and ends in straight cuts.

Raising `breaking.gammaShore` breaks waves closer but stops the swash firing at all (checked): the
coupling is a set of thresholds, not physics.

**Visible bugs**

| # | where | what |
|---|---|---|
| S1 | shore | swash sheet pops in detached from the wave; square-cut ends; staircase patches (`water-shallows`) |
| S2 | shore | the wave reaches the beach as a smooth hump and flattens; no crash, no run-up momentum |
| S3 | lagoon | diagonal dark seams where shore ribbons blend into the surface |
| R1 | reef bore | the whitewater shell reads as an opaque beige clay mass up close |
| R2 | reef bore | a hard dark band on the water ahead of the bore (the surface dropped under the ribbon) |
| R3 | reef | after a time jump, the first frames show whitewater filling the camera |
| R4 | near water | radial glitter streaks toward the sun |
| R5 | reef | breaker sections begin and end abruptly (an extruded tube with cut ends) |

## Architecture after the rework

- **Open sea (kept):** FFT wind sea + clipmap surface + baked swell trains. They work; bugs are fixed
  in place.
- **Reef breaker (kept, debugged):** surfing (B1) rides its profile, peel and barrel. Rewriting it
  would break the ride, so its visual bugs (R1–R5) are fixed in place instead.
- **Surf zone + shore (rebuilt): one shallow-water simulation**, `ocean/surfzone/`. It replaces the
  shore ray fan, the tracker's shore slots, the shore ribbons, the swash model and its sheet mesh.
  - GPU, world-aligned grid over the whole beach: x −46 … 22 m (0.25 m cells), z −260 … 180 m
    (0.5 m cells). Nonlinear shallow-water equations, staggered grid, Stelling–Duinmeijer
    momentum-conservative upwinding (captures bores at the right speed), wet/dry by upwind face
    depths, Manning friction. Waves steepen into bores, the bores run up the beach face with
    their own momentum, stall and drain back. No thresholds.
  - Driven at its seaward edge by the swell trains (a 10 m relaxation zone toward the incident
    wave, which also absorbs what the beach reflects). Sets and lulls arrive for free.
  - Rendered by the ocean mesh itself (a surface hook replaces the swell height inside the
    domain), so there is one water surface from the reef to the top of the run-up. On dry
    cells the surface tucks under the sand.
  - Foam: generated where the flow breaks (steep converging fronts), carried by the simulated
    velocity (runs up and drains back with the water), aged, fed to the water material's
    foam layer.
  - Wet sand: the state wets texels where the simulation has water (replaces `ocean.gpu.swash`).
  - CPU: a small async readback around the camera feeds `ocean.sample()` (wading, floating, the
    pier pilings) and spray at breaking fronts.
  - A pure CPU copy of the scheme (`surfzone/scheme.ts`) is unit-tested: mass conservation, a dam
    break against the analytic bore speed, run-up on a slope, positivity at wet/dry fronts. The GPU
    kernel mirrors it line by line.

## Tasks

Phase 1 — surf zone (the main complaint)

1. `scheme.ts` + tests: the 1-D/2-D scheme on the CPU, the reference for the kernel.
2. Grid, bed bake, solver kernels, relaxation forcing, end sponges (`surfzone/index.ts`, `kernels.ts`).
3. Render: surface hook (height, normals, dry tuck), depth + foam into the water material.
4. Foam: generation, advection, age; the water material reads it inside the domain.
5. Wet sand from the simulated depth.
6. CPU readback → `ocean.sample()` in the domain, spray at fronts, pier water-fx.
7. Remove what it replaces: shore fan, shore slots and ribbons, swash + sheet, their params.

Acceptance: in the 3/4 shore view the waves steepen, break into a white bore that runs up the
beach face and drains back, with no pop-in; wet sand follows the run-up; stable for a 10-min run
(no NaN, no blow-up at wet/dry fronts); GPU ≤ +1 ms at 1440p on the M3; no per-frame allocation.

Phase 2 — bug sweep (R1–R5, S3 if it survives Phase 1), each with a before/after shot.

Phase 3 — regression shots, perf, tests, docs (READMEs, DECISIONS), commit + push.

## Status

- [x] **Phase 1 — surf zone** (tasks 1–7). `ocean/surfzone/` (README there). Waves steepen, break into
  bores that run up the beach with their own momentum and drain back; wet sand follows the water;
  stable over a 10-minute run; 0.74 ms GPU at 60 fps; the shore fan, shore slots, ribbons and swash
  are gone. Tuning found on the way (DECISIONS.md `[surfzone]`): incident volume flux, lagoon gain,
  conservative breaking viscosity with a depth ramp, infiltration, vertex band-limiting.
- [ ] Phase 2 — bug sweep (R1–R5).
- [ ] Phase 3 — regression, perf, commit.
