"""Bake the office lighting for the live viewer as top-down irradiance maps (Cycles).

    .blender/bin/python tools/twin/bake_light.py --out media/twin/web --res 3072 --samples 48

The live model is a dollhouse seen from above, so one orthographic render straight down holds the
light that reaches every surface a visitor can see: sun and sky, the warm ceiling pools, bounce
light with its colour, soft shadows and the contact shadows under the furniture. The viewer
(assets/js/twin3d.js) multiplies its own crisp material textures by these maps instead of running
real-time lights and shadow maps: it looks path-traced and costs less on the GPU.

Two maps per lighting mood, both seen by the same camera:
    light_<mood>_a   the building alone is visible (floors, platforms, wall tops, joinery); the
                     furniture is hidden from the camera but still shades and bounces, so the floor
                     under a desk carries its contact shadow
    light_<mood>_b   everything is visible: what the furniture's own top faces receive

How the picture becomes irradiance: every opaque material answers camera rays with a white
diffuse surface while every other ray (bounces, shadows) still meets the real material, so each
pixel is the light arriving at that spot (with coloured bounce), free of the surface's own colour.
Stored through the sRGB curve at a fixed exposure; scene.json records the gain to undo it.
"""
import argparse
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import build_twin as B  # noqa: E402
import layout as L  # noqa: E402

# Objects that are part of the building (map A). Everything else is loose furniture (map B).
STATIC = ('architecture', 'reception', 'feature_shelves', 'bleachers', 'platform', 'wc', 'core', 'tv_wall',
          'green_wall', 'rug', 'stage')
# materials the camera must keep seeing as they are: light passes through them or they are the light
KEEP = ('glass', 'glass_ext', 'frost', 'led', 'led_soft', 'lamp_shade', 'rack_led')

MARGIN = 7.0     # metres of ground around the building (soft shadow of the model on its table)
EXPOSURE = -1.0  # stops: keeps sunlit white under 1.0 in the 8-bit file; the viewer multiplies back
# azimuth: degrees clockwise from plan north (+y); elevation above the horizon
DAY = {'sun': 4.0, 'angle': 4.0, 'azimuth': 264.0, 'elevation': 50.0, 'sky': 0.38, 'pools': 60.0}
NIGHT = {'pools': 215.0, 'key': 260.0, 'sky': 0.10}


def is_static(obj):
    return obj.name.split('.')[0] in STATIC


def irradiance_materials():
    """Camera rays see a white diffuse surface; all other rays see the real material."""
    for mat in bpy.data.materials:
        if mat.name in KEEP or not mat.use_nodes:
            continue
        nt = mat.node_tree
        out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
        if not out or not out.inputs['Surface'].links:
            continue
        src = out.inputs['Surface'].links[0].from_socket
        white = nt.nodes.new('ShaderNodeBsdfDiffuse')
        white.inputs['Color'].default_value = (1, 1, 1, 1)
        white.inputs['Roughness'].default_value = 1.0
        path = nt.nodes.new('ShaderNodeLightPath')
        mix = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(path.outputs['Is Camera Ray'], mix.inputs['Fac'])
        nt.links.new(src, mix.inputs[1])
        nt.links.new(white.outputs['BSDF'], mix.inputs[2])
        nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])


def bounds():
    xs, ys = [], []
    for x, y in L.OUTLINE:
        p = B.W(x, y)
        xs.append(p.x)
        ys.append(p.y)
    for x0, y0, x1, y1 in L.FINS:
        for x, y in ((x0, y0), (x1, y1)):
            p = B.W(x, y)
            xs.append(p.x)
            ys.append(p.y)
    return min(xs) - MARGIN, min(ys) - MARGIN, max(xs) + MARGIN, max(ys) + MARGIN


def add_stage(col):
    """The table the model stands on: a large matte plane that catches the building's shadow."""
    b = B.Builder('stage')
    b.box('slab', (0, 0, -L.SLAB - 0.05), (240, 240, 0.1))
    return b.to_object(col)


def setup_camera(scene, rect, res):
    x0, y0, x1, y1 = rect
    w, h = x1 - x0, y1 - y0
    cam_data = bpy.data.cameras.new('top')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = max(w, h)
    cam_data.clip_start = 0.1
    cam_data.clip_end = 200
    cam = bpy.data.objects.new('top', cam_data)
    cam.location = ((x0 + x1) / 2, (y0 + y1) / 2, 60)
    cam.rotation_euler = (0, 0, 0)  # looks down -Z, image up = +Y
    scene.collection.objects.link(cam)
    scene.camera = cam
    if w >= h:
        scene.render.resolution_x, scene.render.resolution_y = res, max(4, round(res * h / w / 4) * 4)
    else:
        scene.render.resolution_x, scene.render.resolution_y = max(4, round(res * w / h / 4) * 4), res
    scene.render.resolution_percentage = 100


