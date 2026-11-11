"""Compose the film from the captured site frames: titles, feature lines, taps, cuts; one encoded file per scene.

    python3 tools/film/compose.py <capDir> <outDir> --preview 70,140,200   # full-size stills of chosen frames
    python3 tools/film/compose.py <capDir> <outDir>                        # every scene -> <outDir>/NN-name.mp4, then film.mp4
    python3 tools/film/compose.py <capDir> <outDir> --only 12-space-10,13-space-11   # scenes again (a scene and the next one: the cut fades from its last frame)

1080x1920, 30 fps, 58 s = 1740 frames: welcome 150, plan 90, twelve spaces of 120, closing card 60.
"""
import json
import os
import subprocess
import sys
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

CAP, OUT = sys.argv[1], sys.argv[2]
ARGS = sys.argv[3:]
W, H, FPS, K = 1080, 1920, 30, 2.5  # K: CSS px of the capture -> video px
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FONTS = os.path.join(ROOT, 'assets', 'fonts', 'IBMPlexSansArabic-%s.woff2')
NAVY, GOLD, SAND, WHITE = (5, 27, 48), (216, 180, 102), (244, 236, 228), (255, 255, 255)

manifest = json.load(open(os.path.join(CAP, 'manifest.json'), encoding='utf-8'))
content = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'content.json'), encoding='utf-8'))
office = json.load(open(os.path.join(ROOT, 'data', 'office.json'), encoding='utf-8'))
rooms = {r['id']: r for r in office['rooms']}
SPACES = content['spaces']


@lru_cache(maxsize=None)
def font(weight, size):
    return ImageFont.truetype(FONTS % weight, size, layout_engine=ImageFont.Layout.RAQM)


@lru_cache(maxsize=12)
def frame(path):
    im = Image.open(os.path.join(CAP, path)).convert('RGB')
    assert im.size == (W, H), (path, im.size)
    return im


def ease(k):
    k = min(1.0, max(0.0, k))
    return 1 - (1 - k) ** 3


def ramp(i, start, length):
    """0 before `start`, easing to 1 over `length` frames."""
    return ease((i - start) / float(length))


def text_size(text, f, rtl=True):
    x0, y0, x1, y1 = f.getbbox(text, direction='rtl' if rtl else 'ltr', language='ar' if rtl else 'en')
    return x0, y0, x1 - x0, y1 - y0


def draw_text(d, xy, text, f, fill, rtl=True):
    d.text(xy, text, font=f, fill=fill, direction='rtl' if rtl else 'ltr', language='ar' if rtl else 'en')


