# vfx/ — ambient life and atmosphere (B2)

`spray/` is A8's shared spray pool (driven by the ocean system). The rest is B2:

| file | what |
|---|---|
| `index.ts` | the `vfx` system: params (`vfx.birds`, `vfx.crabs`, `vfx.mist`, `vfx.mistStrength`), the sim clock as a 1-element uniform array (zero-alloc) |
| `birds.ts` | 9 gulls on lazy loops along the reef edge: real geometry (spindle body, M-shaped wings, tail), one instanced draw, flight path, coordinated-turn bank and wing-beat bursts all in the vertex stage; backlit feather glow |
| `crabs.ts` | 16 ghost crabs in the damp band (terrain height 0.6-1.35 m): CPU sim in a Float64Array (idle, sideways dashes, bolt from a walker within 3.2 m), one instance buffer upload, leg gait in the vertex stage |
| `mist.ts` | salt-mist curtains over the shore break and the reef's impact zone: camera-facing, two texture-noise taps drifting with the breeze, premultiplied forward scattering (gold when backlit), fades inside 16 m and at the curtain edges; writes zero to the normal/velocity/SSR targets |

Shots: `vfx-birds`, `vfx-crabs`, `vfx-mist`. All pipelines warm through the engine's `warmPipelines()`.
