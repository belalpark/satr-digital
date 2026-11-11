"""Export the office twin as a web model (GLB) for the live three.js viewer.

    .blender/bin/python tools/twin/export_web.py --out media/twin/web

Writes:
    <out>/office.glb        geometry + PBR materials (procedural textures baked to tiles, embedded as WebP)
    <out>/scene.json        room metadata for the viewer, the ceiling lights as data, and the `light` block
                            of the baked light maps when tools/twin/finish_light.py has published them

Procedural node materials cannot be exported, so each textured material is
baked to a tileable 512 px albedo (+ normal from the bump) tile; plain
Principled materials export as constants; glass becomes a transmissive,
low-alpha material; emissive strips keep their colour and strength.
"""
import argparse
import hashlib
import tempfile
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import build_twin as B  # noqa: E402
import layout as L  # noqa: E402

# material name -> (kind, params) for the web version; everything else is read
# from the Principled node of the Blender material.
BAKE_TILE = 512
# world metres covered by one tile for each baked material (keeps the look of
# the Object-space mapping used by the Cycles materials)
TILE_METRES = {
    'wood': 2.5, 'wood_deck': 2.5, 'carpet_blue': 1.0, 'carpet_grey': 1.0, 'tile': 1.2,
    'stone': 2.0, 'stone_light': 1.2, 'slab': 2.0, 'oak': 1.0, 'walnut': 1.0, 'concrete': 2.0,
    'moss': 1.0, 'rug_beige': 1.0, 'rug_grey': 1.0, 'gravel': 1.0,
}


