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

function loudness(file, pre = '') {
  const log = ff(['-i', file, '-af', `${pre}ebur128=peak=true`, '-f', 'null', '-']);
  const i = [...log.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  const p = [...log.matchAll(/Peak:\s+(-?[\d.]+) dBFS/g)].pop();
  return { lufs: i ? Number(i[1]) : NaN, peak: p ? Number(p[1]) : NaN };
}

function rmsDb(file, filter) {
  const log = ff(['-i', file, '-af', `${filter},astats=measure_perchannel=none`, '-f', 'null', '-']);
  const m = [...log.matchAll(/RMS level dB:\s+(-?[\d.]+|-inf)/g)].pop();
  return m && m[1] !== '-inf' ? Number(m[1]) : -120;
}

// One-shots: strip leading/trailing silence. Loops: leave the seam untouched.
const trim =
  kind === 'oneshot'
    ? 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,'
    : '';
const before = loudness(input, trim);
const gain = TARGET_LUFS - before.lufs;
const limiter = before.peak + gain > -1 ? 'alimiter=limit=0.89:level=false,' : '';
ff(['-y', '-i', input, '-af', `${trim}volume=${gain.toFixed(2)}dB,${limiter}anull`, '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', output]);

const after = loudness(output);
const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output]).trim().split('\n')[0]);
const seamDb = kind === 'loop' ? Math.abs(rmsDb(output, 'atrim=0:0.05') - rmsDb(output, 'areverse,atrim=0:0.05')) : null;
console.log(JSON.stringify({ output, kind, lufs: after.lufs, peak: after.peak, duration, seamDb }));
