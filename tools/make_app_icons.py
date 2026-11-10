#!/usr/bin/env python3
"""The home-screen icon of the tour: the site's own mark (the gold diamond of the header) on its navy.

    python3 tools/make_app_icons.py     # -> assets/icons/app-192.png, app-512.png, app-maskable-512.png, apple-touch-icon.png

No company logo and no name: the same files ship in both builds (the one without a broker carries no
identity). The maskable icon keeps the mark inside the middle 60% so a round or squircle mask never cuts it.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "assets" / "icons"
NAVY, NAVY_2 = (5, 27, 48), (13, 39, 66)
GOLD, BRONZE = (227, 196, 124), (150, 108, 60)
S = 4  # supersampling


def icon(size, mark=0.46, radius=0.0):
    n = size * S
    # navy field, a little lighter toward the top-left like the site's header
    bg = Image.new("RGB", (n, n), NAVY)
    glow = Image.new("L", (n, n), 0)
    ImageDraw.Draw(glow).ellipse((-n * 0.35, -n * 0.45, n * 0.85, n * 0.75), fill=150)
    bg = Image.composite(Image.new("RGB", (n, n), NAVY_2), bg, glow.filter(ImageFilter.GaussianBlur(n * 0.16)))
    # the mark: a square with rounded corners, gold to bronze, turned 45 degrees
    side = int(n * mark)
    grad = Image.new("RGB", (side, side))
    px = grad.load()
    for y in range(side):
        for x in range(side):
            t = (x + y) / (2 * (side - 1))
            px[x, y] = tuple(round(GOLD[i] + (BRONZE[i] - GOLD[i]) * t) for i in range(3))
    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, side - 1, side - 1), radius=side * 0.2, fill=255)
    tile = Image.new("RGBA", (side, side))
    tile.paste(grad, (0, 0), mask)
    tile = tile.rotate(45, expand=True, resample=Image.BICUBIC)
    shadow = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    at = ((n - tile.width) // 2, (n - tile.height) // 2)
    shadow.paste((0, 0, 0, 120), (at[0], at[1] + int(n * 0.02)), tile.split()[3])
    out = bg.convert("RGBA")
    out.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(n * 0.025)))
    out.alpha_composite(tile, at)
    out = out.resize((size, size), Image.LANCZOS)
    if radius:
        m = Image.new("L", (size * S, size * S), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, size * S - 1, size * S - 1), radius=size * S * radius, fill=255)
        out.putalpha(m.resize((size, size), Image.LANCZOS))
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    icon(192, radius=0.2).save(OUT / "app-192.png", optimize=True)
    icon(512, radius=0.2).save(OUT / "app-512.png", optimize=True)
    icon(512, mark=0.36).convert("RGB").save(OUT / "app-maskable-512.png", optimize=True)  # full bleed, mark in the safe zone
    icon(180).convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)  # iOS rounds the corners itself
    for f in sorted(OUT.glob("*.png")):
        print(f.name, Image.open(f).size, f.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
