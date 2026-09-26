# GOLDENLINE — brief

> **Site-integration amendments (these override the brief below wherever they conflict).**
>
> GOLDENLINE ships *inside* Arthur Buikis's personal site (this repo) as an easter-egg game: the
> command palette's **`go surfing`** command opens it in a floating window over whatever page you
> are on, and the window's ↗ button expands it to the full-viewport route **`/surf`**.
>
> - **Stack:** TypeScript (the repo's language — not JS + JSDoc), bundled by Next.js 16 / Turbopack
>   (not Vite). The site is a static export: everything is client-side, loaded lazily with
>   `next/dynamic({ ssr: false })`, and nothing of the engine loads until the game is opened.
> - **Engine: three.js 0.186 `WebGPURenderer` + TSL** (already a site dependency; see DECISIONS.md).
>   Import only from `three/webgpu`, `three/tsl` and `three/addons/*` — never plain `three`, which
>   would load a second copy of the library. Shaders are TSL (compiled to WGSL); raw WGSL via
>   `wgslFn` is fine where TSL can't express something.
> - **No fallbacks** still holds: `WebGPURenderer` silently falls back to WebGL2, so the core
>   rejects that backend and shows one line of text instead.
> - **It must be a good guest.** Every system disposes all GPU resources in `dispose()` — the
>   window mounts and unmounts repeatedly. Nothing may leak into, restyle or slow down the rest
>   of the site. Assets live in `public/goldenline/` (budget: 40 MB total, lazy-loaded).
> - **Code lives in** `components/goldenline/` (one directory per system), `app/surf/page.tsx`,
>   `lib/surf-bus.ts`. Docs and milestone screenshots live in `docs/goldenline/`.
> - **The site's CI must stay green:** `npx tsc --noEmit`, `npx vitest run` and `npx next build`.
>   (Still: no test suite for the demo itself.)
> - **Dev machine vs target:** development happens on an Apple M3 (base, 8 cores, 16 GB).
>   Quality screenshots are always taken at 2560×1440. Performance is verified against a
>   **scaled proxy budget**: at 1280×720, preset `high`, median frame ≤ 22 ms on the M3 and no
>   frame above median + 4 ms. The 90 FPS @ 1440p RTX 5070 Ti numbers are recorded later on the
>   target PC. Zero-allocation and warm-up rules are enforced strictly regardless.
> - **Controls in a web page:** clicking the canvas takes pointer lock; Esc releases it (and in
>   the floating window a second Esc closes it). The loading screen may show a one-line key legend
>   before play starts — that is not a HUD. After that: nothing on screen, ever.
> - **Reduced motion** (`prefers-reduced-motion`, exposed as `ctx.reducedMotion`): no head bob,
>   no camera shake, no FOV kick; everything else unchanged.

---

GOLDENLINE — Tech Demo · Implementation Brief

You are the only engineer and technical artist on a real-time graphics tech demo. Build all of it. This document is the spec, the art direction and the acceptance criteria.

0. Prime directive

Visual quality is the product. There is no gameplay loop, no progression and no UI to design around. A player will load this at golden hour on a tropical reef beach. They will walk the sand, stroll out along the pier, paddle into the lineup, catch a head-high wave and ride it toward the pilings. Then they will either think "this is AAA" or close the tab. Everything below serves that one judgment.

Two rules override everything else in this document:

If a requirement here conflicts with making the demo more beautiful, break the requirement. Note the deviation in DECISIONS.md with a one-line rationale. You may change scope, swap techniques or drop any feature that isn't paying for its pixels.

Anything that looks low-poly, flat-shaded, untextured, placeholder or like an indie prototype is a defect, not a step on the way. If you can't make something look finished, cut it from the frame rather than ship it rough.

Do not stop at "it works." Stop when every frame you capture looks polished, cohesive and ready for production.

1. Stack and hard constraints

Language    Modern JavaScript (ES2023 modules). JSDoc types encouraged; no TypeScript build step.
Engine      Your choice, WebGPU only. Candidates: Babylon.js (WebGPU engine, WGSL / NodeMaterial), three.js (WebGPURenderer + TSL), or raw WebGPU. Before you write code, pick the one that gives you the most control over custom water shading, compute passes and render-target work. Record the choice and why in DECISIONS.md.
Bundler     Vite
Target      Chrome stable on Windows 11, RTX 5070 Ti, 2560×1440
Frame target    90 FPS sustained. 60 FPS floor.
Frame time  No frame more than median + 4 ms after the loading screen closes.

No fallbacks: no WebGL path, no mobile path, no feature-detection branches. If navigator.gpu is absent, show a single line of text and stop. Do not spend a minute on compatibility.

Assets. Generate procedurally wherever that gives a better or more controllable result: ocean spectra, bathymetry, sand ripples, foam patterns, noise and most masks. Use free CC0 assets where hand-authored data wins, such as Poly Haven HDRIs, sand, weathered-wood and coral/rock PBR scans, and ambientCG detail textures. Vendor everything into the repository; no runtime CDN fetches. List every third-party asset and its licence in ASSETS.md.

2. Setting and art direction

A tropical reef beach, facing west. It is golden hour, frozen at one perfectly tuned sun angle. The sun sits about 8–14° above the ocean horizon, slightly off-axis from the main peak. This gives three things:

- Seen from the beach or the lineup, wave faces are backlit. The thin lip glows gold-green as sunlight passes through it. This is the money shot. Build the lighting around it.
- From the sand, the pier silhouettes against the sun, and its reflection runs across the wet sand.
- The pier throws long shadows over the water and the sand.

The water is very clear. It runs from pale turquoise over the white-sand shallows, through darker teal-and-ochre patches over the reef, to deep sapphire beyond the break. White coral sand, a few palms leaning off the dune line, a low volcanic headland at one end for scale. A light offshore breeze feathers spray off the lips.

The beach is nearly empty: the player, plus ambient life that costs little and adds a lot. Seabirds gliding along the break, palm fronds moving, perhaps ghost crabs darting on the wet sand. No other humans.

3. Systems

3.1 Ocean and waves

A flat plane or a tiled normal map will kill this demo. The ocean needs real form at every scale, and the waves must break the way real waves break over a real reef.

Open water. Build an FFT ocean (Tessendorf, JONSWAP or TMA spectrum) with at least three cascades: long swell measured in tens of metres, wind waves measured in metres, and capillary chop measured in centimetres. Use horizontal (choppy) displacement, not only height. Put it on a camera-centred clipmap or projected grid so triangle density is highest near the viewer. The first-person camera sits within a metre of the surface while paddling, so the near field must hold up at that range.

Swell and sets. A dominant groundswell arrives in sets of 3–5 waves, with lulls between sets, so the ocean has rhythm. Waves are head-high (1–2 m faces), clean and peeling. Now and then a section throws a small, makeable tube.

Bathymetry. Author a procedural seabed: a reef shelf that runs diagonally to the shore (this is what makes waves peel), a sand channel beside the pier where the waves don't break, and a sloping beach face. Drive shoaling from depth: wavelength compresses, height grows and the crest steepens as the water gets shallower. Refraction bends the swell lines around the reef. Breaking must emerge from this, not be triggered on a timer.

Breaking waves. This is the crux. A heightfield cannot represent an overhanging lip, so build a dedicated breaking-wave system on top of the FFT surface. One approach: a parametric breaking-wave profile swept along the break line and blended seamlessly into the ocean surface. It runs through each stage in turn: steepening face, pitching lip, lip thrown forward, curl, collapse, whitewater bore. It peels laterally along the reef at a speed that matches the swell. The curl must be real geometry you can see through and, briefly, ride under.

Whitewater. Where a lip lands: an explosion of aerated foam, spray and mist that travels shoreward as a tumbling bore. The bore then loses energy and becomes a spreading foam sheet. Combine volumetric-looking foam geometry or billboards, GPU compute particles for spray and droplets, and foam written into the surface-state buffer (§3.3).

Shore break and swash. The reformed waves reach the beach and dump in a small shore break. The run-up then sheets thin and fast up the sand, stalls, and drains back as backwash. Behind it are a receding bubble line, lacy foam patterns and a glossy wet film. Nothing sells "realistic beach" as much as the swash. It must never look like a plane sliding up and down.

3.2 Water shading

This shader is the most important code in the project. Budget accordingly. Write it yourself; do not use a stock water material.

Required behaviours:

Subsurface scattering in wave faces. Model light passing through thin water, driven by crest thickness, view angle and sun direction. Backlit lips and thin crests glow gold-green, and the effect falls off with thickness. If you get only one thing right, get this right.

Depth-based absorption and scattering. Beer–Lambert absorption per channel along the refracted path. This produces the turquoise-over-sand to sapphire-over-depth gradient automatically from the bathymetry, not from a painted colour ramp.

Refraction. The seabed, reef and sand are visible through the water, distorted by the surface normals, with restrained chromatic dispersion.

Reflection. Fresnel-weighted reflections of sky, sun and pier. Use screen-space reflections, a planar reflection or probes, whichever gives the best result. The pier must reflect, broken up correctly by the waves.

Caustics. Animated caustics on the reef and sand, projected from the actual surface normals, strongest in the shallows and around the pilings.

Sun glitter. A path of glints from the low sun across the water: many small, sharp highlights resolved from a stable, high-frequency normal distribution, with no crawling or shimmering under TAA. This is the primary blown-out-highlight risk. Tune the roll-off obsessively.

Foam. Multi-layer foam: fresh, bright, bubbly foam where waves break; ageing foam that thins into lacy streaks and dissolves; and a subtle bubble-cloud tint under the surface beneath recent whitewater. Read foam coverage and age from the surface-state buffer.

Micro-detail. Flow-advected capillary normals, and wind-streak slicks on the open water. The surface must hold up at arm's length while paddling.

3.3 Surface state and interaction

This is the core interactive system, the equivalent of snow deformation. Everything writes here, and the water and sand shaders read it.

Keep a player-following render target covering roughly 80–120 m, scrolled toroidally as the player moves and snapped to texel boundaries to avoid swimming. It has two domains, packed however is most efficient.

Water channels:
- Foam coverage and foam age, advected by the wave orbital velocity and a gentle longshore current.
- Disturbance (wake height and velocity) for board wakes, paddle strokes and piling wakes.

Sand channels:
- Wetness, which drives albedo darkening, gloss and the reflective film.
- Depression depth (footprints).
- Displaced mass (the raised rims kicked up around footprints in dry sand).
- Smoothing, written by swash: each run-up erases and softens footprints and trail marks in its reach.

Rules:
- Interaction is persistent and additive, accumulated by writing brush splats each frame. Never rebuild it from a list of past events.
- Foam advects, decays and dissolves over time. A ridden line leaves a visible foam trail on the wave face and in the soup behind it. Pilings shed a constant foam wake downstream.
- Sand dries slowly above the swash line. Footprints in the dry sand stay put. Footprints on the wet sand fill with a glint of water, and the next big run-up erases them.
- The sand vertex displacement and normals sample the same data, so footprints self-shadow correctly in the low sun. A footprint that doesn't self-shadow is a failure.
- The player's feet, the paddle strokes, the board's rails, the pilings and every breaking wave all write into this buffer. That shared path is what makes the player feel physically present in the scene.

3.4 Beach and sand shading

Beach terrain. Build a clipmap or nested-ring LOD for the beach, dune and headland, with sub-10 cm vertex spacing near the player. Height comes from layered procedural noise with directional structure: the beach face slope, berms and cusps shaped by the swash, wind ripples on the dry upper sand, and the dune line with sparse grass. Don't stop at a single fBm stack.

Sand shading:
- Multi-scale normals at three tiling scales, plus normals derived from the interaction buffer.
- Grain sparkle: sparse and subtle, at grazing angles only, stable under TAA.
- Wet versus dry as distinct surface states: wet sand is darker, smoother and glossier, and right after a swash it carries a mirror-like film that reflects the sky, the sun and the pier. The wet-sand reflection of the pier at golden hour is a hero shot.
- Foam residue lines left by receding swash, fading as they dry.
- A few shells, bits of coral rubble and a line of dried seaweed at the high-tide mark. Keep them sparse and use thin instances.

Far field. The volcanic headland, a distant island silhouette and the ocean horizon, with heavy aerial perspective and golden sea haze. A matte-projected or impostor ridge is acceptable as long as it never reads as flat.

3.5 The pier

A slender tropical wooden pier on timber pilings, running from the dry sand out past the break into the channel. It is the hero landmark, it is walkable, and it interacts with the waves.

Construction. Weathered, sun-bleached planks with real gaps between them, stringers, cross-bracing and rope-wrapped railings. The pilings carry a wet-dark band at the tide line, barnacles and green algae in the splash zone, and dry, cracked timber above. A few unlit lanterns on posts, just to give the silhouette something to say.

Shading. Wood with anisotropic grain response, sun-bleach variation, and darkening where spray reaches. Light through the plank gaps paints stripes on the water and sand below. Under the pier the light turns cool and dim, with rippling caustic reflections dancing on the underside of the deck.

Wave interaction. Pilings split the swell and throw foam and spray bursts when whitewater hits them. Each one sheds a trailing foam wake into the surface-state buffer, and water sloshes and wraps around the posts. Waves peel past the end of the pier. Riding close to it should feel dramatic.

Walkable. The player can walk from the sand onto the deck and out to the end. They can look down through the plank gaps at the surf passing underneath and watch sets roll in from the best vantage point in the scene. If it can be made to look finished, jumping off the end into the channel, board in hand, is the best way to reach the lineup. If it can't, cut it and note that in DECISIONS.md.

3.6 Atmosphere and lighting

- Use a physically based sky model, not an HDRI, so you have exact control over the sun angle. Add high cirrus or scattered cumulus lit orange and pink from below.
- The key light is the low, warm sun, with long shadows and cascaded shadow maps using PCSS-style soft filtering. Tune the cascades so footprint and pier-plank shadows stay crisp near the camera.
- Ambient light comes from a warm, peachy sky dome against a cooler blue-violet zenith. Shadowed sand should go lavender-blue, not grey.
- Aerial perspective and fog with height falloff: a golden marine haze that compresses contrast with distance and brightens toward the sun.
- A fine salt-mist volume hangs over the shore break and impact zone, glowing when backlit.
- Offshore spray veils: thin, wind-blown mist peeling off the tops of breaking lips, streaming seaward and lit gold by the sun behind it. This keeps the frame alive, the way spindrift did in the snow brief.
- Light shafts only where they materially improve the image, such as through spray veils or between the pier pilings. Keep them restrained.
- No dynamic lights are required. The whole scene is lit by the sun and the sky.

3.7 Post-processing

Order matters. A suggested chain:

TAA → SSAO → SSR (water and wet sand) → very restrained depth of field → restrained camera and per-object motion blur (for speed and droplet streaks) → restrained bloom → AgX or ACES tonemapping → subtle film grain → post-TAA sharpening.

- TAA is essential for keeping sun glitter, sand sparkle, foam lace and thin geometry (railings, rope, palm fronds) stable.
- Every post-process must be individually toggleable from the settings overlay for A/B comparison.
- Blown-out sun glitter and clipped foam are the primary failure modes. Watch highlight roll-off constantly.
- Water droplets on the "lens" after spray are allowed only if they are extremely restrained and gone within a second. If they read as a gimmick, cut them.

3.8 First-person body and board

The player is seen only in first person: hands and forearms when paddling or carrying, and the board plus a glimpse of the feet when riding. Spend the whole character budget on those.

Board. A shortboard, or a slightly longer fish/funboard that reads better in first person; your call. Waxed deck with wax-bump texture, a visible stringer, rail detail and a subtle traction pad. When wet, water beads and sheets across the deck, and a thin wet film catches the sun.

Arms and hands. Paddling strokes with proper reach, catch and pull. Water sheets off the forearms and drips from the fingertips. The skin has subsurface scattering, a wet sheen, sun-warmed tones and faint salt-dried patches. On the sand, the board is carried under one arm at the edge of view and the free hand swings naturally. When wading, the board floats alongside until the player slides on.

Feet. When riding and looking down, the player sees their feet planted on the deck in a proper stance, shifting weight in turns. On the sand, looking down shows bare feet leaving footprints, frame-accurate with each footfall.

If any part of the first-person body can't be animated to a high standard, cut it from view rather than show something stiff or broken. Hands that don't sell it are worse than no hands.

3.9 Camera and controls

First person throughout. Mouse look. The camera never clips the water surface: while paddling it rides just above the water on a spring, so waves rise up in front of the player's eyes.

Player states (every transition eased, never snapped):

Walk. On the sand and the pier, with a restrained, natural head bob. The feet write footprints.

Wade. Water rises around the legs, and the swash tugs visibly at the camera.

Paddle. The eye line is close to the water and the arms alternate strokes. The player pushes up over oncoming whitewater; there is no duck-dive, and the camera always stays above the surface.

Catch. The player positions in the takeoff zone, paddles hard and feels the wave lift the board. Skill with assist: timing and position matter, but the catch window is generous.

Pop-up. A single key press at the right moment, with a quick, physical transition from prone to standing.

Ride. Mouse look chooses the line; A/D shifts weight rail to rail; W pumps and trims; S stalls. Bottom turns, top turns, cutbacks and trimming high in the pocket should all feel weighty and analogue.

Wipeout. The player catches a rail or goes over the falls. There is a short, violent tumble of camera and spray that stays above the surface, then an eased recovery back to paddling. Never a hard cut.

Refine this control scheme if something better emerges, and document it in DECISIONS.md.

Camera feel. Spring-damped head motion. Horizon tilt that banks with carves. Speed pushes the FOV wider, and it tightens again when the ride ends. Subtle camera shake on the takeoff drop, hard turns and whitewater impacts. Keep it subtle.

3.10 Surfing: the centrepiece

This will be used more than everything else combined, and it gets the most polish.

The ride. Dropping in, the face steepens beneath the board and the horizon falls away. Along the line, the wave peels ahead of the player: a wall of backlit gold-green water with the lip feathering overhead and offshore spray streaming off it. Behind is the sound-without-sound of whitewater chasing them.

The board's wake. The rails carve a visible line into the face. Hard turns throw a fan of spray off the tail, and that spray catches the backlight, glows, and casts a shadow. The line written into the surface-state buffer stays visible as a foam trail on the face and in the soup after the wave has passed.

The tube. On sections that throw, the player can stall and pull in under the lip for a few seconds. The ceiling of the curl glows with transmitted sunlight, the opening frames the light ahead, and spray and droplets hang in the air. This is the single most screenshotted moment in the demo. Give it disproportionate care.

The pier. Some waves peel toward the pier, so the player can ride along it and pull out beside the pilings. The whitewater bursting through the posts should look magnificent.

Sense of speed. There is no audio, so every visual cue must contribute: FOV, motion blur on the passing face, spray streaking past the camera, foam lines rushing under the board, the horizon banking, and the board's nose chattering over chop.

Tune the feel by hand until it is genuinely fun, not merely until it compiles.

4. Performance engineering

Garbage collection is your main enemy. A 12 ms garbage-collection pause is a visible hitch and instantly destroys the AAA impression.

- Zero allocations in the render loop. No `new` inside per-frame code. Pre-allocate scratch vectors, matrices and quaternions at module scope and reuse them.
- No map, filter, reduce, spread syntax or object-creating destructuring in hot paths. Use plain indexed for loops.
- No string construction per frame, including in the performance overlay. Update it on a throttled interval and reuse buffers.
- Object pools for every transient effect, spray burst, particle emitter and decal.
- Pre-allocated typed arrays for all GPU uploads. Write into them rather than rebuilding them.
- Freeze static content aggressively (world matrices, materials, active mesh lists, or your engine's equivalents).
- Instancing for all repeated geometry: planks, pilings, shells, palms, grass.
- Run the FFT, foam advection, interaction-buffer updates and particles as GPU compute. Keep CPU-GPU readbacks out of the frame. If the board physics needs water height, compute it on the CPU from the same analytic spectrum and wave model, or use an asynchronous readback that never stalls.
- Profile with the Chrome performance panel and your engine's inspector or timestamp queries. Ship a frame-time graph in the overlay that shows the 1% low, not just an FPS counter.
- Set an explicit frame budget and hold to it. At 90 FPS the total is 11.1 ms. Allocate it across ocean simulation, breaking waves, water shading, beach and sand, the pier, shadows, VFX, the first-person body and post-processing. Record the measured cost per system in PERF.md.

5. Loading and pipeline warm-up

WebGPU pipeline compilation stutter is a real and severe risk. A shader that compiles for the first time when the player pulls into their first tube will cause a multi-hundred-millisecond freeze at exactly the moment that matters most.

Before the loading screen closes:

- Load and decode every texture, mesh and buffer.
- Force-compile every material, particle and compute pipeline by rendering each one once to a tiny offscreen target. That includes every wave-breaking stage, the whitewater, spray, the tube interior, the wet-sand film, every post-process and every shader permutation.
- Warm every render target and run several frames of every compute pass, including the FFT cascades, foam advection and the interaction buffer.
- Pre-simulate the ocean long enough that the first frame already shows mature foam and a set in progress, not a glassy start-up state.
- Only then fade in.

A four-second load with a clean first minute beats an instant load that hitches. The loading screen is the first thing anyone sees, so make it tasteful; it must not look like an unstyled browser default.

6. UI

Provide only a settings and performance overlay, toggled with F1 or backtick and hidden by default.

It contains:

- A frame-time graph with the 1% low.
- Draw-call and triangle counts.
- An individual toggle for every post-process and major system.
- Quality presets.
- Sliders for the art parameters most likely to need live tuning: sun elevation and azimuth, swell height, set interval, wind speed and direction, water clarity and absorption, SSS strength, foam persistence, glitter intensity, haze density and exposure.

Build this early. It will save hours.

No HUD. No crosshair. No prompts or button hints. Nothing else on screen, ever.

7. Project structure

A suggested layout; adapt as needed:

/src
  /core         engine bootstrap, render loop, resource manager, pooling
  /ocean        FFT cascades, bathymetry, shoaling, breaking-wave system, whitewater
  /beach        terrain clipmap, sand, dune, headland, props
  /pier         construction, instancing, piling interaction
  /state        surface-state / interaction buffers (foam, wake, sand)
  /shaders      WGSL / TSL / node sources
  /player       state machine, first-person body, board, controls, camera
  /vfx          spray, mist, droplets, spray veils, birds
  /post         post-process chain
  /ui           settings overlay
/assets         vendored, with ASSETS.md
DECISIONS.md    every deviation from this brief, with rationale (including the engine choice)
PERF.md         measured frame budget per system

8. Milestones

Take a 1440p screenshot at every milestone, inspect it critically and commit the screenshots.

1. Foundation. WebGPU boot, Vite, render loop, settings overlay with frame graph, first-person camera and walking on a placeholder plane. Engine choice recorded.

2. Ocean, beach and sky. FFT ocean, bathymetry, the full water material (SSS, absorption, refraction, reflection, caustics, glitter), sand shading with wet and dry states, the sky model, cascaded shadows and haze. Gate: a static screenshot looking down the beach toward the sun, with no player and the pier blocked in, already looks polished, atmospheric and ready for production. Do not continue until that is true.

3. Breaking waves. Shoaling, peeling breakers with real curl geometry, whitewater bores, the shore break, swash and backwash. Gate: watched from the sand for a full set, the waves are convincing in motion. The lip pitches, the whitewater has mass, and the swash sheets and drains like water, not like a sliding plane.

4. Surface state. Foam advection and decay, wakes, wet and dry sand, footprints with raised rims and self-shadowing, and swash erasure. Gate: footprints self-shadow, and foam trails drift and dissolve believably.

5. The pier. Full construction and shading, piling interaction (split swell, spray bursts, foam wakes), walkability, light through the plank gaps, and caustics on the deck underside.

6. First-person body and board. Walking, carrying, wading, paddling, pop-up, foot planting, footprints and wet-skin shading.

7. Surfing. The centrepiece: catch, ride, carves, spray fans, wake, the tube and pier runs. Spend disproportionate time here.

8. Polish. The full post chain, tonemapping calibration, spray veils, salt mist, light shafts, birds, palms and final colour.

9. Performance hardening. Profile, remove every allocation in the loop, verify 90 FPS with clean 1% lows, and verify that the warm-up covers every pipeline.

9. Visual acceptance criteria

Before declaring the demo complete, check each item against a fresh 1440p screenshot and in motion:

- No visible faceting, hard polygon edges or flat-shaded surfaces anywhere in frame, including the water at arm's length while paddling.
- Backlit wave faces and lips glow with transmitted light, and that glow falls off with thickness.
- Water colour comes from depth and absorption: turquoise over sand, darker over reef, sapphire in the deep. The seabed is legible through the water, with caustics.
- The breaking waves have overhanging lips, thrown curls and whitewater with visible mass and momentum, not just particle spray.
- The swash runs up, thins, stalls and drains back, leaving a glossy wet film and receding foam lace.
- The sun glitter and foam highlights are not clipped to flat white. Shadowed sand is lavender-blue, not grey or black.
- Distant headland and islands show clear aerial perspective and golden haze.
- Surface detail is legible at three scales at once: swell, wind waves and capillary chop on the water, and slope, ripples and grain on the sand.
- Footprints have raised rims, self-shadow in the low sun, and are erased by swash on the wet sand.
- The pier reflects in the water and the wet sand, the pilings split waves with foam and spray, and light through the plank gaps stripes the surface below.
- The board and hands read as real, wet, sunlit objects, and the animation never looks stiff.
- A ridden line leaves a foam trail that persists after the wave has passed.
- The rail spray on a hard turn glows in the backlight and casts a shadow.
- The inside of a tube reads as a glowing, translucent ceiling of water.
- Sun glitter, sand sparkle and foam lace do not crawl or shimmer in motion.
- The demo sustains 90 FPS with 1% lows above 60 FPS.
- There is no hitch on the first catch, the first tube or the first wipeout.

10. Working agreement

Build, don't test-loop. Playwright is available for capturing milestone screenshots and catching hard regressions; use it only for those. Do not build a test suite. Time spent on tests is time not spent on the water shader.

Look at your own output constantly. Capture screenshots, inspect them critically and iterate on values. Most of the gap between a prototype and AAA is parameter tuning, and the only way to close it is by looking. Real reference photography of golden-hour reef breaks is the benchmark. Compare against it honestly.

Do not move on from an ugly milestone. Milestones 2 and 3 are hard gates.

When a technique isn't working, replace it rather than patching it. You have full latitude over the approach.

Record every deviation in DECISIONS.md, briefly. One line is enough.

Ship something worth screenshotting.
