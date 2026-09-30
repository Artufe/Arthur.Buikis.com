# GOLDENLINE — third-party assets

Every vendored asset, its source and licence. CC0 only. Files live in `public/goldenline/<area>/`.

| File | Area | Source | Licence | Notes |
|---|---|---|---|---|
| `wood_albedo.webp`, `wood_normal.webp`, `wood_ord.webp` (1024×4096) | pier | Poly Haven "Rough Wood" (https://polyhaven.com/a/rough_wood), 2K JPG diffuse / normal (GL) / roughness / AO / displacement | CC0 | Resampled and quilted along the grain into a 0.5 m × 4.1 m strip tileable both ways, cross-grain saw cuts cloned out (`components/goldenline/pier/tools/quilt-wood.py`); `ord` packs roughness, AO, height. 2.9 MB total. |

- [player] No third-party assets: board, wax, water beads, skin relief and limb meshes are all generated at boot (`components/goldenline/player/tex.ts`, `body/`). `public/goldenline/player/` is unused (0 MB of the 6 MB budget).
- [beach] No third-party assets: sand ripples, grain, swash marks, macro variation, reef mask, far heightfield, palms, plants and wrack are all generated at boot (`components/goldenline/beach/`). `public/goldenline/beach/` is unused (0 MB of the 12 MB budget).
