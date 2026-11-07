#!/usr/bin/env python3
"""Remove logos / people from a photo by inpainting selected regions.

Uses the LaMa model (TorchScript "big-lama.pt") when available, otherwise falls
back to OpenCV Telea inpainting. Only a crop around each mask region is sent
through the model so full-resolution originals stay sharp elsewhere.

Usage:
    python3 tools/clean_photo.py --in IMG_0287.JPG --out clean/IMG_0287.jpg \
        --rect 2410,1720,120,260 --rect 3010,1600,140,300 [--model models/big-lama.pt]
    python3 tools/clean_photo.py ... --preview preview.jpg   # side-by-side check

Rectangles are x,y,w,h in the original (EXIF-corrected) pixel grid.
Polygons can be given with --poly "x1,y1 x2,y2 x3,y3 ...".
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageOps

_MODEL = None


def load_model(path):
    global _MODEL
    if _MODEL is None:
        import torch
        _MODEL = torch.jit.load(path, map_location="cpu")
        _MODEL.eval()
    return _MODEL


def lama_inpaint(model, image_rgb, mask):
    """image_rgb: HxWx3 uint8, mask: HxW uint8 (255 = fill). Returns HxWx3 uint8."""
    import torch
    h, w = mask.shape
    pad_h = (8 - h % 8) % 8
    pad_w = (8 - w % 8) % 8
    img = np.pad(image_rgb, ((0, pad_h), (0, pad_w), (0, 0)), mode="reflect")
    msk = np.pad(mask, ((0, pad_h), (0, pad_w)), mode="constant")
    img_t = torch.from_numpy(img).permute(2, 0, 1).float().unsqueeze(0) / 255.0
    msk_t = torch.from_numpy((msk > 127).astype(np.float32)).unsqueeze(0).unsqueeze(0)
    with torch.inference_mode():
        out = model(img_t, msk_t)
    out = (out[0].permute(1, 2, 0).clamp(0, 1).numpy() * 255).astype(np.uint8)
    return out[:h, :w]


def cv_inpaint(image_rgb, mask):
    import cv2
    bgr = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)
    out = cv2.inpaint(bgr, mask, 5, cv2.INPAINT_TELEA)
    return cv2.cvtColor(out, cv2.COLOR_BGR2RGB)


def region_bbox(mask):
    ys, xs = np.where(mask > 0)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


SCREEN_COLOR = (14, 16, 20)


def fill_screen(image, polygon):
    """Paint a display panel as if switched off: flat dark fill with a faint
    diagonal sheen, anti-aliased edges. Used for TV screens that show the
    current tenant's calendar, names or QR codes."""
    w, h = image.size
    scale = 4
    mask = Image.new("L", (w * scale, h * scale), 0)
    ImageDraw.Draw(mask).polygon([(x * scale, y * scale) for x, y in polygon], fill=255)
    mask = mask.resize((w, h), Image.LANCZOS)
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    sheen = np.zeros((h, w), dtype=np.float32)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    t = ((xx - x0) / max(1, x1 - x0) * 0.6 + (yy - y0) / max(1, y1 - y0) * 0.4)
    sheen[y0:y1, x0:x1] = 1.0 - np.abs(t - 0.35) * 1.4
    sheen = np.clip(sheen, 0, 1) * 18  # up to +18 brightness
    panel = np.zeros((h, w, 3), dtype=np.float32)
    panel[:, :] = SCREEN_COLOR
    panel += sheen[:, :, None]
    panel = Image.fromarray(np.clip(panel, 0, 255).astype(np.uint8))
    return Image.composite(panel, image, mask)


def _shape_bbox(kind, s):
    if kind == "rect":
        x, y, rw, rh = s
        return x, y, x + rw, y + rh
    xs = [p[0] for p in s]
    ys = [p[1] for p in s]
    return min(xs), min(ys), max(xs), max(ys)


def _group_shapes(shapes, gap):
    """Cluster shapes whose bounding boxes come within `gap` px of each other, so
    regions far apart are inpainted in separate crops (a crop spanning the whole
    photo would not fit in memory)."""
    boxes = [_shape_bbox(k, s) for k, s in shapes]
    groups = []
    used = [False] * len(shapes)
    for i in range(len(shapes)):
        if used[i]:
            continue
        group = [i]
        used[i] = True
        changed = True
        while changed:
            changed = False
            gx0 = min(boxes[j][0] for j in group) - gap
            gy0 = min(boxes[j][1] for j in group) - gap
            gx1 = max(boxes[j][2] for j in group) + gap
            gy1 = max(boxes[j][3] for j in group) + gap
            for j in range(len(shapes)):
                if used[j]:
                    continue
                bx0, by0, bx1, by1 = boxes[j]
                if bx0 <= gx1 and bx1 >= gx0 and by0 <= gy1 and by1 >= gy0:
                    group.append(j)
                    used[j] = True
                    changed = True
        groups.append([shapes[j] for j in group])
    return groups


