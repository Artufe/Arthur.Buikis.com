#!/usr/bin/env python3
"""Cut the LITTLEBIG trailer's six beat clips (1920x1080, 30 fps) from littlebig-cine.mjs renders.

usage: cut.py <renders dir> <out dir> [beat ...]

<renders dir> holds one folder of frames per job in jobs/, named by the job's stem (a1-dawn/f_000.jpg …),
plus a3-square-tiltshift/ from tiltshift.py. Each beat is one clip: hard cuts between shots, the 16:10
masters cropped to the centre 1080 band, the reviewers' grades. The recipe is in docs/play-media.md.
"""
import os
import subprocess
import sys

WARM = 'colorbalance=rh=0.07:gh=0.025:bh=-0.06'  # dawn: day side toward amber, the night side stays blue
DUSK = 'colorbalance=rm=-0.02:gm=0.05:bm=-0.03:rh=0.04:gh=0.01:bh=-0.04,eq=contrast=1.10:saturation=1.03'
LIFT = "curves=all='0/0 0.25/0.29 0.5/0.56 1/1'"  # night: lift the mid-tones, keep the blacks

# beat: [(frames folder, first frame, last frame, grade)], f_<handles> being each job's frame 0
EDL = {
    'planet': [('a1-dawn', 78, 149, WARM), ('a2-descent', 42, 155, None)],
    'town': [('a3-square-tiltshift', 15, 86, None)],
    'bird': [('b1-takeoff', 36, 101, None), ('b2-glide', 22, 69, None), ('b3-glide-close', 95, 148, None)],
    'city': [('c4-run', 15, 68, None), ('c3-plaza', 62, 137, None), ('c2-dusk', 205, 254, None)],
    # the follow, the bumper insert on the first lit frame of a blink (d2 f_036 is d3 f_054), the turn
    'blinker': [('d2-follow', 7, 35, DUSK), ('d3-insert', 54, 92, DUSK), ('d2-follow', 140, 209, DUSK)],
    'night': [('a4-night', 116, 271, LIFT)],
}

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
for name in sys.argv[3:] or EDL:
    args, chains = [], []
    for i, (d, a, b, grade) in enumerate(EDL[name]):
        missing = [f for f in range(a, b + 1) if not os.path.exists(f'{src}/{d}/f_{f:03d}.jpg')]
        assert not missing, f'{d}: missing frames {missing[0]}…{missing[-1]}'
        args += ['-framerate', '30', '-start_number', str(a), '-i', f'{src}/{d}/f_%03d.jpg']
        chains.append(f'[{i}:v]trim=end_frame={b - a + 1},setpts=PTS-STARTPTS,crop=1920:1080:0:60{"," + grade if grade else ""},setsar=1[v{i}]')
    n = len(chains)
    graph = ';'.join(chains) + ';' + ''.join(f'[v{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0,format=yuv420p[o]'
    dst = f'{out}/{name}.mp4'
    # A short GOP keeps the Motion player's per-frame seeks cheap.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *args, '-filter_complex', graph, '-map', '[o]', '-r', '30',
                    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
                    '-movflags', '+faststart', dst], check=True)
    frames = sum(b - a + 1 for _, a, b, _ in EDL[name])
    print(f'{name}: {frames} frames, {frames / 30:.2f} s, {os.path.getsize(dst) / 1e6:.1f} MB')
