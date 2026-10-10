# tiltshift.py src_dir dst_dir [focus_lo focus_hi full_lo full_hi radius]
# Miniature falloff (review spec): sharp for y in [340, 860], Gaussian radius ramping linearly to `radius` at
# y <= 254 and y >= 946 (the top/bottom 18% of the 1080 band, y 60-1140). Rows blend two precomputed blur levels.
import sys, glob, os
import numpy as np
from PIL import Image, ImageFilter
src, dst = sys.argv[1], sys.argv[2]
f0, f1, a0, a1, R = (float(x) for x in (sys.argv[3:8] if len(sys.argv) > 7 else (340, 860, 254, 946, 5.5)))
os.makedirs(dst, exist_ok=True)
LV = np.array([0, 1, 2, 3, 4, 5, R])
def radius(y):
    if y < f0: return R * min(1, (f0 - y) / (f0 - a0))
    if y > f1: return R * min(1, (y - f1) / (a1 - f1))
    return 0.0
for p in sorted(glob.glob(f'{src}/f_*.jpg')):
    im = Image.open(p).convert('RGB'); H = im.height
    stack = [np.asarray(im, np.float32) if r == 0 else np.asarray(im.filter(ImageFilter.GaussianBlur(r)), np.float32) for r in LV]
    out = np.empty_like(stack[0])
    for y in range(H):
        r = radius(y); i = min(len(LV) - 2, int(np.searchsorted(LV, r, 'right') - 1)); w = (r - LV[i]) / (LV[i + 1] - LV[i])
        out[y] = stack[i][y] * (1 - w) + stack[i + 1][y] * w
    Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8)).save(f'{dst}/{os.path.basename(p)}', quality=95)
