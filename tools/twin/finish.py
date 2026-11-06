"""Turn the Blender renders into web assets.

    python3 tools/twin/finish.py --src .twin-render --out media/twin

Reads <src>/plan.png, <src>/focus-<room>.png and <src>/twin.json (written by
build_twin.py) and writes WebP files with alpha. A light bloom is added around
the brightest pixels (LED strips, lamp shades, lit screens) so the lighting
reads at web sizes; the focus crops get the same treatment scaled to their
resolution so the cross-fade from the full view stays seamless.
"""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageFilter


def bloom(im, radius, strength=0.32, threshold=0.78):
    rgba = np.asarray(im.convert('RGBA')).astype(np.float32) / 255.0
    rgb, alpha = rgba[..., :3], rgba[..., 3:4]
    lum = (rgb * np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)).sum(-1, keepdims=True)
    bright = np.clip((lum - threshold) / (1 - threshold), 0, 1) * alpha
    glow_src = Image.fromarray((np.clip(rgb * bright, 0, 1) * 255).astype(np.uint8))
    glow = np.asarray(glow_src.filter(ImageFilter.GaussianBlur(radius))).astype(np.float32) / 255.0
    glow_a = glow.max(-1, keepdims=True)
    out_rgb = rgb * alpha + glow * strength
    out_a = np.clip(alpha + glow_a * strength, 0, 1)
    out_rgb = np.clip(out_rgb / np.maximum(out_a, 1e-4), 0, 1)
    out = np.concatenate([out_rgb, out_a], -1)
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8), 'RGBA')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--quality', type=int, default=84)
    ap.add_argument('--radius', type=float, default=10.0, help='bloom radius in full-view pixels')
    ap.add_argument('--suffix', default='', help='source file suffix, e.g. -preview')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.src, 'twin.json'), encoding='utf-8') as fh:
        info = json.load(fh)
    full_w = info['image']['width']

    jobs = [('plan', 1.0)]
    for rid in info['focus']:
        jobs.append((f'focus-{rid}', 1.0 / info['focusFrame']))
    for name, k in jobs:
        src = os.path.join(args.src, f'{name}{args.suffix}.png')
        im = Image.open(src)
        # the full view and each crop are rendered at the same pixel size (the crop
        # at 1/focusFrame resolution); previews are smaller: keep bloom proportional
        size_k = im.width / full_w
        out = bloom(im, radius=max(1.0, args.radius * k * size_k))
        dst = os.path.join(args.out, f'{name}.webp')
        out.save(dst, 'WEBP', quality=args.quality, method=6, alpha_quality=90)
        print(f'{dst}: {out.size[0]}x{out.size[1]}, {os.path.getsize(dst) // 1024} KB')
    # publish the camera data with the images; tests/unit/data.test.mjs checks office.json against it
    with open(os.path.join(args.out, 'twin.json'), 'w', encoding='utf-8') as fh:
        json.dump(info, fh, ensure_ascii=False, indent=2)
        fh.write('\n')


if __name__ == '__main__':
    main()
