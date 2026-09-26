# GOLDENLINE — decisions

One line per deviation from BRIEF.md, prefixed with the area. Newest at the bottom.

- [orchestrator] Engine is three.js 0.186 `WebGPURenderer` + TSL: already a site dependency (the snake game ships it), so no second engine in the bundle; its TSL compute, `RenderPipeline`, TRAA/GTAO/SSR/bloom and `CSMShadowNode` cover the brief. Babylon would add several MB for no visual gain.
- [orchestrator] TypeScript + Next.js/Turbopack instead of JS + Vite: the demo lives inside the site (palette → floating window → `/surf`) and must pass the site's CI.
- [orchestrator] Performance verified on an Apple M3 against a scaled proxy (1280×720 `high` ≤ 22 ms median, no frame > median + 4 ms); 5070 Ti numbers recorded later on the target PC.
- [orchestrator] The base heightfield (land + seabed) is one analytic CPU function baked to a 1 m R32F texture at boot; GPU owners add fine detail on top. One source of truth for player collision, shoaling and terrain meshes.
- [orchestrator] The nav bar is hidden on `/surf` so the demo owns the viewport; the only chrome is a "← back to site" link shown while the pointer isn't locked.