def bake_tile(mat, size, metres):
    """Bake the material's base colour onto a size x size image over a metres x metres plane."""
    img = bpy.data.images.new(f'bake_{mat.name}', size, size, alpha=False)
    bpy.ops.mesh.primitive_plane_add(size=metres)
    plane = bpy.context.object
    plane.data.materials.append(mat)
    # UV: the plane's default UV covers 0..1; Object-space mapping is used by the
    # material, so the baked tile repeats every `metres` metres in world space.
    nt = mat.node_tree
    node = nt.nodes.new('ShaderNodeTexImage')
    node.image = img
    nt.nodes.active = node
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 4
    scene.cycles.device = 'CPU'
    bpy.ops.object.select_all(action='DESELECT')
    plane.select_set(True)
    bpy.context.view_layer.objects.active = plane
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, use_clear=True, margin=4)
    nt.nodes.remove(node)
    bpy.data.objects.remove(plane, do_unlink=True)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'media', 'twin', 'web'))
    ap.add_argument('--no-bake', action='store_true', help='flat colours instead of baked texture tiles (fast check)')
    args = ap.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])
    os.makedirs(args.out, exist_ok=True)
    tile_dir = tempfile.mkdtemp(prefix='twin-tiles-')

    with open(os.path.join(ROOT, 'data', 'office.json'), encoding='utf-8') as fh:
        office = json.load(fh)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    B.build_materials()
    col = bpy.data.collections.new('twin')
    scene.collection.children.link(col)
    B.build_architecture(col, office)
    B.build_furniture(col)
    # lights are exported as data (the viewer builds its own, with a day/night switch)
    lights = []
    light_col = bpy.data.collections.new('lights')
    scene.collection.children.link(light_col)
    B.build_lights(light_col, office, 1.0)
    for obj in list(light_col.objects):
        if obj.type == 'LIGHT':
            d = obj.data
            lights.append({
                'type': d.type.lower(),
                'pos': [round(v, 3) for v in obj.location],
                'color': [round(c, 3) for c in d.color],
                'power': round(d.energy, 3),
            })
    # floor lamps were added inside build_furniture as POINT lights in `col`
    for obj in list(col.objects):
        if obj.type == 'LIGHT':
            d = obj.data
            lights.append({'type': 'point', 'pos': [round(v, 3) for v in obj.location],
                           'color': [round(c, 3) for c in d.color], 'power': round(d.energy, 3), 'lamp': True})
            bpy.data.objects.remove(obj, do_unlink=True)
    for obj in list(light_col.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

    # --- convert materials for glTF
    used = {m for o in col.objects if o.type == 'MESH' for m in o.data.materials if m}
    baked = {}
    for mat in used:
        nt = mat.node_tree
        nodes = nt.nodes
        bsdf = nodes.get('Principled BSDF')
        name = mat.name
        if name in ('glass', 'glass_ext'):
            nodes.clear()
            out = nodes.new('ShaderNodeOutputMaterial')
            p = nodes.new('ShaderNodeBsdfPrincipled')
            # a grey-green tint at low alpha: under the baked light a white pane would lay a milky veil over
            # the room behind it; the glass reads through its reflections and its dark frames instead
            p.inputs['Base Color'].default_value = (0.36, 0.5, 0.56, 1) if name == 'glass_ext' else (0.42, 0.55, 0.6, 1)
            p.inputs['Roughness'].default_value = 0.06
            p.inputs['Alpha'].default_value = 0.22 if name == 'glass_ext' else 0.18
            nt.links.new(p.outputs['BSDF'], out.inputs['Surface'])
            mat.blend_method = 'BLEND'
            mat['web_kind'] = 'glass'
            continue
        if bsdf is None:
            # emission-only materials: rebuild as principled with emission
            em = next((n for n in nodes if n.type == 'EMISSION'), None)
            color = tuple(em.inputs['Color'].default_value)[:3] if em else (1, 1, 1)
            strength = em.inputs['Strength'].default_value if em else 1.0
            nodes.clear()
            out = nodes.new('ShaderNodeOutputMaterial')
            p = nodes.new('ShaderNodeBsdfPrincipled')
            p.inputs['Base Color'].default_value = (*color, 1)
            p.inputs['Emission Color'].default_value = (*color, 1)
            p.inputs['Emission Strength'].default_value = min(strength, 8.0)
            nt.links.new(p.outputs['BSDF'], out.inputs['Surface'])
            mat['web_kind'] = 'emissive'
            continue
        linked = bsdf.inputs['Base Color'].links
        if linked and not args.no_bake:
            metres = TILE_METRES.get(name, 1.0)
            img = bake_tile(mat, BAKE_TILE, metres)
            path = os.path.join(tile_dir, f'tex_{name}.png')  # scratch: the exporter embeds the tiles in the GLB
            img.filepath_raw = path
            img.file_format = 'PNG'
            img.save()
            baked[name] = metres
            # replace the procedural tree with image texture (UV via generated coords is not
            # exportable, so the mesh gets box-projected UVs below)
            for l in list(linked):
                nt.links.remove(l)
            tex = nodes.new('ShaderNodeTexImage')
            tex.image = img
            nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
            if bsdf.inputs['Normal'].links:
                nt.links.remove(bsdf.inputs['Normal'].links[0])
        elif linked:
            # flat colour: take the ramp's mid colour
            ramp = next((n for n in nodes if n.type == 'VALTORGB'), None)
            if ramp:
                c0 = ramp.color_ramp.elements[0].color
                c1 = ramp.color_ramp.elements[1].color
                mid = [(c0[i] + c1[i]) / 2 for i in range(3)]
            else:
                mid = [0.5, 0.5, 0.5]
            for l in list(linked):
                nt.links.remove(l)
            bsdf.inputs['Base Color'].default_value = (*mid, 1)
            if bsdf.inputs['Normal'].links:
                nt.links.remove(bsdf.inputs['Normal'].links[0])

    # --- box-projected UVs so baked tiles repeat in world space
    for obj in col.objects:
        if obj.type != 'MESH':
            continue
        me = obj.data
        if not me.uv_layers:
            me.uv_layers.new(name='UVMap')
        uv = me.uv_layers[0].data
        mats = [m.name if m else '' for m in me.materials]
        mw = obj.matrix_world
        for poly in me.polygons:
            metres = baked.get(mats[poly.material_index] if mats else '', 1.0)
            n = (mw.to_3x3() @ poly.normal).normalized() if poly.normal.length else Vector((0, 0, 1))
            ax = max(range(3), key=lambda i: abs(n[i]))
            for li in poly.loop_indices:
                co = mw @ me.vertices[me.loops[li].vertex_index].co
                if ax == 2:
                    u, v = co.x, co.y
                elif ax == 1:
                    u, v = co.x, co.z
                else:
                    u, v = co.y, co.z
                uv[li].uv = (u / metres, v / metres)

    # --- room anchors / metadata for the viewer
    rooms = []
    for r in office['rooms']:
        poly = r.get('polygon')
        if not poly:
            continue  # list-only spaces (e.g. the corridors) have no floor in the model
        cx = sum(p[0] for p in poly) / len(poly)
        cy = sum(p[1] for p in poly) / len(poly)
        rooms.append({
            'id': r['id'],
            'floor': [[round(v, 3) for v in B.W(x, y)[:2]] for x, y in poly],
            'label': [round(v, 3) for v in B.W(r['label']['x'], r['label']['y'])[:2]],
            'centre': [round(v, 3) for v in B.W(cx, cy)[:2]],
        })

    glb = os.path.join(args.out, 'office.glb')
    bpy.ops.object.select_all(action='DESELECT')
    for obj in col.objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=glb, export_format='GLB', use_selection=True,
        export_apply=True, export_yup=True, export_materials='EXPORT', export_image_format='WEBP', export_image_quality=90,
        export_texcoords=True, export_normals=True, export_lights=False, export_cameras=False,
        export_extras=False, export_animations=False,
    )
    with open(glb, 'rb') as fh:
        stamp = hashlib.sha1(fh.read()).hexdigest()[:10]
    info = {
        # the model is cached for days by the host: its address changes whenever its bytes do
        'glb': f'office.glb?v={stamp}',
        'scale': L.SCALE,
        'wallHeight': L.WALL_H,
        'slab': L.SLAB,
        'origin': {'cx': B.CX, 'cy': B.CY},
        'bounds': {
            'min': [round(v, 3) for v in B.W(min(p[0] for p in L.OUTLINE), max(p[1] for p in L.OUTLINE))[:2]],
            'max': [round(v, 3) for v in B.W(max(p[0] for p in L.OUTLINE), min(p[1] for p in L.OUTLINE))[:2]],
        },
        'lights': lights,
        'rooms': rooms,
        'baked': baked,
    }
    scene_path = os.path.join(args.out, 'scene.json')
    if os.path.exists(scene_path):
        # the baked light maps are published separately (tools/twin/finish_light.py): keep their record
        with open(scene_path, encoding='utf-8') as fh:
            light = json.load(fh).get('light')
        if light:
            info['light'] = light
    with open(scene_path, 'w', encoding='utf-8') as fh:
        json.dump(info, fh, ensure_ascii=False, indent=1)
    print(f'exported {glb} ({os.path.getsize(glb) // 1024} KB), lights: {len(lights)}, baked: {sorted(baked)}')


if __name__ == '__main__':
    main()
