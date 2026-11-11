"""Publish the room close-ups: PNG renders -> WebP, registered in data/office.json with fingerprinted addresses.

    .blender/bin/python tools/twin/build_twin.py --room ceo,lounge --daylight --res 1600x1000 --samples 48 --out .twin-render
    python3 tools/twin/finish_rooms.py .twin-render        # room-<id>.png -> media/twin/rooms/<id>.webp + office.json
    python3 tools/twin/finish_rooms.py --restamp           # only refresh the fingerprints from the files on disk
    python3 tools/twin/finish_rooms.py --office plan.png corridors   # the whole-office view for a space with no room of its own

The whole-office view is the angled plan render (build_twin.py --daylight --focus '' --pitch 46). Its background is
transparent; it is laid on the backdrop colour of the room close-ups so the details page shows one family of pictures.

The host caches images for a month, so every address carries the first 10 hex digits of the file's SHA-1
(`media/twin/rooms/ceo.webp?v=0123456789`): a re-rendered room is seen at once instead of a month later.
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'media' / 'twin' / 'rooms'
DATA = ROOT / 'data' / 'office.json'
WIDTH = 1600
QUALITY = 82
BACKDROP = (185, 190, 200)  # the sky-grey behind the room close-ups


def stamp(path):
    return hashlib.sha1(path.read_bytes()).hexdigest()[:10]


def main(argv):
    data = json.loads(DATA.read_text(encoding='utf-8'))
    by_id = {r['id']: r for r in data['rooms']}
    if argv and argv[0] == '--office':
        from PIL import Image
        png, rid = Path(argv[1]), argv[2]
        im = Image.open(png).convert('RGBA')
        flat = Image.new('RGBA', im.size, BACKDROP + (255,))
        flat.alpha_composite(im)
        flat = flat.convert('RGB')
        if flat.width > WIDTH:
            flat = flat.resize((WIDTH, round(flat.height * WIDTH / flat.width)), Image.LANCZOS)
        OUT.mkdir(parents=True, exist_ok=True)
        flat.save(OUT / f'{rid}.webp', 'WEBP', quality=QUALITY, method=6)
        by_id[rid]['render'] = {'image': f'media/twin/rooms/{rid}.webp', 'width': flat.width, 'height': flat.height, 'scope': 'office'}
    elif argv and argv[0] != '--restamp':
        from PIL import Image
        OUT.mkdir(parents=True, exist_ok=True)
        for png in sorted(Path(argv[0]).glob('room-*.png')):
            rid = png.stem[len('room-'):]
            if rid not in by_id:
                print('skip (unknown room)', rid)
                continue
            im = Image.open(png).convert('RGB')
            if im.width > WIDTH:
                im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
            im.save(OUT / f'{rid}.webp', 'WEBP', quality=QUALITY, method=6)
            keep = {k: v for k, v in (by_id[rid].get('render') or {}).items() if k == 'scope'}
            by_id[rid]['render'] = {'image': f'media/twin/rooms/{rid}.webp', 'width': im.width, 'height': im.height, **keep}
    # every registered render gets the fingerprint of the file that is on disk now
    done = 0
    for r in data['rooms']:
        render = r.get('render')
        if not render:
            continue
        rel = render['image'].split('?')[0]
        render['image'] = f'{rel}?v={stamp(ROOT / rel)}'
        done += 1
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{done} room renders registered with their fingerprints')


if __name__ == '__main__':
    main(sys.argv[1:])
