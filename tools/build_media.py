#!/usr/bin/env python3
"""Build the web-ready media set from the original photos.

The originals (5184x3456 JPEGs) are NOT committed to the repository. This script
documents exactly how every published image was derived from them so the step
can be repeated when new rooms are added.

Usage:
    python3 tools/build_media.py --src "/path/to/المكتب" --plan render.jpg \
        --hero IMG_0148.JPG --manifest tools/media_manifest.json

The manifest maps room ids to ordered lists of source files (optionally already
cleaned by tools/clean_photo.py). Outputs:
    media/plan/dollhouse.webp              2x Lanczos upscale of the dollhouse render
    media/hero/welcome.webp                2200px wide welcome photo
    media/rooms/<id>/NN.webp               1800px long side, quality 82
    media/rooms/<id>/thumbs/NN.webp        480px long side, quality 75
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageFilter, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(path):
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    return im.convert("RGB")


def fit(im, long_side):
    im = im.copy()
    im.thumbnail((long_side, long_side), Image.LANCZOS)
    return im


def save_webp(im, rel, quality):
    out = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out, "WEBP", quality=quality, method=6)
    return os.path.getsize(out)


def build_plan(src):
    im = load(src)
    big = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
    big = big.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
    size = save_webp(big, "media/plan/dollhouse.webp", 82)
    print(f"plan  {big.size}  {size/1024:.0f} KB")


def build_hero(src):
    im = load(src)
    im = fit(im, 2200)
    size = save_webp(im, "media/hero/welcome.webp", 80)
    print(f"hero  {im.size}  {size/1024:.0f} KB")


def build_rooms(src_dir, manifest, model_path=None, clean_dir=None):
    """manifest: {room_id: [ "IMG.JPG" | {"file": "IMG.JPG", "masks": ["x,y,w,h", ...]} ]}

    Entries with masks are passed through tools/clean_photo.py (LaMa inpainting)
    before resizing, so logos/people never reach the published set. If a
    previously cleaned copy exists in --clean-dir (same base name, .jpg) it is
    used instead of running the model again.
    """
    from clean_photo import clean  # same directory

    for room_id, entries in manifest.items():
        if room_id.startswith("_"):
            continue  # comments / metadata
        for i, entry in enumerate(entries, start=1):
            name = entry if isinstance(entry, str) else entry["file"]
            masks = [] if isinstance(entry, str) else entry.get("masks", [])
            fills = [] if isinstance(entry, str) else entry.get("fills", [])
            path = name if os.path.isabs(name) else os.path.join(src_dir, name)
            cleaned = os.path.join(clean_dir, os.path.splitext(os.path.basename(name))[0] + ".jpg") if clean_dir else None
            if masks and cleaned and os.path.exists(cleaned):
                im = load(cleaned)  # inpainting already done; only the screen fills remain
                masks = []
            else:
                im = load(path)
            shapes = [("rect", tuple(int(v) for v in m.split(","))) for m in masks]
            shapes += [("fill", [tuple(int(v) for v in pair.split(",")) for pair in f.split()]) for f in fills]
            if shapes:
                im, _ = clean(im, shapes, model_path)
            full = fit(im, 1800)
            thumb = fit(im, 480)
            s1 = save_webp(full, f"media/rooms/{room_id}/{i:02d}.webp", 82)
            s2 = save_webp(thumb, f"media/rooms/{room_id}/thumbs/{i:02d}.webp", 75)
            flag = " (cleaned)" if (masks or fills or (cleaned and os.path.exists(cleaned))) else ""
            print(f"{room_id}/{i:02d}  {os.path.basename(path)}{flag}  {s1/1024:.0f} KB / {s2/1024:.0f} KB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="directory with the original photos")
    ap.add_argument("--plan", help="dollhouse render source image")
    ap.add_argument("--hero", help="welcome photo (file name inside --src or absolute)")
    ap.add_argument("--manifest", help="JSON: {room_id: [file | {file, masks}, ...]}")
    ap.add_argument("--model", default=os.environ.get("LAMA_MODEL", ""), help="path to big-lama.pt (optional)")
    ap.add_argument("--clean-dir", help="directory with already-cleaned copies (IMG_xxxx.jpg)")
    args = ap.parse_args()
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    if args.plan:
        build_plan(args.plan)
    if args.hero:
        hero = args.hero if os.path.isabs(args.hero) else os.path.join(args.src, args.hero)
        build_hero(hero)
    if args.manifest:
        with open(args.manifest, encoding="utf-8") as f:
            build_rooms(args.src, json.load(f), args.model, args.clean_dir)


if __name__ == "__main__":
    sys.exit(main())