def text_layer(text, weight, size, fill, rtl=True, shadow=0):
    """RGBA picture of one line, tight around the ink (plus the room a soft shadow needs)."""
    f = font(weight, size)
    x0, y0, w, h = text_size(text, f, rtl)
    m = shadow * 3
    im = Image.new('RGBA', (w + 2 * m + 4, h + 2 * m + 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if shadow:
        from PIL import ImageFilter
        sh = Image.new('RGBA', im.size, (0, 0, 0, 0))
        draw_text(ImageDraw.Draw(sh), (m + 2 - x0, m + 2 - y0 + shadow // 2), text, f, (0, 0, 0, 190), rtl)
        im = sh.filter(ImageFilter.GaussianBlur(shadow))
        d = ImageDraw.Draw(im)
    draw_text(d, (m + 2 - x0, m + 2 - y0), text, f, fill + (255,), rtl)
    return im


def spaced_latin(text, weight, size, fill, gap):
    f = font(weight, size)
    widths = [f.getlength(ch) for ch in text]
    w = int(sum(widths) + gap * (len(text) - 1)) + 4
    asc, desc = f.getmetrics()
    im = Image.new('RGBA', (w, asc + desc + 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    x = 2
    for ch, cw in zip(text, widths):
        d.text((x, 2), ch, font=f, fill=fill + (255,))
        x += cw + gap
    return im.crop(im.getbbox())


def rounded(size, radius, fill, outline=None, width=0, ss=3):
    """Anti-aliased rounded rectangle (drawn large, scaled down)."""
    big = Image.new('RGBA', (size[0] * ss, size[1] * ss), (0, 0, 0, 0))
    ImageDraw.Draw(big).rounded_rectangle((0, 0, size[0] * ss - 1, size[1] * ss - 1), radius * ss, fill=fill, outline=outline, width=width * ss)
    return big.resize(size, Image.LANCZOS)


def chip(text):
    """A feature line: dark glass pill, gold edge, gold bullet at the reading side (right)."""
    t = text_layer(text, 'Medium', 42, WHITE)
    h = 76
    w = t.width + 30 + 24 + 16 + 30
    im = rounded((w, h), h // 2, NAVY + (205,), GOLD + (235,), 2)
    dot = rounded((18, 18), 9, GOLD + (255,))
    im.alpha_composite(dot, (w - 30 - 18, (h - 18) // 2))
    im.alpha_composite(t, (30, (h - t.height) // 2 - 1))
    return im


def card(lines, pad=(44, 30), gap=16, radius=30):
    """A caption card: centred lines on dark glass. lines = [(text, weight, size, colour)]."""
    layers = [text_layer(t, wgt, sz, col) for t, wgt, sz, col in lines]
    w = max(l.width for l in layers) + 2 * pad[0]
    h = sum(l.height for l in layers) + gap * (len(layers) - 1) + 2 * pad[1]
    im = rounded((w, h), radius, NAVY + (214,), GOLD + (220,), 2)
    y = pad[1]
    for l in layers:
        im.alpha_composite(l, ((w - l.width) // 2, y))
        y += l.height + gap
    return im


def put(base, layer, x, y, opacity=1.0):
    """Alpha-composite `layer` on the RGB frame at (x, y) with an overall opacity."""
    if opacity <= 0.003:
        return
    x, y = int(round(x)), int(round(y))
    if opacity < 0.997:
        layer = layer.copy()
        layer.putalpha(layer.getchannel('A').point(lambda v: int(v * opacity)))
    base.paste(layer, (x, y), layer)


@lru_cache(maxsize=64)
def ripple_layer(step, steps):
    """A tap: a white dot that fades while a gold ring grows."""
    p = step / float(steps - 1)
    ss, size = 3, 260
    im = Image.new('RGBA', (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = size * ss / 2
    r = (34 + 80 * ease(p)) * ss
    a = int(235 * (1 - p) ** 1.2)
    d.ellipse((c - r, c - r, c + r, c + r), outline=GOLD + (a,), width=int(7 * ss))
    rd = (30 - 6 * p) * ss
    d.ellipse((c - rd, c - rd, c + rd, c + rd), fill=WHITE + (int(215 * (1 - p * p)),))
    return im.resize((size, size), Image.LANCZOS)


def tap(base, box_css, i, start, steps=15):
    if start <= i < start + steps:
        cx = (box_css[0] + box_css[2] / 2) * K
        cy = (box_css[1] + box_css[3] / 2) * K
        put(base, ripple_layer(i - start, steps), cx - 130, cy - 130)


def blend(a, b, k):
    return a if k <= 0 else b if k >= 1 else Image.blend(a, b, k)


def progress(base, k, fill):
    """Twelve segments under the site's header: spaces seen, the current one filling up (right to left)."""
    x0, x1, y, hgt, gap, n = 44, 1036, 144, 6, 8, len(SPACES)
    seg = (x1 - x0 - gap * (n - 1)) / n
    ov = Image.new('RGBA', (x1 - x0, hgt), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for j in range(n):
        right = (x1 - x0) - j * (seg + gap)
        left = right - seg
        d.rounded_rectangle((left, 0, right, hgt - 1), 3, fill=WHITE + (60,))
        if j < k:
            d.rounded_rectangle((left, 0, right, hgt - 1), 3, fill=GOLD + (255,))
        elif j == k and fill > 0.02:
            d.rounded_rectangle((right - seg * fill, 0, right, hgt - 1), 3, fill=GOLD + (255,))
    put(base, ov, x0, y)


# ---------------------------------------------------------------- scenes
def scene_welcome(i):
    base = frame('welcome/f%03d.jpg' % i).copy()
    c = LAYERS['welcome_card']
    a = ramp(i, 54, 12) * (1 - ramp(i, 138, 9))
    put(base, c, (W - c.width) / 2, 250 + (1 - ramp(i, 54, 12)) * 26, a)
    tap(base, manifest['welcome']['cta'], i, 127, 17)
    return base


def scene_plan(i):
    if i < 27:
        if 'welcome_last' not in LAYERS:
            LAYERS['welcome_last'] = scene_welcome(149)
        base = blend(LAYERS['welcome_last'], frame('plan2d.jpg'), ramp(i + 1, 0, 6)).copy()
    else:
        base = blend(frame('plan2d.jpg'), frame('enter/f%03d.jpg' % (i - 27)), ramp(i - 26, 0, 5)).copy()
    c = LAYERS['plan_card']
    a = ramp(i, 5, 9) * (1 - ramp(i, 80, 8))
    put(base, c, (W - c.width) / 2, 402 + (1 - ramp(i, 5, 9)) * 22, a)
    tap(base, manifest['plan2d']['tab3d'], i, 11, 15)
    return base


def space_bands(sid):
    """Free bands of the photos page: above and below the picture inside the page's stage (video px)."""
    shots = manifest['photos'][sid]['shots']
    sx, sy, sw, sh = shots[0]['img']['stage']
    ph = max(sw * s['img']['nat'][1] / s['img']['nat'][0] for s in shots)  # the taller of the two pictures
    top = sy + (sh - ph) / 2
    return sy * K, top * K, (top + ph) * K, (sy + sh) * K


def scene_space(k):
    sp = SPACES[k]
    sid = sp['id']
    prev_last = (lambda: scene_plan(89)) if k == 0 else (lambda: scene_space(k - 1)(119))
    title = text_layer(rooms[sid]['name'], 'Bold', 104, GOLD, shadow=7)
    rule = rounded((132, 6), 3, GOLD + (255,))
    chips = [chip(t) for t in sp['features']]
    band_top, photo_top, photo_bottom, band_bottom = space_bands(sid)
    cache = {}

    def render(i):
        if i < 24:
            cur = frame('room-%02d/f%02d.jpg' % (k, i))
            if i < 5:
                if 'prev' not in cache:
                    cache['prev'] = prev_last()
                base = blend(cache['prev'], cur, ramp(i + 1, 0, 5)).copy()
            else:
                base = cur.copy()
        elif i < 36:
            base = frame('room-%02d/f23.jpg' % k).copy()
        else:
            p1, p2 = frame('photos-%s-1.jpg' % sid), frame('photos-%s-2.jpg' % sid)
            if i < 42:
                base = blend(frame('room-%02d/f23.jpg' % k), p1, ramp(i - 35, 0, 6)).copy()
            elif i < 78:
                base = p1.copy()
            else:
                base = blend(p1, p2, ramp(i - 77, 0, 8)).copy()
            # the room's name in the band above the picture, its features in the band below
            a = ramp(i, 40, 10)
            right = W - 50
            ty = band_top + (photo_top - band_top - title.height - 30) / 2
            put(base, title, right - title.width + 23 + (1 - a) * 40, ty, a)  # 23: the layer's shadow margin
            put(base, rule, right - rule.width + (1 - a) * 40, ty + title.height - 2, a)
            total = len(chips) * 76 + (len(chips) - 1) * 16
            cy = photo_bottom + (band_bottom - photo_bottom - total) / 2
            for j, c in enumerate(chips):
                ca = ramp(i, 50 + 8 * j, 9)
                put(base, c, right - c.width + (1 - ca) * 46, cy + j * 92, ca)
        tap(base, manifest['rooms'][sid]['photosBtn'], i, 24, 14)
        progress(base, k, (i + 1) / 120.0)
        return base

    return render


def end_card_layers():
    f = office['office']['footer']
    b = office['office']['brand']
    items = [
        (text_layer(b['name'], 'Bold', 118, WHITE), 0, 18),
        (spaced_latin(b['nameEn'], 'Medium', 34, GOLD, 13), 6, 40),
        (rounded((150, 4), 2, GOLD + (255,)), 10, 40),
        (text_layer(b['slogan'], 'Regular', 42, SAND), 14, 96),
        (text_layer(f['phones'][1]['label'], 'SemiBold', 44, GOLD), 20, 26),
        (text_layer(f['phones'][1]['display'], 'SemiBold', 66, WHITE, rtl=False), 24, 22),
        (text_layer(f['phones'][0]['display'], 'SemiBold', 66, WHITE, rtl=False), 28, 44),
        (text_layer(f['website']['label'], 'Medium', 46, GOLD, rtl=False), 32, 70),
        (text_layer(office['office']['welcome']['location'], 'Regular', 36, SAND), 36, 0),
    ]
    return items


def end_background():
    bg = Image.new('RGB', (W, H), NAVY)
    d = ImageDraw.Draw(bg)
    for y in range(H):  # a quiet vertical gradient, lighter toward the middle
        k = 1 - abs(y - H * 0.42) / (H * 0.62)
        k = max(0.0, k)
        d.line((0, y, W, y), fill=(int(5 + 9 * k), int(27 + 16 * k), int(48 + 24 * k)))
    frame_ = rounded((W - 96, H - 96), 36, (0, 0, 0, 0), GOLD + (120,), 2)
    bg.paste(frame_, (48, 48), frame_)
    return bg


def scene_end(i):
    if 'last_space' not in LAYERS:
        LAYERS['last_space'] = scene_space(len(SPACES) - 1)(119)
    base = blend(LAYERS['last_space'], LAYERS['end_bg'], ramp(i + 1, 0, 10)).copy()
    items = LAYERS['end_items']
    total = sum(l.height + g for l, _, g in items)
    y = (H - total) / 2 + 10
    for layer, delay, gap in items:
        a = ramp(i, 6 + delay * 0.55, 10)
        put(base, layer, (W - layer.width) / 2, y + (1 - a) * 24, a)
        y += layer.height + gap
    return base


LAYERS = {}


def build_layers():
    LAYERS['welcome_card'] = card([
        ('جولة رقمية كاملة للمكتب', 'SemiBold', 60, GOLD),
        ('مخطط تفاعلي · صور حقيقية · تفاصيل كل مساحة', 'Regular', 36, WHITE),
    ])
    LAYERS['plan_card'] = card([
        ('مخطط تفاعلي ثنائي وثلاثي الأبعاد', 'SemiBold', 52, GOLD),
        ('اضغط أي مساحة لعرض صورها وتفاصيلها', 'Regular', 36, WHITE),
    ])
    LAYERS['end_bg'] = end_background()
    LAYERS['end_items'] = end_card_layers()


def scenes():
    out = [('01-welcome', 150, scene_welcome), ('02-plan', 90, scene_plan)]
    for k in range(len(SPACES)):
        out.append(('%02d-space-%02d-%s' % (k + 3, k + 1, SPACES[k]['id']), 120, scene_space(k)))
    out.append(('15-end', 60, scene_end))
    return out


ENC = ['-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
       '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart']


def encode(name, n, render):
    tmp, final = os.path.join(OUT, name + '.part.mp4'), os.path.join(OUT, name + '.mp4')
    p = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (W, H), '-r', str(FPS), '-i', '-'] + ENC + [tmp], stdin=subprocess.PIPE)
    for i in range(n):
        p.stdin.write(render(i).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise SystemExit('ffmpeg failed on ' + name)
    os.replace(tmp, final)  # only a finished scene gets its real name
    print('scene', name, n, 'frames', flush=True)
    return final


def main():
    os.makedirs(OUT, exist_ok=True)
    build_layers()
    sc = scenes()
    assert sum(n for _, n, _ in sc) == 58 * FPS, sum(n for _, n, _ in sc)
    if '--preview' in ARGS:
        wanted = [int(x) for x in ARGS[ARGS.index('--preview') + 1].split(',')]
        for g in wanted:
            acc = 0
            for name, n, render in sc:
                if g < acc + n:
                    render(g - acc).save(os.path.join(OUT, 'preview-%04d.jpg' % g), quality=90)
                    print('preview', g, name, g - acc)
                    break
                acc += n
        return
    only = ARGS[ARGS.index('--only') + 1].split(',') if '--only' in ARGS else None
    for name, n, render in sc:
        if only is None or name in only or any(name.startswith(o) for o in only):
            encode(name, n, render)
    files = [os.path.join(OUT, name + '.mp4') for name, _, _ in sc]
    missing = [f for f in files if not os.path.exists(f)]
    if missing:
        print('not joined yet; missing:', [os.path.basename(m) for m in missing])
        return
    lst = os.path.join(OUT, 'scenes.txt')
    with open(lst, 'w') as fh:
        fh.writelines("file '%s'\n" % f for f in files)
    film = os.path.join(OUT, 'film.part.mp4')
    subprocess.check_call(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', '-movflags', '+faststart', film])
    os.replace(film, os.path.join(OUT, 'film.mp4'))
    print('film.mp4 written')


if __name__ == '__main__':
    main()
