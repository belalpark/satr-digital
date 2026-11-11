"""Draw the space-type icons: small isometric scenes built from shaded boxes, written into assets/js/icons.js.

    python3 tools/make_icons.py                       # -> assets/js/icons.js
    python3 tools/make_icons.py --preview /tmp/icons.html  # the same, plus a page to look at them (not kept in the repo)

One icon per kind of space on the plan (data/office.json gives every room its `icon`). The pictures are
drawn here, not taken from an icon set: each is a handful of boxes in the model's own colours (white desks,
blue chairs, oak, stone, steel), projected isometrically with a lit top, a mid left face and a dark right
face, so they read as little 3D objects at 22-36 px. They ship inside a JS module as data: URLs, so the
plan's markers cost no extra requests and are versioned with the scripts.
"""
import json
import math
import os
import sys
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
C30, S30 = math.cos(math.radians(30)), math.sin(math.radians(30))

WHITE, OAK, WALNUT, BLUE, GREY = '#f1eee8', '#cf9a55', '#7b5536', '#3f5f96', '#8f98a6'
STONE, STEEL, DARK, CARD, GLASS, GREEN, GOLD = '#b9bcc2', '#aeb6c0', '#2b2f38', '#c9a36b', '#9fc3d4', '#5d9a55', '#d8b466'


def mix(c, t, k):
    a = [int(c[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(t[i:i + 2], 16) for i in (1, 3, 5)]
    return '#%02x%02x%02x' % tuple(round(a[i] + (b[i] - a[i]) * k) for i in range(3))


def iso(x, y, z):
    return ((x - y) * C30, (x + y) * S30 - z)


def box(x, y, z, w, d, h, colour, glow=False):
    return {'x': x, 'y': y, 'z': z, 'w': w, 'd': d, 'h': h, 'c': colour, 'glow': glow}


def faces(b):
    x, y, z, w, d, h = b['x'], b['y'], b['z'], b['w'], b['d'], b['h']
    top = [iso(x, y, z + h), iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x, y + d, z + h)]
    left = [iso(x, y + d, z + h), iso(x + w, y + d, z + h), iso(x + w, y + d, z), iso(x, y + d, z)]      # faces the viewer's left
    right = [iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x + w, y + d, z), iso(x + w, y, z)]     # faces the viewer's right
    c = b['c']
    if b['glow']:
        return [(top, c), (left, c), (right, c)]
    return [(top, mix(c, '#ffffff', 0.22)), (left, mix(c, '#000000', 0.08)), (right, mix(c, '#000000', 0.30))]


def svg(boxes, size=64, pad=5):
    # painter's order: far boxes first (smaller x + y), lower first
    order = sorted(boxes, key=lambda b: (b['x'] + b['w'] / 2 + b['y'] + b['d'] / 2, b['z']))
    polys = [f for b in order for f in faces(b)]
    xs = [p[0] for poly, _ in polys for p in poly]
    ys = [p[1] for poly, _ in polys for p in poly]
    k = (size - 2 * pad) / max(max(xs) - min(xs), max(ys) - min(ys))
    ox = (size - (max(xs) - min(xs)) * k) / 2 - min(xs) * k
    oy = (size - (max(ys) - min(ys)) * k) / 2 - min(ys) * k
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">']
    # the soft shadow the object stands on
    gx0, gx1 = min(b['x'] for b in boxes), max(b['x'] + b['w'] for b in boxes)
    gy0, gy1 = min(b['y'] for b in boxes), max(b['y'] + b['d'] for b in boxes)
    ground = [iso(gx0, gy0, 0), iso(gx1, gy0, 0), iso(gx1, gy1, 0), iso(gx0, gy1, 0)]
    cx = sum(p[0] for p in ground) / 4 * k + ox
    cy = sum(p[1] for p in ground) / 4 * k + oy
    rx = (max(p[0] for p in ground) - min(p[0] for p in ground)) * k / 2
    ry = (max(p[1] for p in ground) - min(p[1] for p in ground)) * k / 2
    out.append(f'<ellipse cx="{cx:.1f}" cy="{cy + 1.2:.1f}" rx="{rx * 0.94:.1f}" ry="{ry * 0.94:.1f}" fill="#000" opacity=".28"/>')
    for poly, colour in polys:
        pts = ' '.join(f'{px * k + ox:.1f},{py * k + oy:.1f}' for px, py in poly)
        out.append(f'<polygon points="{pts}" fill="{colour}" stroke="{mix(colour, "#000000", 0.45)}" stroke-width=".5" stroke-linejoin="round"/>')
    out.append('</svg>')
    return ''.join(out)


