"""Publish the baked light maps: PNG renders -> WebP next to the web model, and record them in scene.json.

    python3 tools/twin/finish_light.py .twin-render/light            # after tools/twin/bake_light.py

Writes media/twin/web/light_<mood>_<a|b>.webp and scene.json's `light` block
({rect, gain, static, moods: {day: [a, b], night: [a, b]}}) that assets/js/twin3d.js reads.
"""
import hashlib
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = os.path.join(ROOT, 'media', 'twin', 'web')
QUALITY = 94


def main(src):
    with open(os.path.join(src, 'light.json'), encoding='utf-8') as fh:
        info = json.load(fh)
    moods = {}
    total = 0
    for mood in ('day', 'night'):
        files = []
        for which in ('a', 'b'):
            png = os.path.join(src, f'light_{mood}_{which}.png')
            if not os.path.exists(png):
                break
            name = f'light_{mood}_{which}.webp'
            out = os.path.join(WEB, name)
            Image.open(png).convert('RGB').save(out, 'WEBP', quality=QUALITY, method=6)
            total += os.path.getsize(out)
            with open(out, 'rb') as fh:
                stamp = hashlib.sha1(fh.read()).hexdigest()[:10]
            files.append(f'{name}?v={stamp}')  # images are cached for a month by the host: a re-bake gets a new address
            print(f'{name}: {os.path.getsize(out) // 1024} KB')
        if len(files) == 2:
            moods[mood] = files
    if 'day' not in moods:
        sys.exit('the day maps are required')
    moods.setdefault('night', moods['day'])
    scene_path = os.path.join(WEB, 'scene.json')
    with open(scene_path, encoding='utf-8') as fh:
        scene = json.load(fh)
    scene['light'] = {'rect': info['rect'], 'gain': info['gain'], 'static': info['static'], 'size': info['size'],
                      'samples': info['samples'], 'moods': moods}
    with open(scene_path, 'w', encoding='utf-8') as fh:
        json.dump(scene, fh, ensure_ascii=False, indent=1)
    print(f'scene.json updated; maps total {total // 1024} KB')


if __name__ == '__main__':
    main(sys.argv[1])
