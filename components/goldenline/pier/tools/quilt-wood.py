#!/usr/bin/env python3
"""Bake the pier's long wood-grain strip from Poly Haven's CC0 `rough_wood` (0.5 m tile).

Planks are 3.2 m and pilings up to 14 m long, so a 0.5 m tile would visibly repeat along the
grain. This quilts (Efros-Freeman image quilting, min-cut seams) random blocks of the source along
the grain into a strip 0.5 m across by ~4.1 m along, tileable both ways, and packs:

  wood_albedo.webp  sRGB albedo
  wood_normal.webp  OpenGL tangent-space normal
  wood_ord.webp     R = roughness, G = ambient occlusion, B = height (displacement)

Resolution is anisotropic on purpose: 0.5 mm/px across the grain, 1 mm/px along it (wood detail
changes fast across the grain and slowly along it).

  python3 quilt-wood.py <dir with rough_wood_*_2k.jpg> <out dir>
"""
import sys

import numpy as np
from scipy import ndimage
from PIL import Image

SRC, OUT = sys.argv[1], sys.argv[2]
W, H = 1024, 512  # source after resampling: 0.5 m x 0.5 m
L = 4096  # output length (rows) along the grain
B, O = 256, 72  # block height, overlap
rng = np.random.default_rng(7)


def load(name, mode='RGB'):
    im = Image.open(f'{SRC}/rough_wood_{name}_2k.jpg').convert(mode)
    return np.asarray(im.resize((W, H), Image.LANCZOS)).astype(np.float32) / 255.0


diff = load('diff')
nor = load('nor_gl')
rough = load('rough', 'L')[..., None]
ao = load('ao', 'L')[..., None]
disp = load('disp', 'L')[..., None]
# One stack so every channel shares the same blocks and seams. Normal x/y stored signed.
stack = np.concatenate([diff, nor * 2 - 1, rough, ao, disp], axis=2)  # H x W x 9


def remove_cross_grain(stack):
    """The source has a few saw cuts and a knot running ACROSS the grain. Quilted, they read as
    a repeating '=' pattern, so clone over them with grain from further along the same columns
    (the grain is vertical, so a vertical clone continues it almost perfectly)."""
    g = stack[..., 0:3].mean(axis=2)
    gy = np.abs(np.roll(g, -1, 0) - np.roll(g, 1, 0))
    gx = np.abs(np.roll(g, -2, 1) - np.roll(g, 2, 1))
    score = ndimage.uniform_filter(gy, (1, 21), mode='wrap') - 0.6 * ndimage.uniform_filter(gx, (1, 21), mode='wrap')
    m = score > np.percentile(score, 98.5)
    m = ndimage.binary_closing(m, np.ones((5, 15)))
    lab, n = ndimage.label(m)
    sizes = ndimage.sum(m, lab, range(1, n + 1))
    keep = np.isin(lab, 1 + np.nonzero(sizes > 120)[0])
    keep = ndimage.binary_dilation(keep, np.ones((9, 17)))
    soft = ndimage.gaussian_filter(keep.astype(np.float32), (3, 5), mode='wrap')[..., None]
    soft = np.clip(soft * 1.6, 0, 1)
    out = stack.copy()
    # Clone from the side (above or below) that is itself clean.
    for d in (48, -48, 96, -96):
        src = np.roll(stack, d, axis=0)
        src_bad = np.roll(soft, d, axis=0)
        use = soft * (1 - src_bad)
        out = out * (1 - use) + src * use
        soft = soft * src_bad
    return out, keep.mean()


stack, frac = remove_cross_grain(stack)
print('cross-grain area cloned: %.1f%%' % (frac * 100))
lum = stack[..., 0:3].mean(axis=2) * 0.7 + stack[..., 8] * 0.3


