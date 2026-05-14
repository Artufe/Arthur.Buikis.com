"""Generate favicon set for Arts-site.

Design:
- Hard-edged square (matches the site's `border-radius: 0` rule).
- Accent #FFB84D background, near-black #0F0F0F "ab" wordmark.
- Lowercase to match `site.brand = 'ab.'`.

Outputs to ../public/:
  favicon.ico          (16+32 multi-res)
  favicon-16x16.png
  favicon-32x32.png
  apple-touch-icon.png (180x180, with safe padding for iOS rounding)
  android-chrome-192x192.png
  android-chrome-512x512.png
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ACCENT = (255, 184, 77)
INK = (15, 15, 15)
WORDMARK = "ab"

PUBLIC = Path(__file__).resolve().parent.parent / "public"
PUBLIC.mkdir(exist_ok=True)


def find_bold_font():
    """Return the path to a bold sans-serif font on this system."""
    candidates = [
        "arialbd.ttf",
        "arial.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    for c in candidates:
        try:
            ImageFont.truetype(c, 12)
            return c
        except Exception:
            pass
    return None


FONT_PATH = find_bold_font()


def fit_font(text: str, target_w: int, target_h: int) -> ImageFont.FreeTypeFont:
    """Find the largest font size whose `text` fits inside (target_w, target_h)."""
    lo, hi = 4, max(target_w, target_h) * 2
    best = ImageFont.truetype(FONT_PATH, lo)
    while lo <= hi:
        mid = (lo + hi) // 2
        f = ImageFont.truetype(FONT_PATH, mid)
        bbox = f.getbbox(text)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        if w <= target_w and h <= target_h:
            best = f
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def render_square(size: int, padding_ratio: float = 0.18) -> Image.Image:
    """Render a square `ab` icon at the given size."""
    img = Image.new("RGBA", (size, size), ACCENT + (255,))
    draw = ImageDraw.Draw(img)

    pad = int(size * padding_ratio)
    box_w = size - 2 * pad
    box_h = size - 2 * pad

    font = fit_font(WORDMARK, box_w, box_h)
    bbox = font.getbbox(WORDMARK)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (size - text_w) // 2 - bbox[0]
    y = (size - text_h) // 2 - bbox[1]
    draw.text((x, y), WORDMARK, font=font, fill=INK)
    return img


def render_apple(size: int = 180) -> Image.Image:
    """Apple touch icon — slightly more padding so iOS's mask-rounding doesn't clip the wordmark."""
    return render_square(size, padding_ratio=0.20)


def main():
    png16 = render_square(16, padding_ratio=0.10)
    png32 = render_square(32, padding_ratio=0.14)
    png48 = render_square(48, padding_ratio=0.16)

    png16.save(PUBLIC / "favicon-16x16.png", "PNG", optimize=True)
    png32.save(PUBLIC / "favicon-32x32.png", "PNG", optimize=True)

    # Multi-resolution .ico — Pillow embeds each given Image into one ICO.
    png32.save(
        PUBLIC / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=[png16, png48],
    )

    apple = render_apple(180)
    apple.save(PUBLIC / "apple-touch-icon.png", "PNG", optimize=True)

    a192 = render_square(192)
    a192.save(PUBLIC / "android-chrome-192x192.png", "PNG", optimize=True)
    a512 = render_square(512)
    a512.save(PUBLIC / "android-chrome-512x512.png", "PNG", optimize=True)

    print("wrote:")
    for name in (
        "favicon.ico",
        "favicon-16x16.png",
        "favicon-32x32.png",
        "apple-touch-icon.png",
        "android-chrome-192x192.png",
        "android-chrome-512x512.png",
    ):
        path = PUBLIC / name
        print(f"  {path.relative_to(PUBLIC.parent)}  ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