def chair(x, y, facing='y+', c=BLUE):
    """A seat with its back; `facing` says which way the sitter looks."""
    seat = box(x, y, 1.6, 2.2, 2.2, 0.7, c)
    back = {'y+': box(x, y, 2.3, 2.2, 0.5, 2.4, c), 'y-': box(x, y + 1.7, 2.3, 2.2, 0.5, 2.4, c),
            'x+': box(x, y, 2.3, 0.5, 2.2, 2.4, c), 'x-': box(x + 1.7, y, 2.3, 0.5, 2.2, 2.4, c)}[facing]
    return [box(x + 0.8, y + 0.8, 0, 0.6, 0.6, 1.6, DARK), seat, back]


def desk(x, y, w=8, d=4):
    return [box(x, y, 0, 0.5, d, 3.4, GREY), box(x + w - 0.5, y, 0, 0.5, d, 3.4, GREY), box(x, y, 3.4, w, d, 0.5, WHITE)]


ICONS = {
    # an office: a desk with its screen and a chair
    'desk': desk(0, 0) + [box(3, 0.6, 3.9, 2.6, 0.4, 2.2, DARK), box(4, 0.7, 3.9, 0.6, 0.3, 0.5, DARK)] + chair(2.9, 5.0, 'y-'),
    # staff desks: two desks face to face with a low screen between them
    'desks': desk(0, 0, 9, 3.2) + desk(0, 3.6, 9, 3.2) + [box(0.4, 3.2, 3.9, 8.2, 0.4, 1.5, GLASS), box(1.4, 0.8, 3.9, 2.2, 0.3, 1.7, DARK), box(5.4, 0.8, 3.9, 2.2, 0.3, 1.7, DARK),
                                                           box(1.4, 5.7, 3.9, 2.2, 0.3, 1.7, DARK), box(5.4, 5.7, 3.9, 2.2, 0.3, 1.7, DARK)]
             + chair(1.4, -2.9, 'y+') + chair(5.4, -2.9, 'y+') + chair(1.4, 7.5, 'y-') + chair(5.4, 7.5, 'y-'),
    # a meeting room: a long table with chairs on both sides
    'meeting': [box(0, 0, 0, 0.6, 4, 3.2, WALNUT), box(11.4, 0, 0, 0.6, 4, 3.2, WALNUT), box(-0.4, -0.3, 3.2, 12.8, 4.6, 0.6, OAK)]
               + chair(0.6, -3.0, 'y+') + chair(4.9, -3.0, 'y+') + chair(9.2, -3.0, 'y+') + chair(0.6, 4.8, 'y-') + chair(4.9, 4.8, 'y-') + chair(9.2, 4.8, 'y-'),
    # a lounge: an L sofa and a low table
    'sofa': [box(0, 0, 0, 10, 3.4, 1.7, GREY), box(0, 0, 1.7, 10, 1.0, 2.2, GREY), box(0, 3.4, 0, 3.4, 4.4, 1.7, GREY), box(0, 3.4, 1.7, 1.0, 4.4, 2.2, GREY),
             box(1.2, 1.2, 1.7, 3.6, 2.0, 0.6, mix(GREY, '#ffffff', 0.25)), box(5.4, 1.2, 1.7, 3.6, 2.0, 0.6, mix(GREY, '#ffffff', 0.25)),
             box(5.6, 5.2, 0, 3.4, 2.4, 1.3, OAK)],
    # the reception: an angled counter in oak and stone with a screen
    'counter': [box(0, 0, 0, 10, 2.6, 4.2, STONE), box(-0.3, -0.3, 4.2, 10.6, 3.2, 0.6, OAK), box(7.4, 2.6, 0, 2.6, 5.0, 4.2, STONE), box(7.1, 2.3, 4.2, 3.2, 5.6, 0.6, OAK),
                box(0, 0.3, 0, 10, 0.3, 0.5, GOLD, True), box(3.2, 3.6, 3.2, 2.4, 0.4, 2.0, DARK)] + chair(3.2, 5.0, 'y-', DARK),
    # the indoor bleachers: wide wooden steps
    'steps': [box(0, 0, 0, 11, 9, 1.5, OAK), box(0, 0, 1.5, 11, 6, 1.5, OAK), box(0, 0, 3.0, 11, 3, 1.5, OAK),
              box(1.2, 6.6, 1.5, 2.6, 1.8, 0.5, GREY), box(6.6, 3.6, 3.0, 2.6, 1.8, 0.5, GREY)],
    # washrooms: a basin on its unit, a mirror, a stall panel
    'wc': [box(0, 0, 0, 0.5, 8, 7.5, STONE), box(0.5, 1.0, 0, 3.0, 5.6, 3.2, WHITE), box(0.4, 0.8, 3.2, 3.3, 6.0, 0.5, mix(STONE, '#ffffff', 0.4)),
           box(1.4, 3.0, 3.7, 1.4, 1.6, 0.5, STEEL), box(0.5, 2.2, 4.8, 0.2, 3.2, 2.2, GLASS), box(0, 8, 0, 6.5, 0.5, 7.5, mix(STONE, '#000000', 0.12))],
    # the store: stacked boxes
    'boxes': [box(0, 0, 0, 4.4, 4.4, 3.8, CARD), box(4.9, 0.4, 0, 4.0, 4.0, 3.2, CARD), box(1.2, 4.9, 0, 4.2, 3.8, 3.0, mix(CARD, '#000000', 0.1)),
              box(0.9, 0.7, 3.8, 3.2, 3.2, 2.8, mix(CARD, '#ffffff', 0.12)), box(0.9, 2.0, 3.8, 3.2, 0.5, 2.82, GOLD), box(1.2, 6.5, 0, 4.2, 0.5, 3.02, GOLD)],
    # the server room: a dark rack with its lights
    'server': [box(0, 0, 0, 5, 5.4, 11, DARK), box(5.0, 0.7, 8.6, 0.12, 4.0, 0.5, '#59c8ff', True), box(5.0, 0.7, 7.0, 0.12, 4.0, 0.5, '#59c8ff', True),
               box(5.0, 0.7, 5.4, 0.12, 4.0, 0.5, '#7dffb0', True), box(5.0, 0.7, 3.8, 0.12, 4.0, 0.5, '#59c8ff', True), box(5.0, 0.7, 2.2, 0.12, 4.0, 0.5, '#59c8ff', True),
               box(-0.3, -0.3, 11, 5.6, 6.0, 0.4, mix(DARK, '#ffffff', 0.18))],
    # the lift lobby: steel doors in a dark wall, a call panel
    'lift': [box(0, 0, 0, 1.2, 12, 11, DARK), box(1.2, 1.4, 0, 0.25, 4.2, 9, STEEL), box(1.2, 5.8, 0, 0.25, 4.2, 9, STEEL), box(1.2, 1.1, 9, 0.5, 9.2, 0.5, mix(STEEL, '#000000', 0.25)),
             box(1.2, 10.6, 4.4, 0.3, 0.7, 1.6, GOLD, True), box(1.2, 0, 0, 5.5, 12, 0.3, STONE)],
    # the corridors: a tiled way between glass walls
    'corridor': [box(0, 0, 0, 5.2, 13, 0.4, STONE), box(-0.4, 0, 0, 0.4, 13, 5.2, GLASS), box(5.2, 0, 0, 0.4, 13, 5.2, GLASS),
                 box(1.9, 1.6, 0.4, 1.4, 1.4, 0.12, GOLD, True), box(1.9, 5.6, 0.4, 1.4, 1.4, 0.12, GOLD, True), box(1.9, 9.6, 0.4, 1.4, 1.4, 0.12, GOLD, True),
                 box(-0.4, 0, 5.2, 0.4, 13, 0.3, DARK), box(5.2, 0, 5.2, 0.4, 13, 0.3, DARK)],
}


