# Builds the seamless-loop frame set from a raw capture.
# python3 scripts/play-media/snake-assemble.py <raw-dir> <out-dir> <pre_frames> <clip_frames> [W H]
# raw frame k corresponds to clip time (k - pre)/30. Output frame j = raw[pre + j]; over the last `pre`
# frames it crossfades (smoothstep) into raw[j - (clip - pre)], i.e. the frames just before frame 0, so
# the last output frame leads straight into the first one.
import os, sys
import numpy as np
from PIL import Image

raw, out, P, N = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
W, H = (int(sys.argv[5]), int(sys.argv[6])) if len(sys.argv) > 6 else (1280, 800)
os.makedirs(out, exist_ok=True)
ext = 'jpg' if os.path.exists(os.path.join(raw, '0000.jpg')) else 'png'
load = lambda k: np.asarray(Image.open(os.path.join(raw, f'{k:04d}.{ext}')).convert('RGB'), dtype=np.float32)
for j in range(N):
    a = load(P + j)
    if j >= N - P:
        u = (j - (N - P) + 1) / (P + 1)
        w = u * u * (3 - 2 * u)
        b = load(j - (N - P))
        a = a * (1 - w) + b * w
    img = Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8))
    if img.size != (W, H):
        img = img.resize((W, H), Image.LANCZOS)
    img.save(os.path.join(out, f'{j:04d}.png'), compress_level=1)
print('wrote', N, 'frames to', out)