def configure(scene, samples):
    scene.render.engine = 'CYCLES'
    c = scene.cycles
    c.device = 'CPU'
    c.samples = samples
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.015
    c.use_denoising = True
    try:
        c.denoiser = 'OPENIMAGEDENOISE'
    except TypeError:
        pass
    c.max_bounces = 6
    c.diffuse_bounces = 4
    c.glossy_bounces = 2
    c.transmission_bounces = 6
    c.transparent_max_bounces = 16
    c.sample_clamp_indirect = 3.0
    c.caustics_reflective = False
    c.caustics_refractive = False
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.image_settings.color_depth = '8'
    scene.view_settings.view_transform = 'Standard'  # plain sRGB curve: the file is data, not a graded picture
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = EXPOSURE
    scene.view_settings.gamma = 1.0


def rig(mood, col, office, scene):
    """Lights for one mood. Returns the objects to remove before the next mood."""
    before = set(bpy.data.objects)
    if mood == 'day':
        # sun from the north-west, behind the default camera's left shoulder: the wall shadows fall toward
        # the viewer and to the right, where they can be seen; a dim blue sky keeps them deep and cool,
        # and the ceiling lights on low warm the rooms the sun does not reach
        B.build_lights(col, office, DAY['pools'])
        sun = bpy.data.lights.new('sun', 'SUN')
        sun.energy = DAY['sun']
        sun.angle = math.radians(DAY['angle'])
        sun.color = (1.0, 0.92, 0.80)
        so = bpy.data.objects.new('sun', sun)
        az, el = math.radians(DAY['azimuth']), math.radians(DAY['elevation'])
        to_sun = Vector((math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)))
        so.rotation_euler = (-to_sun).to_track_quat('-Z', 'Y').to_euler()
        col.objects.link(so)
        B.setup_world(scene, DAY['sky'], color=(0.55, 0.68, 0.95))
    else:
        # evening: the room lights carry the picture, a faint cool fill keeps the shadows readable
        B.build_lights(col, office, NIGHT['pools'])
        B.add_key_light(col, NIGHT['key'])
        B.setup_world(scene, NIGHT['sky'], color=(0.38, 0.44, 0.60))
    return [o for o in bpy.data.objects if o not in before]


def render(scene, path):
    scene.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print(f'  {os.path.basename(path)}: {scene.render.resolution_x}x{scene.render.resolution_y} in {time.time() - t:.0f}s', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, '.twin-render', 'light'))
    ap.add_argument('--res', type=int, default=3072, help='pixels along the longer side (day maps: crisp sun shadows)')
    ap.add_argument('--res-night', type=int, default=2048, help='the evening light is soft: fewer pixels carry it')
    ap.add_argument('--samples', type=int, default=40)
    ap.add_argument('--samples-night', type=int, default=56)
    ap.add_argument('--moods', default='day,night')
    ap.add_argument('--maps', default='a,b')
    args = ap.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])
    os.makedirs(args.out, exist_ok=True)

    with open(os.path.join(ROOT, 'data', 'office.json'), encoding='utf-8') as fh:
        office = json.load(fh)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    configure(scene, args.samples)
    B.build_materials()
    col = bpy.data.collections.new('twin')
    scene.collection.children.link(col)
    B.build_architecture(col, office)
    B.build_furniture(col)
    add_stage(col)
    irradiance_materials()
    rect = bounds()
    setup_camera(scene, rect, args.res)
    furniture = [o for o in col.objects if o.type == 'MESH' and not is_static(o)]
    print(f'scene: {len(col.objects)} objects, {len(furniture)} furniture; rect {[round(v, 2) for v in rect]}', flush=True)

    sizes = {}
    for mood in [m for m in args.moods.split(',') if m]:
        added = rig(mood, col, office, scene)
        res = args.res_night if mood == 'night' else args.res
        scene.cycles.samples = args.samples_night if mood == 'night' else args.samples
        w, h = rect[2] - rect[0], rect[3] - rect[1]
        scene.render.resolution_x, scene.render.resolution_y = (res, max(4, round(res * h / w / 4) * 4)) if w >= h else (max(4, round(res * w / h / 4) * 4), res)
        sizes[mood] = [scene.render.resolution_x, scene.render.resolution_y]
        for which in [m for m in args.maps.split(',') if m]:
            for o in furniture:
                o.visible_camera = which == 'b'
            render(scene, os.path.join(args.out, f'light_{mood}_{which}.png'))
        for o in added:
            bpy.data.objects.remove(o, do_unlink=True)

    info = {
        'rect': {'x0': round(rect[0], 4), 'y0': round(rect[1], 4), 'w': round(rect[2] - rect[0], 4), 'h': round(rect[3] - rect[1], 4)},
        'gain': round(2.0 ** (-EXPOSURE), 4),
        'static': list(STATIC),
        'size': sizes,
        'samples': {'day': args.samples, 'night': args.samples_night},
    }
    with open(os.path.join(args.out, 'light.json'), 'w', encoding='utf-8') as fh:
        json.dump(info, fh, indent=1)
    print('light.json', info)


if __name__ == '__main__':
    main()
