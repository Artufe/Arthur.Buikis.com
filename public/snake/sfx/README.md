# Snake 3D sound effects

Generated with ElevenLabs Sound Effects v2 (`eleven_text_to_sound_v2`, `prompt_influence: 0.45`) and
normalised with `scripts/sfx-process.mjs` (mono, 44.1 kHz, 96 kbps MP3; loops target -16 LUFS,
one-shots target -14 LUFS with leading/trailing silence trimmed).

**Chosen by measurable checks only; nobody listened. Swap in a different take from the flow if one sounds better.**

ElevenLabs flow: <https://elevenlabs.io/app/flows/9j98d7OGmQbGqciH4ESE> (`snake-3d sfx`). Each node on the
flow is one take; takes are numbered in the order their nodes were added (top to bottom on the canvas).

## Files

| File | Prompt | duration_seconds | loop | Chosen take (flow node) | lufs | peak (dBTP) | duration (s) | seamDb |
|---|---|---|---|---|---|---|---|---|
| `wind-light.mp3` | Soft warm desert wind over open sand dunes at golden hour, gentle slow gusts, fine sand hiss, no voices, no music | 10 | true | take 3 of 5 (`U31V4eWCnsmpjm6VzFXN`) | -22.1 | -1.3 | 10.00 | 0.071 |
| `wind-night.mp3` | Very calm cold night wind in an empty desert, faint distant airy hiss, quiet and still, no insects, no voices | 10 | true | take 1 of 3 (`1JTTqtDHaNxfunUAw0z5`) | -18.5 | -1.3 | 10.00 | 0.055 |
| `slither.mp3` | Close-up of a snake sliding smoothly over fine dry sand, continuous soft rhythmic hiss and scrape, steady | 4 | true | take 1 of 3 (`rufC2GiG8JUiy7kwmaQG`) | -16.4 | -1.6 | 4.00 | 0.033 |
| `eat.mp3` | Short soft juicy bite into a ripe fruit followed by a tiny puff of sand, satisfying, dry, close | 0.6 | false | take 2 of 3 (`HDUq2NtotBkGGMxNQey4`) | -17.3 | -1.4 | 0.600 | – |
| `golden.mp3` | Shimmering magical pickup, bright glassy chime with a warm rising swell, short and sparkling | 1.2 | false | take 2 of 3 (`ZczEaDTK9fl1g85U7HuB`) | -13.7 | -3.9 | 1.200 | – |
| `death.mp3` | Heavy soft body thud into deep sand, then sand collapsing and pouring, dusty, low | 1.5 | false | take 1 of 5 (`STndOyNqHgBwEtLWf0VT`) | -21.2 | -1.3 | 1.480 | – |
| `sink.mp3` | Sand swallowing an object, low soft rumble with trickling grains, short | 1 | false | take 1 of 3 (`IoG32LZD8fhUo6YoYE1Y`) | -16.5 | -4.6 | 0.822 | – |
| `ui.mp3` | Tiny soft wooden click, dry, very short, for a menu button | 0.5 | false | take 1 of 5 (`wDvyQJc1rUSY8QEdjNPz`) | -18.4 | -1.1 | 0.480 | – |

Total size: 352 KB (target ≤ 400 KB, so the wind loops stay at 96 kbps).

Checks (from the plan): `peak ≤ -1.0`; loops `seamDb < 1.0`; duration within ±40% of the requested
length. Among passing takes the lowest `seamDb` (loops) or the duration closest to the request (one-shots) wins.
Every file above passes all checks. `wind-light`, `death` and `ui` have 5 takes on the flow because the first
processing script failed them; the fixed script (below) passes takes from the original three for all of them.

### Processing notes

- ElevenLabs returns many takes very quiet (raw -33 to -48 LUFS), so the gain is large and the limiter
  engages. MP3 encoding overshoots a limiter's ceiling, so the script measures the encoded true peak and lowers
  the ceiling until it lands at or under -1 dBTP. Heavily limited takes therefore miss the loudness target
  (for example `wind-light` at -22.1 LUFS); the target is not one of the checks.
- One-shot silence trimming is relative to each take's own peak (peak − 45 dB), so quiet clicks survive it.
- Loudness is measured with 1 s of padding, so clips shorter than the 400 ms EBU R128 block still measure.
- `ui` takes 3 and 4 are effectively silent (raw peak ≈ -53 dBFS) and are rejected.

## Regenerating

1. Open the flow above (or create a new one) and add `sfx` nodes with model `eleven_text_to_sound_v2`,
   the prompt, `duration_seconds` and `loop` from the table, and `prompt_influence: 0.45`. The model's minimum
   `duration_seconds` is 0.5 and its maximum is 30. Every requested length here is inside that range.
2. Run the nodes (one generation per node) and download each result into the session scratchpad
   (raw takes are never committed):

   ```bash
   SFX_RAW="$SCRATCHPAD/sfx-raw"; mkdir -p "$SFX_RAW"
   curl -sSL "<url>" -o "$SFX_RAW/<name>-<take>.mp3"
   ```

3. Process every take and read the JSON it prints:

   ```bash
   node scripts/sfx-process.mjs "$SFX_RAW/<name>-<take>.mp3" "$SFX_RAW/<name>-<take>.norm.mp3" <loop|oneshot>
   ```

   Use `loop` for `wind-light`, `wind-night` and `slither`, and `oneshot` for everything else.
4. Pick the best take using the checks above. If no take passes, generate 2 more for that sound.
5. Copy the chosen take into place and check the total size:

   ```bash
   cp "$SFX_RAW/<name>-<take>.norm.mp3" public/snake/sfx/<name>.mp3
   du -ch public/snake/sfx/*.mp3 | tail -1   # target ≤ 400K total
   ```

   If the total is over 400 KB, re-encode the two wind loops at `-b:a 64k`.
