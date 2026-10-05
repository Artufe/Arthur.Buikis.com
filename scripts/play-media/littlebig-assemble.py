#!/usr/bin/env python3
"""Assemble the LITTLEBIG /play clip from littlebig-clip.mjs frames: the dive and the hold on the
landing (f_000 … f_N-1), whose last 0.5 s dissolves into the pre-roll on the opening globe
(pre_000 … pre_014), so the frame after the clip's last one is its first one (f_000 follows
pre_014 on the same camera, 1/30 s later). Output: N frames at 30 fps, H.264 High, limited-range
yuv420p, +faststart.

  python3 scripts/play-media/littlebig-assemble.py <frames dir> <out.mp4> [--kbps 1250] [--crf N]

--kbps does a two-pass encode to that average bitrate (the size budget); --crf a one-pass quality
encode (for review masters).
"""
import argparse
import glob
import os
import subprocess
import sys
import tempfile

ap = argparse.ArgumentParser()
ap.add_argument('frames')
ap.add_argument('out')
ap.add_argument('--kbps', type=int)
ap.add_argument('--crf', type=int)
ap.add_argument('--denoise', default='', help='hqdn3d params, e.g. 1:1:2:2 (only if the encode smears)')
ap.add_argument('--start', type=int, default=0,
                help='rotate the loop so the clip opens on this frame (the poster frame), seamless both ways')
a = ap.parse_args()

FPS = 30
ext = 'png' if glob.glob(os.path.join(a.frames, 'f_000.png')) else 'jpg'
n = len(glob.glob(os.path.join(a.frames, f'f_*.{ext}')))
pre = len(glob.glob(os.path.join(a.frames, f'pre_*.{ext}')))
if n < 2 * pre or pre < 2:
    sys.exit(f'need f_ frames and pre-roll frames in {a.frames} (found {n} / {pre})')
fade = pre / FPS
offset = (n - pre) / FPS

inputs = ['-framerate', str(FPS), '-i', os.path.join(a.frames, f'f_%03d.{ext}'),
          '-framerate', str(FPS), '-i', os.path.join(a.frames, f'pre_%03d.{ext}')]
norm = ''.join(f'[{i}:v]scale=in_range=pc:out_range=tv,format=yuv420p,setpts=PTS-STARTPTS[s{i}];' for i in range(2))
graph = norm + f'[s0][s1]xfade=transition=fade:duration={fade:.4f}:offset={offset:.4f}[x]'
last = 'x'
if a.denoise:
    graph += f';[x]hqdn3d={a.denoise}[dn]'
    last = 'dn'
if a.start:
    # The assembled clip already loops (its last frame leads into its first), so cutting it at
    # --start and swapping the halves keeps every frame-to-frame step, including the loop point.
    graph += (f';[{last}]split[ra][rb];[ra]trim=start_frame={a.start},setpts=PTS-STARTPTS[rh];'
              f'[rb]trim=end_frame={a.start},setpts=PTS-STARTPTS[rt];[rh][rt]concat=n=2:v=1:a=0[rot]')
    last = 'rot'

base = ['ffmpeg', '-y', '-loglevel', 'error', *inputs, '-filter_complex', graph, '-map', f'[{last}]',
        '-frames:v', str(n), '-c:v', 'libx264', '-preset', 'veryslow', '-tune', 'animation',
        '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-an']
if a.crf is not None:
    subprocess.run([*base, '-crf', str(a.crf), '-movflags', '+faststart', a.out], check=True)
else:
    kbps = a.kbps or 1250
    with tempfile.TemporaryDirectory() as tmp:
        log = os.path.join(tmp, 'x264')
        rate = ['-b:v', f'{kbps}k', '-maxrate', f'{int(kbps * 1.8)}k', '-bufsize', f'{kbps * 2}k']
        subprocess.run([*base, *rate, '-pass', '1', '-passlogfile', log, '-f', 'mp4', os.devnull], check=True)
        subprocess.run([*base, *rate, '-pass', '2', '-passlogfile', log, '-movflags', '+faststart', a.out], check=True)
print(a.out, os.path.getsize(a.out), 'bytes', f'({n} frames, {n / FPS:.2f} s)', file=sys.stderr)