def main():
    pics = {name: svg(boxes) for name, boxes in ICONS.items()}
    lines = ['// Space-type icons as data: URLs. Generated by tools/make_icons.py — edit the boxes there, not here.',
             'export const ICONS = {']
    for name, s in pics.items():
        lines.append(f"  {json.dumps(name)}: 'data:image/svg+xml,{quote(s, safe='')}',".replace("'data", '"data').replace("',", '",'))
    lines += ['};', '']
    with open(os.path.join(ROOT, 'assets', 'js', 'icons.js'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))
    cells = ''.join(f'<figure><img src="data:image/svg+xml,{quote(s, safe="")}" width="96"><img src="data:image/svg+xml,{quote(s, safe="")}" width="30"><img src="data:image/svg+xml,{quote(s, safe="")}" width="22"><figcaption>{n}</figcaption></figure>' for n, s in pics.items())
    if '--preview' in sys.argv:
        with open(sys.argv[sys.argv.index('--preview') + 1], 'w', encoding='utf-8') as fh:
            fh.write(f'<!doctype html><meta charset="utf-8"><body style="margin:0;background:#12161d;color:#ddd;font:13px sans-serif"><div style="display:flex;flex-wrap:wrap;gap:18px;padding:20px">{cells}</div><style>figure{{margin:0;display:grid;justify-items:center;gap:6px;padding:10px;background:#1b2028;border-radius:12px}}</style>')
    print(len(pics), 'icons;', sum(len(s) for s in pics.values()), 'bytes of SVG')


if __name__ == '__main__':
    main()
