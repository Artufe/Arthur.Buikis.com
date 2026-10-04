#!/usr/bin/env python3
"""Assemble the GOLDENLINE trailer: crash → ride → ashore → (loops back to crash).

Each scene directory holds frames/0000.jpg … 0164.jpg: 15 handle frames, 135 core, 15 handle.
Neighbouring scenes overlap by their handles in a 0.5 s crossfade; the last fade blends ashore's
tail into crash's head, so the frame after the trailer's last one is the trailer's first one.
Output: 450 frames (15 s) at 30 fps.

  python3 scripts/play-media/gl-assemble.py <gl-media dir> <out.mp4> [--kbps 2100] [--crf N]

--kbps does a two-pass encode to that average bitrate (the size budget); --crf a one-pass quality
encode (for review masters).
"""
import argparse
import os
import subprocess
import sys
import tempfile

ap = argparse.ArgumentParser()
ap.add_argument('media')
ap.add_argument('out')
ap.add_argument('--kbps', type=int)
ap.add_argument('--crf', type=int)
ap.add_argument('--scenes', default='v2-crash,v2-ride,v2-ashore')
ap.add_argument('--denoise', default='', help='hqdn3d params, e.g. 2:1.5:3:2.5 (strips the game\'s film grain, which eats bitrate)')
a = ap.parse_args()

scenes = [os.path.join(a.media, s, 'frames', '%04d.jpg') for s in a.scenes.split(',')]
FADE, CORE, HANDLE, FPS = 0.5, 135, 15, 30
seg = (CORE + HANDLE) / FPS  # first scene enters at its core: 150 frames = 5.0 s

inputs = ['-framerate', str(FPS), '-start_number', str(HANDLE), '-i', scenes[0]]
for s in scenes[1:]:
    inputs += ['-framerate', str(FPS), '-start_number', '0', '-i', s]
inputs += ['-framerate', str(FPS), '-start_number', '0', '-i', scenes[0]]  # loop tail: crash head

n = len(scenes) + 1
norm = ''.join(f'[{i}:v]scale=in_range=pc:out_range=tv,format=yuv420p,setpts=PTS-STARTPTS[s{i}];' for i in range(n))
norm = norm.replace(f'[{n-1}:v]scale', f'[{n-1}:v]trim=end_frame={HANDLE},scale')
chain, prev, length = '', 's0', seg
for i in range(1, n):
    offset = length - FADE
    out = f'x{i}'
    chain += f'[{prev}][s{i}]xfade=transition=fade:duration={FADE}:offset={offset:.4f}[{out}];'
    prev = out
    length = offset + (HANDLE / FPS if i == n - 1 else (2 * HANDLE + CORE) / FPS)
graph = norm + chain.rstrip(';')
if a.denoise:
    graph += f';[{prev}]hqdn3d={a.denoise}[dn]'
    prev = 'dn'

base = ['ffmpeg', '-y', '-loglevel', 'error', *inputs, '-filter_complex', graph, '-map', f'[{prev}]',
        '-c:v', 'libx264', '-preset', 'veryslow', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-color_range', 'tv', '-an']
if a.crf is not None:
    subprocess.run([*base, '-crf', str(a.crf), '-movflags', '+faststart', a.out], check=True)
else:
    kbps = a.kbps or 2100
    with tempfile.TemporaryDirectory() as tmp:
        log = os.path.join(tmp, 'x264')
        rate = ['-b:v', f'{kbps}k', '-maxrate', f'{int(kbps * 1.6)}k', '-bufsize', f'{kbps * 2}k']
        subprocess.run([*base, *rate, '-pass', '1', '-passlogfile', log, '-f', 'mp4', os.devnull], check=True)
        subprocess.run([*base, *rate, '-pass', '2', '-passlogfile', log, '-movflags', '+faststart', a.out], check=True)
print(a.out, os.path.getsize(a.out), 'bytes', file=sys.stderr)
