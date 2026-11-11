"""Gallery cover images: one card-sized copy of each room's first photo.

The gallery shows two dozen cards; serving the full 1800 px photos there costs ~3 MB.
A 960 px cover (sharp on a retina card ~400 css px wide) is a fraction of that.

    python3 tools/make_covers.py            # writes media/rooms/<id>/cover.webp, sets room.cover
"""
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data' / 'office.json'
LONG_SIDE = 960
QUALITY = 76


def main():
    data = json.loads(DATA.read_text(encoding='utf-8'))
    total = 0
    for room in data['rooms']:
        photos = room.get('photos') or []
        if not (room.get('hasPhotos') and photos):
            room.pop('cover', None)
            continue
        src = ROOT / photos[0]['src']
        out = src.parent / 'cover.webp'
        im = Image.open(src).convert('RGB')
        im.thumbnail((LONG_SIDE, LONG_SIDE), Image.LANCZOS)
        im.save(out, 'WEBP', quality=QUALITY, method=6)
        room['cover'] = out.relative_to(ROOT).as_posix()
        total += out.stat().st_size
        print(f'{room["id"]:>16}: {im.size[0]}x{im.size[1]} {out.stat().st_size // 1024} KB')
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'total {total // 1024} KB')


if __name__ == '__main__':
    main()
