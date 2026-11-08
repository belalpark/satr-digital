"""2D plan images for the web: a light base image + high-resolution tiles.

The base image is what every visitor loads (first view, whole plan). The tiles are only fetched by
plan2d.js for the part in view when the zoom asks for more pixels than the base has.

    python3 tools/plan_tiles.py MASTER.png            # MASTER = the high-resolution plan (4x the 1309x1201 grid)

Writes media/plan/office-2d.webp (base), media/plan/tiles/<x>_<y>.webp and updates office.plan2d.

The master used here is a 4x super-resolution (Real-ESRGAN x4plus, CPU) of the first-version plan
image at its native 1309x1201 resolution; see docs/superpowers/plans or the PR for the command.
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data' / 'office.json'
BASE_SCALE = 1.6   # base image px per plan unit (sharp at the whole-plan view on a 2x screen)
TILE = 1024        # tile size in master px
OVERLAP = 2        # px each tile extends into its neighbours (no hairline seams when scaled)
Q_BASE, Q_TILE = 80, 78


def main(master_path):
    data = json.loads(DATA.read_text(encoding='utf-8'))
    ref = data['office']['plan']['reference']
    pw, ph = ref['width'], ref['height']
    master = Image.open(master_path).convert('RGB')
    if abs(master.width / pw - master.height / ph) > 0.01:
        sys.exit(f'master {master.size} does not match the {pw}x{ph} plan grid')

    base = master.resize((round(pw * BASE_SCALE), round(ph * BASE_SCALE)), Image.LANCZOS)
    base_out = ROOT / 'media' / 'plan' / 'office-2d.webp'
    base.save(base_out, 'WEBP', quality=Q_BASE, method=6)

    tdir = ROOT / 'media' / 'plan' / 'tiles'
    tdir.mkdir(parents=True, exist_ok=True)
    for old in tdir.glob('*.webp'):
        old.unlink()
    cols = -(-master.width // TILE)
    rows = -(-master.height // TILE)
    total = 0
    for r in range(rows):
        for c in range(cols):
            x, y = c * TILE, r * TILE
            box = (x, y, min(x + TILE + OVERLAP, master.width), min(y + TILE + OVERLAP, master.height))
            out = tdir / f'{c}_{r}.webp'
            master.crop(box).save(out, 'WEBP', quality=Q_TILE, method=6)
            total += out.stat().st_size

    p2 = data['office']['plan2d']
    p2['image'] = 'media/plan/office-2d.webp'
    p2['width'], p2['height'] = base.size
    p2['tiles'] = {
        'path': 'media/plan/tiles/{x}_{y}.webp',
        'width': master.width,
        'height': master.height,
        'size': TILE,
        'overlap': OVERLAP,
        'cols': cols,
        'rows': rows,
        'source': 'تكبير 4× بالذكاء الاصطناعي (Real-ESRGAN x4plus) لصورة المخطط الأول بدقتها الأصلية 1309×1201',
    }
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'base {base.size} {base_out.stat().st_size // 1024} KB; {cols}x{rows} tiles, {total // 1024} KB total, '
          f'avg {total // (cols * rows) // 1024} KB')


if __name__ == '__main__':
    main(sys.argv[1])