def block(y, x, fu, fv):
    """B rows of the source starting at row y, rolled by x columns, optionally flipped."""
    rows = np.arange(y, y + B) % H
    b = np.roll(stack[rows], -x, axis=1).copy()
    g = np.roll(lum[rows], -x, axis=1).copy()
    if fv:
        b = b[::-1]
        g = g[::-1]
        b[..., 4] *= -1  # normal y flips with v
    if fu:
        b = b[:, ::-1]
        g = g[:, ::-1]
        b[..., 3] *= -1  # normal x flips with u
    return b, g


def min_cut(err):
    """Horizontal seam through an O x W error map: for each column, the first row that belongs
    to the new block. Dynamic programming over columns, moving at most one row per column."""
    o, w = err.shape
    cost = err.copy()
    back = np.zeros((o, w), np.int32)
    for c in range(1, w):
        prev = cost[:, c - 1]
        up = np.concatenate([[np.inf], prev[:-1]])
        dn = np.concatenate([prev[1:], [np.inf]])
        choice = np.stack([up, prev, dn])
        k = choice.argmin(axis=0)
        cost[:, c] += choice[k, np.arange(o)]
        back[:, c] = np.arange(o) + (k - 1)
    seam = np.zeros(w, np.int32)
    seam[-1] = int(cost[:, -1].argmin())
    for c in range(w - 1, 0, -1):
        seam[c - 1] = back[seam[c], c]
    return seam


def composite(old, new, seam, feather=3):
    """Mask over the overlap: 0 above the seam (old), 1 below (new), feathered."""
    rows = np.arange(O)[:, None].astype(np.float32)
    m = np.clip((rows - seam[None, :] + feather) / (2 * feather), 0, 1)[..., None]
    return old * (1 - m) + new * m


def pick(prev_tail_lum):
    cands = []
    for _ in range(260):
        y, x = int(rng.integers(H)), int(rng.integers(W))
        # No vertical flips: mirrored grain reads as V-shaped seams at arm's length.
        fu, fv = bool(rng.integers(2)), False
        _, g = block(y, x, fu, fv)
        e = float(((g[:O] - prev_tail_lum) ** 2).sum())
        cands.append((e, y, x, fu, fv))
    cands.sort(key=lambda c: c[0])
    tol = cands[0][0] * 1.15
    good = [c for c in cands if c[0] <= tol] or cands[:1]
    best = good[int(rng.integers(len(good)))]
    return best[1:]


total = L + O
out = np.zeros((total, W, 9), np.float32)
glum = np.zeros((total, W), np.float32)
b0, g0 = block(int(rng.integers(H)), int(rng.integers(W)), False, False)
out[:B], glum[:B] = b0, g0
pos = B - O
while pos + O < total:
    y, x, fu, fv = pick(glum[pos:pos + O])
    b, g = block(y, x, fu, fv)
    err = ((g[:O] - glum[pos:pos + O]) ** 2)
    seam = min_cut(err)
    n = min(B, total - pos)
    out[pos:pos + O] = composite(out[pos:pos + O], b[:O], seam)
    glum[pos:pos + O] = composite(glum[pos:pos + O, :, None], g[:O, :, None], seam)[..., 0]
    out[pos + O:pos + n] = b[O:n]
    glum[pos + O:pos + n] = g[O:n]
    pos += B - O

# Wrap: the extra O rows at the end overlap the first O rows, so the strip tiles along v too.
err = (glum[L:L + O] - glum[:O]) ** 2
seam = min_cut(err)
out[:O] = composite(out[L:L + O], out[:O], seam)
out = out[:L]

alb = np.clip(out[..., 0:3], 0, 1)
n = out[..., 3:6]
n /= np.linalg.norm(n, axis=2, keepdims=True) + 1e-6
ordm = np.clip(out[..., 6:9], 0, 1)


def save(a, name, q):
    Image.fromarray((a * 255 + 0.5).astype(np.uint8)).save(f'{OUT}/{name}', quality=q, method=6)


save(alb, 'wood_albedo.webp', 88)
save(n * 0.5 + 0.5, 'wood_normal.webp', 90)
save(ordm, 'wood_ord.webp', 88)
print('ok', alb.shape)
