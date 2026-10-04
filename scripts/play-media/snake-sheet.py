# python3 scripts/play-media/snake-sheet.py out.png cols thumbW file1 file2 ...  (labels = basename)
import sys
from PIL import Image, ImageDraw
out, cols, tw = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
files = sys.argv[4:]
ims = [Image.open(f).convert('RGB') for f in files]
th = round(tw * ims[0].height / ims[0].width)
rows = (len(ims) + cols - 1) // cols
pad = 6
sheet = Image.new('RGB', (cols * tw + (cols + 1) * pad, rows * (th + 18) + (rows + 1) * pad), (24, 24, 24))
d = ImageDraw.Draw(sheet)
for i, (im, f) in enumerate(zip(ims, files)):
    x = pad + (i % cols) * (tw + pad); y = pad + (i // cols) * (th + 18 + pad)
    sheet.paste(im.resize((tw, th), Image.LANCZOS), (x, y + 18))
    d.text((x + 2, y + 3), f.split('/')[-1] if len(sys.argv[4:]) else '', fill=(230, 230, 230))
sheet.save(out)
