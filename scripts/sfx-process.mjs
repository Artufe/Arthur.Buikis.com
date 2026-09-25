#!/usr/bin/env node
// Normalises one ElevenLabs sound-effect take for the snake game and prints its stats.
// usage: node scripts/sfx-process.mjs <input> <output.mp3> <loop|oneshot>
import { spawnSync } from 'node:child_process';

const [, , input, output, kind] = process.argv;
if (!input || !output || !['loop', 'oneshot'].includes(kind)) {
  console.error('usage: node scripts/sfx-process.mjs <input> <output.mp3> <loop|oneshot>');
  process.exit(2);
}
const TARGET_LUFS = kind === 'loop' ? -16 : -14;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  return `${r.stdout}\n${r.stderr}`;
}
const ff = (args) => run('ffmpeg', ['-hide_banner', '-nostats', ...args]);

// apad gives clips shorter than the meter's 400 ms block something to measure; the
// silence itself is gated out of integrated loudness.
function loudness(file, pre = '') {
  const log = ff(['-i', file, '-af', `${pre}apad=pad_dur=1,ebur128=peak=true`, '-f', 'null', '-']);
  const i = [...log.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  const p = [...log.matchAll(/Peak:\s+(-?[\d.]+|-inf) dBFS/g)].pop();
  return { lufs: i ? Number(i[1]) : NaN, peak: p && p[1] !== '-inf' ? Number(p[1]) : -120 };
}

function rmsDb(file, filter) {
  const log = ff(['-i', file, '-af', `${filter},astats=measure_perchannel=none`, '-f', 'null', '-']);
  const m = [...log.matchAll(/RMS level dB:\s+(-?[\d.]+|-inf)/g)].pop();
  return m && m[1] !== '-inf' ? Number(m[1]) : -120;
}

// One-shots: strip leading/trailing silence, relative to the take's own peak (ElevenLabs
// returns some takes very quiet). Loops: leave the seam untouched.
const rawPeak = loudness(input).peak;
const floor = Math.max(-80, rawPeak - 45).toFixed(1);
const trim =
  kind === 'oneshot'
    ? `silenceremove=start_periods=1:start_threshold=${floor}dB,areverse,silenceremove=start_periods=1:start_threshold=${floor}dB,areverse,`
    : '';
const before = loudness(input, trim);
const gain = Number.isFinite(before.lufs) && before.lufs > -69 ? TARGET_LUFS - before.lufs : 0;

// MP3 encoding overshoots a limiter's ceiling, so measure the encoded true peak and pull the
// ceiling down until it lands at or under -1 dBTP.
let ceiling = -2;
for (let attempt = 0; attempt < 6; attempt++) {
  const limiter = `alimiter=limit=${Math.pow(10, ceiling / 20).toFixed(4)}:level=false,`;
  ff(['-y', '-i', input, '-af', `${trim}volume=${gain.toFixed(2)}dB,${limiter}anull`, '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', output]);
  const peak = loudness(output).peak;
  if (peak <= -1.0) break;
  ceiling -= peak + 1.0 + 0.3;
}

const after = loudness(output);
const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output]).trim().split('\n')[0]);
const seamDb = kind === 'loop' ? Math.abs(rmsDb(output, 'atrim=0:0.05') - rmsDb(output, 'areverse,atrim=0:0.05')) : null;
console.log(JSON.stringify({ output, kind, lufs: after.lufs, peak: after.peak, duration, seamDb }));