def clean(image, shapes, model_path=None, context=2.0, min_crop=512, feather=12, max_crop=2600, max_infer=1100):
    """image: PIL RGB. shapes: list of
    ("rect", (x,y,w,h)) / ("poly", [(x,y),...]) → inpainted (LaMa / OpenCV)
    ("fill", [(x,y),...])                        → painted as a switched-off screen
    Regions far apart are inpainted one crop at a time (bounded by max_crop px).
    """
    for kind, s in shapes:
        if kind == "fill":
            image = fill_screen(image, s)
    shapes = [sh for sh in shapes if sh[0] != "fill"]
    w, h = image.size
    full_mask = Image.new("L", (w, h), 0)
    if not shapes:
        return image, full_mask

    model = None
    if model_path and os.path.exists(model_path):
        try:
            model = load_model(model_path)
        except Exception as exc:  # pragma: no cover
            print(f"LaMa unavailable ({exc}); falling back to OpenCV", file=sys.stderr)

    import cv2
    out = np.array(image)
    fd = ImageDraw.Draw(full_mask)
    for group in _group_shapes(shapes, gap=int(min_crop * 0.6)):
        mask = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(mask)
        for kind, s in group:
            if kind == "rect":
                x, y, rw, rh = s
                d.rectangle([x, y, x + rw, y + rh], fill=255)
                fd.rectangle([x, y, x + rw, y + rh], fill=255)
            else:
                d.polygon(s, fill=255)
                fd.polygon(s, fill=255)
        mask_np = np.array(mask)
        x0, y0, x1, y1 = region_bbox(mask_np)
        bw, bh = x1 - x0, y1 - y0
        cw = min(max_crop, max(int(bw * context), min_crop), w)
        ch = min(max_crop, max(int(bh * context), min_crop), h)
        cw = max(cw, min(w, bw + 2 * feather + 8))
        ch = max(ch, min(h, bh + 2 * feather + 8))
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        cx0 = max(0, min(w - cw, cx - cw // 2))
        cy0 = max(0, min(h - ch, cy - ch // 2))
        cx1, cy1 = min(w, cx0 + cw), min(h, cy0 + ch)
        crop = out[cy0:cy1, cx0:cx1]
        crop_mask = mask_np[cy0:cy1, cx0:cx1]
        # dilate the mask a little so logo edges / halos are covered too
        kernel = np.ones((feather, feather), np.uint8)
        crop_mask = cv2.dilate(crop_mask, kernel, iterations=1)
        # LaMa memory grows with the crop area: infer large crops at <= max_infer px and scale the fill back
        ch_, cw_ = crop.shape[:2]
        long_side = max(ch_, cw_)
        if model and long_side > max_infer:
            k = max_infer / long_side
            small = cv2.resize(crop, (max(8, int(cw_ * k)), max(8, int(ch_ * k))), interpolation=cv2.INTER_AREA)
            small_mask = cv2.resize(crop_mask, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
            filled_small = lama_inpaint(model, small, small_mask)
            filled = cv2.resize(filled_small, (cw_, ch_), interpolation=cv2.INTER_CUBIC)
        else:
            filled = lama_inpaint(model, crop, crop_mask) if model else cv_inpaint(crop, crop_mask)
        sel = crop_mask > 0
        out[cy0:cy1, cx0:cx1][sel] = filled[sel]
    return Image.fromarray(out), full_mask


def parse_shapes(args):
    shapes = []
    for r in args.rect or []:
        shapes.append(("rect", tuple(int(v) for v in r.split(","))))
    for p in args.poly or []:
        pts = [tuple(int(v) for v in pair.split(",")) for pair in p.split()]
        shapes.append(("poly", pts))
    for p in args.fill or []:
        pts = [tuple(int(v) for v in pair.split(",")) for pair in p.split()]
        shapes.append(("fill", pts))
    return shapes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--rect", action="append", help="x,y,w,h (repeatable)")
    ap.add_argument("--poly", action="append", help='"x,y x,y x,y" (repeatable)')
    ap.add_argument("--fill", action="append", help='"x,y x,y x,y x,y" screen polygon painted as switched off (repeatable)')
    ap.add_argument("--model", default=os.environ.get("LAMA_MODEL", ""))
    ap.add_argument("--preview", help="write a downscaled before/after image")
    ap.add_argument("--quality", type=int, default=95)
    args = ap.parse_args()

    image = ImageOps.exif_transpose(Image.open(args.src)).convert("RGB")
    shapes = parse_shapes(args)
    result, mask = clean(image, shapes, args.model)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    result.save(args.out, quality=args.quality, subsampling=0)
    print(f"wrote {args.out} ({len(shapes)} region(s), model={'lama' if args.model and os.path.exists(args.model) else 'opencv'})")

    if args.preview:
        mask_np = np.array(mask)
        if mask_np.max() > 0:
            x0, y0, x1, y1 = region_bbox(mask_np)
        elif shapes:
            pts = [pt for _, s in shapes for pt in (s if isinstance(s, list) else [(s[0], s[1]), (s[0] + s[2], s[1] + s[3])])]
            x0, y0 = min(p[0] for p in pts), min(p[1] for p in pts)
            x1, y1 = max(p[0] for p in pts), max(p[1] for p in pts)
        else:
            x0, y0, x1, y1 = 0, 0, image.width, image.height
        pad = max(300, (x1 - x0), (y1 - y0))
        box = (max(0, x0 - pad), max(0, y0 - pad), min(image.width, x1 + pad), min(image.height, y1 + pad))
        before = image.crop(box)
        after = result.crop(box)
        scale = min(1.0, 900 / before.width)
        size = (int(before.width * scale), int(before.height * scale))
        sheet = Image.new("RGB", (size[0] * 2 + 10, size[1]), "white")
        sheet.paste(before.resize(size), (0, 0))
        sheet.paste(after.resize(size), (size[0] + 10, 0))
        sheet.save(args.preview, quality=85)


if __name__ == "__main__":
    main()
