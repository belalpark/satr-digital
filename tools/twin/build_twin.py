"""Build the office digital twin in Blender and render the dollhouse shots.

    python tools/twin/build_twin.py --out .twin-render --res 2400x1600 --samples 64
    python tools/twin/build_twin.py --preview          # quick low-sample check render

Needs a Python with Blender's `bpy` module (`pip install bpy==5.0.1` on Python 3.11).
Reads data/office.json (room polygons, plan px) and tools/twin/layout.py (walls,
doors, furniture, lights), renders:

    <out>/plan.png                  full angled dollhouse (transparent background)
    <out>/focus-<room>.png          the same camera cropped around each focus room
    <out>/twin.json                 projections: plan px -> image px homographies,
                                    per-room focus rectangles

Everything is procedural: no third-party models or textures.
"""
import argparse
import json
import math
import os
import random
import sys
import time

import bpy  # noqa: I001  (must come before bmesh / mathutils / bpy_extras)
import bmesh
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import layout as L  # noqa: E402

S = L.SCALE
_xs = [p[0] for p in L.OUTLINE]
_ys = [p[1] for p in L.OUTLINE]
CX = (min(_xs) + max(_xs)) / 2
CY = (min(_ys) + max(_ys)) / 2


def W(x, y, z=0.0):
    """plan px -> world metres (x right, y up, z up)."""
    return Vector(((x - CX) / S, -(y - CY) / S, z))


def signed_area(pts):
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts))) / 2


def point_in_poly(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


# ------------------------------------------------------------------ materials
MATS = {}


def _new_mat(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    MATS[name] = mat
    return mat


def _bsdf(mat):
    return mat.node_tree.nodes['Principled BSDF']


def _set(node, name, value):
    if name in node.inputs:
        node.inputs[name].default_value = value


def principled(name, color, rough=0.5, metal=0.0, alpha=1.0, emit=None, emit_strength=0.0, coat=0.0, sheen=0.0):
    mat = _new_mat(name)
    b = _bsdf(mat)
    _set(b, 'Base Color', (*color, 1.0))
    _set(b, 'Roughness', rough)
    _set(b, 'Metallic', metal)
    _set(b, 'Alpha', alpha)
    if coat:
        _set(b, 'Coat Weight', coat)
    if sheen:
        _set(b, 'Sheen Weight', sheen)
    if emit:
        _set(b, 'Emission Color', (*emit, 1.0))
        _set(b, 'Emission Strength', emit_strength)
    return mat


def _mix_rgb(nt, blend, fac):
    n = nt.nodes.new('ShaderNodeMix')
    n.data_type = 'RGBA'
    n.blend_type = blend
    n.inputs['Factor'].default_value = fac
    a = next(s for s in n.inputs if s.name == 'A' and s.type == 'RGBA')
    b = next(s for s in n.inputs if s.name == 'B' and s.type == 'RGBA')
    out = next(s for s in n.outputs if s.type == 'RGBA')
    return n, a, b, out


def textured(name, c1, c2, rough, kind, scale=1.0, bump=0.15):
    """Procedural surfaces: planks (wood floor), carpet, tiles, grain (furniture wood), stone."""
    mat = _new_mat(name)
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    b = _bsdf(mat)
    _set(b, 'Roughness', rough)
    tc = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    links.new(tc.outputs['Object'], mapping.inputs['Vector'])
    mapping.inputs['Scale'].default_value = (scale, scale, scale)
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 6.0
    noise.inputs['Detail'].default_value = 8.0
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (*c1, 1)
    ramp.color_ramp.elements[1].color = (*c2, 1)
    color_out = ramp.outputs['Color']
    if kind == 'planks':
        brick = nodes.new('ShaderNodeTexBrick')
        brick.offset = 0.37
        brick.inputs['Scale'].default_value = 1.0
        brick.inputs['Brick Width'].default_value = 1.25
        brick.inputs['Row Height'].default_value = 0.2
        brick.inputs['Mortar Size'].default_value = 0.004
        brick.inputs['Bias'].default_value = 0.0
        brick.inputs['Color1'].default_value = (1, 1, 1, 1)
        brick.inputs['Color2'].default_value = (0.86, 0.86, 0.86, 1)
        brick.inputs['Mortar'].default_value = (0.55, 0.55, 0.55, 1)
        links.new(mapping.outputs['Vector'], brick.inputs['Vector'])
        grain_map = nodes.new('ShaderNodeMapping')
        grain_map.inputs['Scale'].default_value = (0.6, 14.0, 1.0)
        links.new(tc.outputs['Object'], grain_map.inputs['Vector'])
        links.new(grain_map.outputs['Vector'], noise.inputs['Vector'])
        links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
        mix, a, bb, out = _mix_rgb(nt, 'MULTIPLY', 1.0)
        links.new(ramp.outputs['Color'], a)
        links.new(brick.outputs['Color'], bb)
        color_out = out
        bump_src = brick.outputs['Fac']
    elif kind == 'tiles':
        brick = nodes.new('ShaderNodeTexBrick')
        brick.offset = 0.0
        brick.inputs['Brick Width'].default_value = 0.6
        brick.inputs['Row Height'].default_value = 0.6
        brick.inputs['Mortar Size'].default_value = 0.003
        brick.inputs['Color1'].default_value = (*c1, 1)
        brick.inputs['Color2'].default_value = (*c2, 1)
        brick.inputs['Mortar'].default_value = (c1[0] * 0.75, c1[1] * 0.75, c1[2] * 0.75, 1)
        links.new(mapping.outputs['Vector'], brick.inputs['Vector'])
        color_out = brick.outputs['Color']
        bump_src = brick.outputs['Fac']
    elif kind == 'grain':
        grain_map = nodes.new('ShaderNodeMapping')
        grain_map.inputs['Scale'].default_value = (1.5, 18.0, 1.5)
        links.new(tc.outputs['Object'], grain_map.inputs['Vector'])
        wave = nodes.new('ShaderNodeTexWave')
        wave.inputs['Scale'].default_value = 3.0
        wave.inputs['Distortion'].default_value = 6.0
        wave.inputs['Detail'].default_value = 3.0
        links.new(grain_map.outputs['Vector'], wave.inputs['Vector'])
        links.new(wave.outputs['Fac'], ramp.inputs['Fac'])
        bump_src = wave.outputs['Fac']
    else:  # carpet / stone / moss: fine noise
        noise.inputs['Scale'].default_value = 40.0 if kind == 'carpet' else 9.0
        links.new(mapping.outputs['Vector'], noise.inputs['Vector'])
        links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
        bump_src = noise.outputs['Fac']
    links.new(color_out, b.inputs['Base Color'])
    if bump:
        bn = nodes.new('ShaderNodeBump')
        bn.inputs['Strength'].default_value = bump
        bn.inputs['Distance'].default_value = 0.01
        links.new(bump_src, bn.inputs['Height'])
        links.new(bn.outputs['Normal'], b.inputs['Normal'])
    return mat


def glass(name, tint, reflect=0.35):
    mat = _new_mat(name)
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    nodes.clear()
    out = nodes.new('ShaderNodeOutputMaterial')
    transp = nodes.new('ShaderNodeBsdfTransparent')
    transp.inputs['Color'].default_value = (*tint, 1)
    refl = nodes.new('ShaderNodeBsdfPrincipled')
    refl.inputs['Base Color'].default_value = (0.02, 0.025, 0.03, 1)
    refl.inputs['Roughness'].default_value = 0.04
    lw = nodes.new('ShaderNodeLayerWeight')
    lw.inputs['Blend'].default_value = reflect
    mix = nodes.new('ShaderNodeMixShader')
    links.new(lw.outputs['Fresnel'], mix.inputs['Fac'])
    links.new(transp.outputs['BSDF'], mix.inputs[1])
    links.new(refl.outputs['BSDF'], mix.inputs[2])
    links.new(mix.outputs['Shader'], out.inputs['Surface'])
    return mat


def emission(name, color, strength):
    mat = _new_mat(name)
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    nodes.clear()
    out = nodes.new('ShaderNodeOutputMaterial')
    em = nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*color, 1)
    em.inputs['Strength'].default_value = strength
    links.new(em.outputs['Emission'], out.inputs['Surface'])
    return mat


def build_materials():
    textured('wood', (0.43, 0.27, 0.15), (0.6, 0.41, 0.24), 0.28, 'planks', bump=0.08)
    textured('wood_deck', (0.5, 0.33, 0.18), (0.66, 0.47, 0.28), 0.4, 'planks', bump=0.08)
    textured('carpet_blue', (0.13, 0.16, 0.22), (0.21, 0.25, 0.32), 0.95, 'carpet', bump=0.25)
    textured('carpet_grey', (0.26, 0.26, 0.27), (0.36, 0.36, 0.37), 0.95, 'carpet', bump=0.25)
    textured('tile', (0.42, 0.42, 0.42), (0.38, 0.38, 0.38), 0.25, 'tiles', bump=0.05)
    textured('stone', (0.5, 0.49, 0.47), (0.6, 0.59, 0.57), 0.55, 'stone', bump=0.05)
    textured('stone_light', (0.74, 0.71, 0.66), (0.84, 0.81, 0.76), 0.3, 'tiles', bump=0.04)
    textured('slab', (0.62, 0.6, 0.57), (0.7, 0.68, 0.64), 0.6, 'stone', bump=0.0)
    textured('oak', (0.5, 0.33, 0.18), (0.68, 0.48, 0.28), 0.42, 'grain', bump=0.04)
    textured('walnut', (0.16, 0.09, 0.05), (0.3, 0.18, 0.1), 0.35, 'grain', bump=0.04)
    textured('concrete', (0.36, 0.38, 0.41), (0.47, 0.49, 0.52), 0.75, 'stone', bump=0.08)
    textured('moss', (0.05, 0.16, 0.04), (0.16, 0.34, 0.08), 0.9, 'stone', bump=0.6)
    textured('rug_beige', (0.62, 0.56, 0.47), (0.7, 0.64, 0.55), 0.95, 'carpet', bump=0.3)
    textured('rug_grey', (0.36, 0.37, 0.4), (0.44, 0.45, 0.48), 0.95, 'carpet', bump=0.3)
    textured('gravel', (0.56, 0.55, 0.52), (0.7, 0.69, 0.66), 0.9, 'carpet', bump=0.4)
    principled('plaster', (0.8, 0.79, 0.76), 0.85)
    principled('partition', (0.46, 0.47, 0.49), 0.5)
    principled('cap', (0.86, 0.84, 0.8), 0.5)
    principled('core_top', (0.6, 0.58, 0.55), 0.6)
    principled('alu', (0.035, 0.035, 0.04), 0.35, metal=0.7)
    principled('steel', (0.62, 0.63, 0.65), 0.28, metal=1.0)
    principled('desk_white', (0.82, 0.82, 0.8), 0.32, coat=0.2)
    principled('metal_dark', (0.06, 0.06, 0.065), 0.38, metal=0.6)
    principled('fabric_blue', (0.07, 0.13, 0.3), 0.9, sheen=0.4)
    principled('mesh_dark', (0.07, 0.07, 0.08), 0.75)
    principled('shell_white', (0.9, 0.9, 0.9), 0.3, coat=0.3)
    principled('leather_black', (0.03, 0.03, 0.035), 0.42, coat=0.2)
    principled('sofa_slate', (0.10, 0.13, 0.18), 0.92, sheen=0.5)   # photos 0146-0152: dark slate blue
    principled('sofa_cream', (0.7, 0.66, 0.6), 0.9, sheen=0.4)
    principled('sofa_blue', (0.18, 0.28, 0.45), 0.9, sheen=0.4)
    principled('cushion', (0.36, 0.38, 0.42), 0.92, sheen=0.4)
    principled('divider', (0.62, 0.64, 0.6), 0.9, sheen=0.3)
    principled('screen', (0.012, 0.014, 0.018), 0.08, emit=(0.32, 0.45, 0.62), emit_strength=0.35)
    principled('tv', (0.005, 0.005, 0.007), 0.06)
    principled('porcelain', (0.93, 0.93, 0.92), 0.12, coat=0.5)
    principled('mirror', (0.85, 0.87, 0.9), 0.02, metal=1.0)
    principled('leaf', (0.05, 0.2, 0.05), 0.55, sheen=0.3)
    principled('leaf_light', (0.12, 0.3, 0.07), 0.55, sheen=0.3)
    principled('pot', (0.13, 0.13, 0.14), 0.45, coat=0.3)
    principled('pot_light', (0.8, 0.78, 0.74), 0.5)
    principled('soil', (0.08, 0.06, 0.04), 0.95)
    principled('cardboard', (0.55, 0.42, 0.27), 0.85)
    principled('whiteboard', (0.95, 0.95, 0.95), 0.08)
    principled('frost', (0.92, 0.94, 0.96), 0.4, alpha=0.55)
    principled('rack_led', (0.1, 0.4, 0.9), 0.3, emit=(0.2, 0.6, 1.0), emit_strength=6.0)
    glass('glass', (0.9, 0.95, 0.96), reflect=0.3)
    glass('glass_ext', (0.72, 0.84, 0.9), reflect=0.45)
    emission('led', (1.0, 0.68, 0.36), 9.0)
    emission('led_soft', (1.0, 0.76, 0.5), 3.5)
    emission('lamp_shade', (1.0, 0.8, 0.55), 4.0)


# -------------------------------------------------------------- mesh builder
class Builder:
    """Accumulates boxes/prisms/cylinders into one multi-material mesh."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def _mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def _finish_shape(self, verts, mat, bevel=0.0, smooth=False):
        mi = self._mi(mat)
        faces = {f for v in verts for f in v.link_faces}
        for f in faces:
            f.material_index = mi
            f.smooth = smooth
        if bevel > 0:
            edges = list({e for v in verts for e in v.link_edges})
            res = bmesh.ops.bevel(self.bm, geom=list(verts) + edges, offset=bevel, segments=2, profile=0.5,
                                  affect='EDGES', clamp_overlap=True)
            for f in res.get('faces', []):
                f.material_index = mi

    def box(self, mat, center, size, rot=0.0, bevel=0.0, tilt=0.0):
        sx, sy, sz = size
        if sx <= 0 or sy <= 0 or sz <= 0:
            return
        mtx = (Matrix.Translation(Vector(center)) @ Matrix.Rotation(rot, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'X')
               @ Matrix.Diagonal((sx, sy, sz, 1.0)))
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=mtx)
        self._finish_shape(r['verts'], mat, bevel=min(bevel, sx / 2.2, sy / 2.2, sz / 2.2) if bevel else 0)

    def seg_box(self, mat, a, b, thick, z0, z1, bevel=0.0):
        """Box along the world segment a->b (Vectors, z ignored)."""
        d = Vector((b.x - a.x, b.y - a.y, 0))
        length = d.length
        if length < 1e-4:
            return
        c = (a + b) / 2
        self.box(mat, (c.x, c.y, (z0 + z1) / 2), (length, thick, z1 - z0), rot=math.atan2(d.y, d.x), bevel=bevel)

    def cyl(self, mat, center, r, h, segs=24, r2=None, smooth=True, sxy=(1.0, 1.0)):
        mtx = (Matrix.Translation(Vector((center[0], center[1], center[2] + h / 2)))
               @ Matrix.Diagonal((sxy[0], sxy[1], 1.0, 1.0)))
        res = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r,
                                    radius2=r if r2 is None else r2, depth=h, matrix=mtx)
        mi = self._mi(mat)
        for f in {f for v in res['verts'] for f in v.link_faces}:
            f.material_index = mi
            f.smooth = smooth and abs(f.normal.z) < 0.9
        return res

    def sphere(self, mat, center, radii, rot=None, segs=(10, 6)):
        mtx = Matrix.Translation(Vector(center))
        if rot is not None:
            mtx = mtx @ rot
        mtx = mtx @ Matrix.Diagonal((radii[0], radii[1], radii[2], 1.0))
        res = bmesh.ops.create_uvsphere(self.bm, u_segments=segs[0], v_segments=segs[1], radius=1.0, matrix=mtx)
        mi = self._mi(mat)
        for f in {f for v in res['verts'] for f in v.link_faces}:
            f.material_index = mi
            f.smooth = True

    def prism(self, mat, pts, z0, z1, side_mat=None):
        """pts: world (x, y) list. Top gets mat, sides/bottom side_mat (default mat)."""
        if signed_area(pts) < 0:
            pts = list(reversed(pts))
        bm = self.bm
        v0 = [bm.verts.new((x, y, z0)) for x, y in pts]
        v1 = [bm.verts.new((x, y, z1)) for x, y in pts]
        top = bm.faces.new(v1)
        bot = bm.faces.new(list(reversed(v0)))
        top.material_index = self._mi(mat)
        smi = self._mi(side_mat or mat)
        bot.material_index = smi
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            f = bm.faces.new((v0[i], v0[j], v1[j], v1[i]))
            f.material_index = smi

    def to_object(self, collection, name=None, location=(0, 0, 0), rot=0.0):
        mesh = bpy.data.meshes.new(name or self.name)
        self.bm.normal_update()
        self.bm.to_mesh(mesh)
        self.bm.free()
        for mt in self.mats:
            mesh.materials.append(MATS[mt])
        obj = bpy.data.objects.new(name or self.name, mesh)
        obj.location = location
        obj.rotation_euler = (0, 0, rot)
        collection.objects.link(obj)
        return obj

    def to_mesh(self, name=None):
        mesh = bpy.data.meshes.new(name or self.name)
        self.bm.normal_update()
        self.bm.to_mesh(mesh)
        self.bm.free()
        for mt in self.mats:
            mesh.materials.append(MATS[mt])
        return mesh


# ------------------------------------------------------------------ assets
ASSETS = {}


def asset(name, fn):
    if name not in ASSETS:
        b = Builder(name)
        fn(b)
        ASSETS[name] = b.to_mesh(name)
    return ASSETS[name]


def place(collection, mesh, x, y, rot_deg=0.0, z=0.0, scale=1.0, name=None):
    obj = bpy.data.objects.new(name or mesh.name, mesh)
    p = W(x, y, z)
    obj.location = p
    obj.rotation_euler = (0, 0, math.radians(rot_deg))
    obj.scale = (scale, scale, scale)
    collection.objects.link(obj)
    return obj


def chair_star_base(b, mat='metal_dark'):
    b.cyl(mat, (0, 0, 0.07), 0.045, 0.06)
    for i in range(5):
        a = i * 2 * math.pi / 5
        c = (math.cos(a) * 0.16, math.sin(a) * 0.16, 0.085)
        b.box(mat, c, (0.32, 0.04, 0.03), rot=a, bevel=0.008)
        b.cyl('metal_dark', (math.cos(a) * 0.31, math.sin(a) * 0.31, 0.0), 0.028, 0.05, segs=10)
    b.cyl('steel', (0, 0, 0.1), 0.022, 0.32, segs=12)


def make_chair_task(b):
    """Meeting / workstation chair: white shell back with dark mesh, blue seat."""
    chair_star_base(b)
    b.box('fabric_blue', (0, 0.0, 0.46), (0.5, 0.48, 0.08), bevel=0.025)
    b.box('metal_dark', (0, 0.02, 0.41), (0.36, 0.34, 0.03))
    b.box('shell_white', (0, 0.27, 0.8), (0.5, 0.05, 0.62), bevel=0.02, tilt=math.radians(-10))
    b.box('mesh_dark', (0, 0.245, 0.81), (0.4, 0.03, 0.5), bevel=0.01, tilt=math.radians(-10))
    for sx in (-0.27, 0.27):
        b.box('shell_white', (sx, 0.05, 0.66), (0.05, 0.3, 0.035), bevel=0.012)
        b.box('metal_dark', (sx, 0.12, 0.56), (0.035, 0.035, 0.2))


def make_chair_exec(b):
    chair_star_base(b)
    b.box('leather_black', (0, 0.0, 0.47), (0.54, 0.52, 0.1), bevel=0.03)
    b.box('leather_black', (0, 0.29, 0.86), (0.52, 0.07, 0.72), bevel=0.03, tilt=math.radians(-9))
    b.box('mesh_dark', (0, 0.255, 0.86), (0.44, 0.03, 0.6), bevel=0.01, tilt=math.radians(-9))
    b.box('leather_black', (0, 0.36, 1.28), (0.32, 0.07, 0.16), bevel=0.03, tilt=math.radians(-12))
    for sx in (-0.29, 0.29):
        b.box('leather_black', (sx, 0.05, 0.68), (0.06, 0.32, 0.04), bevel=0.015)
        b.box('metal_dark', (sx, 0.12, 0.58), (0.04, 0.04, 0.2))


def make_chair_guest(b):
    for sx in (-0.22, 0.22):
        for sy in (-0.2, 0.22):
            b.box('metal_dark', (sx, sy, 0.22), (0.025, 0.025, 0.44))
    b.box('fabric_blue', (0, 0, 0.47), (0.5, 0.48, 0.07), bevel=0.02)
    b.box('mesh_dark', (0, 0.25, 0.78), (0.48, 0.05, 0.56), bevel=0.02, tilt=math.radians(-8))


def make_desk_exec(b, length):
    d = 0.8
    top = 0.75
    b.box('desk_white', (0, 0, top - 0.015), (length, d, 0.03), bevel=0.006)
    for sx in (-length / 2 + 0.03, length / 2 - 0.03):
        b.box('metal_dark', (sx, 0, (top - 0.03) / 2), (0.05, d - 0.06, top - 0.03))
    b.box('desk_white', (0, -d / 2 + 0.03, 0.45), (length - 0.1, 0.02, 0.45))
    # return on the right-hand side
    b.box('desk_white', (length / 2 - 0.25, d / 2 + 0.4, top - 0.015), (0.5, 0.8, 0.03), bevel=0.006)
    b.box('desk_white', (length / 2 - 0.25, d / 2 + 0.4, 0.33), (0.46, 0.76, 0.62), bevel=0.006)
    # monitor, keyboard, phone
    b.box('metal_dark', (0.1, -0.22, top + 0.08), (0.08, 0.06, 0.16))
    b.box('screen', (0.1, -0.24, top + 0.32), (0.62, 0.025, 0.36), bevel=0.004)
    b.box('metal_dark', (0.1, 0.05, top + 0.01), (0.44, 0.15, 0.015))
    b.box('metal_dark', (-length / 2 + 0.3, -0.15, top + 0.03), (0.2, 0.18, 0.06), bevel=0.01)


def make_bench(b, n, divider=True):
    """n desks per row along local X, two facing rows (local y = +-0.35), divider at y=0."""
    w, d, top = 1.3, 0.7, 0.75
    total = n * w
    for row in (-1, 1):
        cy = row * d / 2
        for i in range(n):
            cx = -total / 2 + w / 2 + i * w
            b.box('desk_white', (cx, cy, top - 0.015), (w - 0.01, d - 0.01, 0.03), bevel=0.005)
            # monitor faces the user (user sits on the far side from the divider)
            my = row * 0.13
            b.box('metal_dark', (cx, my, top + 0.07), (0.07, 0.05, 0.14))
            b.box('screen', (cx, my + row * 0.03, top + 0.3), (0.56, 0.022, 0.33), bevel=0.004)
            b.box('metal_dark', (cx, cy + row * 0.2, top + 0.008), (0.42, 0.14, 0.014))
            b.box('desk_white', (cx + w / 2 - 0.28, cy + row * 0.1, 0.29), (0.4, 0.5, 0.56), bevel=0.006)
    for i in range(n + 1):
        x = -total / 2 + i * w
        x = min(max(x, -total / 2 + 0.025), total / 2 - 0.025)
        b.box('metal_dark', (x, 0, (top - 0.03) / 2), (0.04, 2 * d - 0.08, top - 0.03))
    if divider:
        b.box('divider', (0, 0, top + 0.17), (total - 0.04, 0.035, 0.34), bevel=0.01)


def make_sofa(b, length, fabric):
    depth, seat_h = 0.9, 0.42
    b.box(fabric, (0, 0.05, 0.2), (length, depth - 0.1, 0.32), bevel=0.03)
    n = max(1, round((length - 0.36) / 0.75))
    cw = (length - 0.36) / n
    for i in range(n):
        x = -length / 2 + 0.18 + cw / 2 + i * cw
        b.box(fabric, (x, -0.05, seat_h), (cw - 0.02, depth - 0.3, 0.14), bevel=0.04)
        b.box(fabric, (x, 0.33, 0.66), (cw - 0.03, 0.2, 0.42), bevel=0.06, tilt=math.radians(-8))
    for sx in (-length / 2 + 0.09, length / 2 - 0.09):
        b.box(fabric, (sx, 0.0, 0.32), (0.18, depth, 0.62), bevel=0.05)
    for sx in (-length / 2 + 0.1, length / 2 - 0.1):
        for sy in (-0.38, 0.4):
            b.box('metal_dark', (sx, sy, 0.02), (0.04, 0.04, 0.04))


def make_armchair(b, fabric):
    make_sofa(b, 0.92, fabric)


def make_coffee_table(b, length, w):
    b.box('walnut', (0, 0, 0.38), (length, w, 0.04), bevel=0.012)
    b.box('metal_dark', (0, 0, 0.18), (length * 0.6, w * 0.5, 0.34))


def make_table_round(b, r):
    b.cyl('desk_white', (0, 0, 0.72), r, 0.03, segs=40)
    b.cyl('metal_dark', (0, 0, 0.02), 0.05, 0.7, segs=16)
    b.cyl('metal_dark', (0, 0, 0.0), 0.26, 0.025, segs=32)


def make_table_meeting(b, length, w, top_mat, modules):
    mod = length / modules
    for i in range(modules):
        x = -length / 2 + mod / 2 + i * mod
        b.box(top_mat, (x, 0, 0.737), (mod - 0.006, w, 0.035), bevel=0.006)
    for i in range(modules + 1):
        x = -length / 2 + i * mod
        x = min(max(x, -length / 2 + 0.05), length / 2 - 0.05)
        b.box('metal_dark', (x, 0, 0.36), (0.05, w - 0.12, 0.72))
        b.box('metal_dark', (x, 0, 0.01), (0.07, w - 0.06, 0.02))
    for i in range(modules):
        x = -length / 2 + mod / 2 + i * mod
        b.box('metal_dark', (x, 0, 0.758), (0.24, 0.12, 0.012), bevel=0.003)


def make_table_oval(b, length, w):
    b.cyl('walnut', (0, 0, 0.72), 0.5, 0.035, segs=48, sxy=(length, w))
    for sx in (-length * 0.28, length * 0.28):
        b.cyl('metal_dark', (sx, 0, 0.0), 0.07, 0.72, segs=16)
        b.cyl('metal_dark', (sx, 0, 0.0), 0.22, 0.02, segs=24)


def make_credenza(b, length):
    b.box('desk_white', (0, 0, 0.36), (length, 0.45, 0.68), bevel=0.008)
    b.box('oak', (0, 0, 0.71), (length + 0.02, 0.47, 0.03), bevel=0.006)
    b.box('metal_dark', (0, 0, 0.02), (length - 0.1, 0.38, 0.04))


def make_cabinet(b, length):
    b.box('desk_white', (0, 0, 0.6), (length, 0.45, 1.2), bevel=0.008)
    for i in range(int(length / 0.4)):
        x = -length / 2 + 0.2 + i * 0.4
        b.box('metal_dark', (x, -0.23, 0.95), (0.012, 0.01, 0.12))


def plant_builder(seed, kind):
    def fn(b):
        rnd = random.Random(seed)
        if kind == 'floor':
            b.cyl('pot', (0, 0, 0), 0.17, 0.42, segs=24, r2=0.21)
            b.cyl('soil', (0, 0, 0.4), 0.19, 0.02, segs=24)
            stem_top = 0.55
            count, spread, hmin, hmax = 34, 0.42, 0.55, 1.45
        else:  # tabletop / small
            b.cyl('pot_light', (0, 0, 0), 0.08, 0.16, segs=16, r2=0.09)
            stem_top = 0.2
            count, spread, hmin, hmax = 16, 0.16, 0.2, 0.42
        b.cyl('soil', (0, 0, stem_top - 0.15), 0.012, max(hmax - stem_top, 0.2), segs=6)
        golden = math.pi * (3 - math.sqrt(5))
        for i in range(count):
            a = i * golden + rnd.uniform(-0.2, 0.2)
            t = i / max(1, count - 1)
            z = hmin + (hmax - hmin) * (0.15 + 0.85 * rnd.random() ** 0.8)
            reach = spread * (0.35 + 0.65 * (1 - t * 0.5)) * rnd.uniform(0.7, 1.05)
            length = (0.17 if kind == 'floor' else 0.075) * rnd.uniform(0.8, 1.25)
            cx, cy = math.cos(a) * reach * 0.55, math.sin(a) * reach * 0.55
            rot = Matrix.Rotation(a - math.pi / 2, 4, 'Z') @ Matrix.Rotation(math.radians(rnd.uniform(25, 65)), 4, 'X')
            b.sphere('leaf' if rnd.random() < 0.7 else 'leaf_light', (cx, cy, z), (length * 0.32, length, length * 0.06),
                     rot=rot, segs=(8, 5))
    return fn


def make_floor_lamp(b):
    b.cyl('metal_dark', (0, 0, 0), 0.16, 0.025, segs=24)
    b.cyl('metal_dark', (0, 0, 0.02), 0.012, 1.42, segs=8)
    b.cyl('lamp_shade', (0, 0, 1.38), 0.19, 0.3, segs=24, r2=0.16)


def make_pouf(b):
    b.cyl('cushion', (0, 0, 0), 0.22, 0.42, segs=24)


def make_side_table(b):
    b.cyl('oak', (0, 0, 0), 0.2, 0.5, segs=24)


def make_whiteboard(b):
    for sx in (-0.62, 0.62):
        b.box('metal_dark', (sx, 0, 0.9), (0.035, 0.035, 1.8))
        b.box('metal_dark', (sx, 0, 0.03), (0.05, 0.6, 0.04))
    b.box('alu', (0, 0, 1.35), (1.24, 0.04, 0.94), bevel=0.01)
    b.box('whiteboard', (0, -0.022, 1.35), (1.18, 0.01, 0.88))


def make_shelving(b, length):
    for sx in (-length / 2, length / 2):
        b.box('metal_dark', (sx, 0, 0.9), (0.03, 0.45, 1.8))
    for z in (0.08, 0.5, 0.92, 1.34, 1.76):
        b.box('steel', (0, 0, z), (length, 0.45, 0.025))
    rnd = random.Random(int(length * 100))
    for z in (0.1, 0.52, 0.94, 1.36):
        x = -length / 2 + 0.1
        while x < length / 2 - 0.3:
            w = rnd.uniform(0.25, 0.45)
            h = rnd.uniform(0.18, 0.34)
            b.box('cardboard', (x + w / 2, 0, z + h / 2 + 0.012), (w - 0.02, 0.36, h), bevel=0.005)
            x += w + 0.04


def make_rack(b):
    b.box('metal_dark', (0, 0, 1.0), (0.62, 1.0, 2.0), bevel=0.01)
    for i in range(10):
        b.box('rack_led', (-0.2 + (i % 5) * 0.1, -0.505, 1.2 + (i // 5) * 0.25), (0.02, 0.01, 0.02))


# ------------------------------------------------------------------ scene
def build_architecture(col, office):
    arch = Builder('architecture')
    outline_w = [tuple(W(x, y)[:2]) for x, y in L.OUTLINE]
    # model base (slab): corridor floor on top, stone sides
    arch.prism('wood', outline_w, -L.SLAB, 0.0, side_mat='slab')

    rooms = {r['id']: r for r in office['rooms']}
    floors = []
    for r in office['rooms']:
        mat = L.FLOOR_BY_ROOM.get(r['id'], 'missing')
        if mat == 'missing':
            mat = L.FLOOR_BY_KIND.get(r['kind'])
        if mat:
            floors.append((mat, r['polygon']))
    for key, (mat, pts) in L.EXTRA_FLOORS.items():
        floors.append((mat, pts))
    for mat, pts in floors:
        arch.prism(mat, [tuple(W(x, y)[:2]) for x, y in pts], 0.0, 0.006)

    # exterior curtain wall
    n = len(L.OUTLINE)
    for i in range(n):
        a = W(*L.OUTLINE[i])
        b_ = W(*L.OUTLINE[(i + 1) % n])
        curtain(arch, a, b_)
    # fins / planters outside the facades
    for x0, y0, x1, y1 in L.FINS:
        attach_left = x1 <= L.OUTLINE[0][0] + 1  # west fins attach at their east side
        p = [W(x0, y0), W(x1, y0), W(x1, y1), W(x0, y1)]
        arch.prism('moss', [tuple(v[:2]) for v in p], -L.SLAB, 0.3, side_mat='slab')
        edges = [(p[0], p[1]), (p[3], p[2])] + ([(p[0], p[3])] if attach_left else [(p[1], p[2])])
        for a, b_ in edges:
            arch.seg_box('slab', a, b_, 0.16, -L.SLAB, 0.55, bevel=0.01)
            arch.seg_box('cap', a, b_, 0.165, 0.55, 0.57)
    # interior walls
    for kind, p1, p2, doors in L.WALLS:
        a, b_ = Vector(p1), Vector(p2)
        length = (b_ - a).length
        d = (b_ - a) / length
        spans, cur = [], 0.0
        for s, e in sorted(doors):
            if s > cur:
                spans.append((cur, s))
            cur = e
        if cur < length:
            spans.append((cur, length))
        for s, e in spans:
            pa, pb = a + d * s, a + d * e
            wa, wb = W(pa.x, pa.y), W(pb.x, pb.y)
            if kind == 'glass':
                partition(arch, wa, wb)
            elif kind == 'core':
                solid(arch, wa, wb, 0.24, 'concrete')
            else:
                solid(arch, wa, wb, 0.12, 'plaster')
    return arch.to_object(col)


def solid(b, a, c, thick, mat):
    b.seg_box(mat, a, c, thick, 0.0, L.WALL_H - 0.012)
    b.seg_box('cap', a, c, thick + 0.002, L.WALL_H - 0.012, L.WALL_H)
    b.seg_box('metal_dark', a, c, thick + 0.016, 0.0, 0.07)


def partition(b, a, c):
    h = L.WALL_H
    b.seg_box('alu', a, c, 0.06, 0.0, 0.06)
    b.seg_box('alu', a, c, 0.06, h - 0.05, h)
    b.seg_box('glass', a, c, 0.012, 0.06, h - 0.05)
    b.seg_box('frost', a, c, 0.016, 0.92, 1.02)
    d = Vector((c.x - a.x, c.y - a.y, 0))
    length = d.length
    if length < 1e-4:
        return
    u = d / length
    count = max(1, round(length / 1.2))
    for i in range(count + 1):
        p = a + u * (min(max(i * length / count, 0.025), length - 0.025))
        b.box('alu', (p.x, p.y, h / 2), (0.05, 0.06, h), rot=math.atan2(u.y, u.x))


def curtain(b, a, c):
    h = L.WALL_H + 0.1
    b.seg_box('alu', a, c, 0.16, 0.0, 0.12)
    b.seg_box('alu', a, c, 0.14, h - 0.06, h)
    b.seg_box('glass_ext', a, c, 0.014, 0.12, h - 0.06)
    d = Vector((c.x - a.x, c.y - a.y, 0))
    length = d.length
    u = d / length
    count = max(1, round(length / 1.5))
    for i in range(count + 1):
        p = a + u * (i * length / count)
        b.box('alu', (p.x, p.y, h / 2), (0.07, 0.16, h), rot=math.atan2(u.y, u.x))


def build_reception(col):
    b = Builder('reception')
    pts = [(792, 758), (814, 836), (905, 844), (934, 806), (926, 764)]
    centre = W(862, 795)
    for i in range(len(pts) - 1):
        a, c = W(*pts[i]), W(*pts[i + 1])
        d = (c - a).normalized()
        nrm = Vector((d.y, -d.x, 0))
        mid = (a + c) / 2
        if (mid + nrm - centre).length < (mid - nrm - centre).length:
            nrm = -nrm
        # segments stop at the joints: overlapping coplanar tops render black in a path
        # tracer (shadow rays hit the coincident face); round posts fill the joints
        a2, c2 = a, c
        b.seg_box('concrete', a2 + nrm * 0.02, c2 + nrm * 0.02, 0.6, 0.1, 1.02, bevel=0.01)
        b.seg_box('metal_dark', a2 - nrm * 0.02, c2 - nrm * 0.02, 0.5, 0.0, 0.1)
        b.seg_box('led', a2 + nrm * 0.29, c2 + nrm * 0.29, 0.02, 0.085, 0.105)
        b.seg_box('oak', a2 + nrm * 0.05, c2 + nrm * 0.05, 0.72, 1.02, 1.1, bevel=0.008)
        b.seg_box('desk_white', a2 - nrm * 0.42, c2 - nrm * 0.42, 0.5, 0.72, 0.75)
    # round posts at the joints fill the outer mitre the straight segments leave open
    for x, y in pts[1:-1]:
        p = W(x, y)
        b.cyl('metal_dark', (p.x, p.y, 0.0), 0.25, 0.1, segs=32)
        b.cyl('led', (p.x, p.y, 0.085), 0.31, 0.02, segs=32)
        b.cyl('concrete', (p.x, p.y, 0.1), 0.32, 0.92, segs=32)
        b.cyl('oak', (p.x, p.y, 1.02), 0.38, 0.086, segs=32)  # 6 mm proud of the segment tops
        b.cyl('desk_white', (p.x, p.y, 0.72), 0.3, 0.036, segs=32)
    b.to_object(col)
    # receptionist chair and screen
    place(col, asset('chair_exec', make_chair_exec), 852, 806, 0)
    place(col, asset('chair_exec', make_chair_exec), 902, 800, 35)


def build_feature_shelves(col, x1, x2, y):
    b = Builder('feature_shelves')
    a, c = W(x1, y), W(x2, y)
    length = (c - a).length
    mid = (a + c) / 2
    b.box('walnut', (mid.x, mid.y, 1.2), (length, 0.36, 2.4), bevel=0.01)
    bays = max(2, round(length / 0.9))
    for i in range(bays):
        x = a.x + (i + 0.5) * length / bays
        for z in (0.55, 1.05, 1.55, 2.0):
            b.box('cap', (x, mid.y - 0.05, z), (length / bays - 0.08, 0.3, 0.36))
            b.box('led_soft', (x, mid.y - 0.12, z + 0.17), (length / bays - 0.1, 0.12, 0.012))
            if (i + int(z * 10)) % 3 == 0:
                b.cyl('pot_light', (x - 0.1, mid.y - 0.1, z - 0.18), 0.06, 0.2, segs=14)
            elif (i + int(z * 10)) % 3 == 1:
                b.box('oak', (x + 0.08, mid.y - 0.1, z - 0.12), (0.22, 0.18, 0.12), bevel=0.01)
    b.to_object(col)


def build_bleachers(col, f):
    b = Builder('bleachers')
    x1, y1, x2, y2 = f['x1'], f['y1'], f['x2'], f['y2']
    sx1, sx2 = f['stair_x1'], f['stair_x2']
    tiers = 4
    depth = (y2 - y1) / tiers
    for k in range(tiers):
        yf = y1 + k * depth
        h = 0.42 * (k + 1)
        for xa, xb in ((x1, sx1), (sx2, x2)):
            a, c = W(xa, yf), W(xb, y2)
            b.box('oak', ((a.x + c.x) / 2, (a.y + c.y) / 2, h / 2), (abs(c.x - a.x), abs(c.y - a.y), h), bevel=0.012)
            ca, cc = W(xa + 4, yf + 2), W(xb - 4, yf + depth * 0.75)
            b.box('cushion', ((ca.x + cc.x) / 2, (ca.y + cc.y) / 2, h + 0.04), (abs(cc.x - ca.x), abs(cc.y - ca.y), 0.07), bevel=0.025)
    steps = tiers * 2
    sd = (y2 - y1) / steps
    for k in range(steps):
        yf = y1 + k * sd
        h = 0.21 * (k + 1)
        a, c = W(sx1, yf), W(sx2, y2)
        b.box('wood_deck', ((a.x + c.x) / 2, (a.y + c.y) / 2, h / 2), (abs(c.x - a.x), abs(c.y - a.y), h), bevel=0.008)
    b.to_object(col)


def build_platform(col):
    b = Builder('platform')
    pts = [tuple(W(x, y)[:2]) for x, y in L.PLATFORM]
    b.prism('wood_deck', pts, 0.0, 0.14, side_mat='oak')
    b.to_object(col)


def build_wc(col):
    b = Builder('wc')
    # vanity counters
    for y, face in ((437, 1), (722, -1)):
        a, c = W(792, y), W(930, y)
        b.seg_box('desk_white', a, c, 0.55, 0.0, 0.86, bevel=0.01)
        for i in range(3):
            p = W(812 + i * 46, y)
            b.cyl('porcelain', (p.x, p.y, 0.86), 0.17, 0.05, segs=24)
    # stalls: women (y 498-575, doors north), men (y 585-660, doors south)
    cols = [800, 843, 887, 931]
    for y0, y1, front in ((498, 575, 498), (585, 660, 660)):
        for x in cols[1:-1]:
            b.seg_box('partition', W(x, y0), W(x, y1), 0.03, 0.12, 1.35)
        for i in range(3):
            xa, xb = cols[i], cols[i + 1]
            b.seg_box('partition', W(xa, front), W(xa + 8, front), 0.03, 0.12, 1.35)
            b.seg_box('partition', W(xb - 6, front), W(xb, front), 0.03, 0.12, 1.35)
            cx = (xa + xb) / 2
            back = y1 - 9 if front == y0 else y0 + 9
            p = W(cx, back)
            b.box('porcelain', (p.x, p.y, 0.2), (0.38, 0.55, 0.4), bevel=0.06)
            pt = W(cx, back + (6 if front == y0 else -6))
            b.box('porcelain', (pt.x, pt.y, 0.55), (0.42, 0.18, 0.3), bevel=0.04)
    # lit panel on the toilets' west wall
    a, c = W(774, 500), W(774, 650)
    b.seg_box('led_soft', a, c, 0.02, 0.3, 1.3)
    b.to_object(col)


def build_core(col):
    """Service core (stairs + lifts) shown as a solid block; lift doors face the lobby."""
    b = Builder('core')
    pts = [tuple(W(x, y)[:2]) for x, y in ((502, 425), (688, 425), (688, 720), (502, 720))]
    b.prism('core_top', pts, 0.0, L.WALL_H, side_mat='concrete')
    for (p1, p2) in (((502, 425), (688, 425)), ((688, 425), (688, 720)), ((688, 720), (502, 720)), ((502, 720), (502, 425))):
        b.seg_box('cap', W(*p1), W(*p2), 0.1, L.WALL_H, L.WALL_H + 0.012)
    for ya, yb in ((522, 560), (584, 622)):
        a, c = W(692, ya), W(692, yb)
        b.seg_box('steel', a, c, 0.05, 0.0, L.WALL_H - 0.02)
        mid = (ya + yb) / 2
        b.seg_box('metal_dark', W(693, mid - 0.4), W(693, mid + 0.4), 0.055, 0.0, L.WALL_H - 0.02)
        b.seg_box('led', W(694, ya - 2), W(694, yb + 2), 0.02, L.WALL_H - 0.05, L.WALL_H - 0.03)
    b.to_object(col)


def build_tv_wall(col, f):
    b = Builder('tv_wall')
    a, c = W(f['x1'], f['y']), W(f['x2'], f['y'])
    length = (c - a).length
    mid = (a + c) / 2
    b.box('oak', (mid.x, mid.y, 1.1), (length, 0.08, 2.2), bevel=0.006)
    for i in range(int(length / 0.3)):
        x = a.x + 0.15 + i * 0.3
        b.box('walnut', (x, mid.y - 0.041, 1.1), (0.008, 0.004, 2.18))
    b.box('tv', (mid.x, mid.y - 0.06, 1.35), (2.2, 0.04, 1.25), bevel=0.01)
    b.box('led_soft', (mid.x, mid.y - 0.05, 2.18), (length - 0.1, 0.03, 0.015))
    b.box('desk_white', (mid.x, mid.y - 0.3, 0.25), (2.4, 0.45, 0.5), bevel=0.01)
    b.to_object(col)


def build_green_wall(col, f):
    b = Builder('green_wall')
    a, c = W(f['x1'], f['y1']), W(f['x2'], f['y2'])
    b.seg_box('oak', a, c, 0.16, 0.0, 2.2, bevel=0.01)
    b.seg_box('moss', a + Vector((0.06, 0, 0)), c + Vector((0.06, 0, 0)), 0.08, 0.15, 2.05)
    b.to_object(col)


def on_platform(x, y):
    return 0.14 if point_in_poly(x, y, L.PLATFORM) else 0.0


def build_furniture(col):
    random.seed(7)
    for f in L.FURNITURE:
        t = f['t']
        jitter = random.uniform(-5, 5)
        if t == 'bench':
            mesh = asset(f'bench{f["n"]}{"d" if f.get("divider", True) else ""}', lambda b, f=f: make_bench(b, f['n'], f.get('divider', True)))
            rot = 0 if f['axis'] == 'x' else 90
            place(col, mesh, f['x'], f['y'], rot)
            chairs = asset('chair_task', make_chair_task)
            n = f['n']
            for i in range(n):
                off = (-n / 2 + 0.5 + i) * 1.3 * S
                if f['axis'] == 'x':
                    place(col, chairs, f['x'] + off, f['y'] - 1.12 * S, 0 + random.uniform(-8, 8))
                    place(col, chairs, f['x'] + off, f['y'] + 1.12 * S, 180 + random.uniform(-8, 8))
                else:
                    place(col, chairs, f['x'] - 1.12 * S, f['y'] + off, 90 + random.uniform(-8, 8))
                    place(col, chairs, f['x'] + 1.12 * S, f['y'] + off, 270 + random.uniform(-8, 8))
        elif t == 'chair_task':
            place(col, asset('chair_task', make_chair_task), f['x'], f['y'], f['rot'] + jitter * 0.6)
        elif t == 'chair_exec':
            place(col, asset('chair_exec', make_chair_exec), f['x'], f['y'], f['rot'] + jitter)
        elif t == 'chair_guest':
            place(col, asset('chair_guest', make_chair_guest), f['x'], f['y'], f['rot'] + jitter)
        elif t == 'desk_exec':
            mesh = asset(f'desk_exec{f["len"]}', lambda b, f=f: make_desk_exec(b, f['len']))
            place(col, mesh, f['x'], f['y'], f['rot'])
        elif t == 'table_meeting':
            mesh = asset(f'table_meeting{f["len"]}{f["top"]}',
                         lambda b, f=f: make_table_meeting(b, f['len'], f['w'], f['top'], f.get('modules', 2)))
            place(col, mesh, f['x'], f['y'], 0 if f['axis'] == 'x' else 90)
        elif t == 'table_oval':
            mesh = asset('table_oval', lambda b, f=f: make_table_oval(b, f['len'], f['w']))
            place(col, mesh, f['x'], f['y'], 0)
        elif t == 'table_round':
            place(col, asset(f'table_round{f["r"]}', lambda b, f=f: make_table_round(b, f['r'])), f['x'], f['y'], 0)
        elif t == 'sofa':
            mesh = asset(f'sofa{f["len"]}{f["fabric"]}', lambda b, f=f: make_sofa(b, f['len'], f['fabric']))
            place(col, mesh, f['x'], f['y'], f['rot'], z=on_platform(f['x'], f['y']))
        elif t == 'armchair':
            place(col, asset(f'armchair{f["fabric"]}', lambda b, f=f: make_armchair(b, f['fabric'])), f['x'], f['y'], f['rot'])
        elif t == 'coffee_table':
            place(col, asset(f'coffee{f["len"]}{f["w"]}', lambda b, f=f: make_coffee_table(b, f['len'], f['w'])), f['x'], f['y'], 0,
                  z=on_platform(f['x'], f['y']))
        elif t == 'rug':
            b = Builder('rug')
            b.box(f['mat'], (0, 0, 0.008), (f['len'], f['w'], 0.012), bevel=0.004)
            b.to_object(col, location=W(f['x'], f['y'], on_platform(f['x'], f['y'])))
        elif t == 'credenza':
            place(col, asset(f'credenza{f["len"]}', lambda b, f=f: make_credenza(b, f['len'])), f['x'], f['y'], f['rot'])
        elif t == 'cabinet':
            place(col, asset(f'cabinet{f["len"]}', lambda b, f=f: make_cabinet(b, f['len'])), f['x'], f['y'], f['rot'])
        elif t == 'plant':
            kind = 'floor'
            mesh = asset(f'plant{hash((f["x"], f["y"])) % 4}', plant_builder(hash((f['x'], f['y'])) % 4, kind))
            z = on_platform(f['x'], f['y'])
            if f.get('s', 1) < 0.6:
                mesh = asset('plant_small', plant_builder(11, 'small'))
                z = 1.1
            place(col, mesh, f['x'], f['y'], random.uniform(0, 360), z=z, scale=f.get('s', 1.0) if f.get('s', 1) >= 0.6 else 1.0)
        elif t == 'floor_lamp':
            z = on_platform(f['x'], f['y'])
            place(col, asset('floor_lamp', make_floor_lamp), f['x'], f['y'], 0, z=z)
            light = bpy.data.lights.new('lamp', 'POINT')
            light.energy = 40
            light.color = (1.0, 0.75, 0.5)
            light.shadow_soft_size = 0.15
            lo = bpy.data.objects.new('lamp', light)
            lo.location = W(f['x'], f['y'], z + 1.54)
            col.objects.link(lo)
        elif t == 'pouf':
            place(col, asset('pouf', make_pouf), f['x'], f['y'], 0, z=on_platform(f['x'], f['y']))
        elif t == 'side_table':
            place(col, asset('side_table', make_side_table), f['x'], f['y'], 0)
        elif t == 'whiteboard':
            place(col, asset('whiteboard', make_whiteboard), f['x'], f['y'], f['rot'])
        elif t == 'shelving':
            place(col, asset(f'shelving{f["len"]}', lambda b, f=f: make_shelving(b, f['len'])), f['x'], f['y'], f['rot'])
        elif t == 'rack':
            place(col, asset('rack', make_rack), f['x'], f['y'], f['rot'])
        elif t == 'reception':
            build_reception(col)
        elif t == 'feature_shelves':
            build_feature_shelves(col, f['x1'], f['x2'], f['y'])
        elif t == 'bleachers':
            build_bleachers(col, f)
        elif t == 'platform':
            build_platform(col)
        elif t == 'wc_block':
            build_wc(col)
        elif t == 'core':
            build_core(col)
        elif t == 'tv_wall':
            build_tv_wall(col, f)
        elif t == 'green_wall':
            build_green_wall(col, f)
        else:
            raise ValueError(f'unknown furniture type {t}')


def build_lights(col, office, energy):
    def add(x, y, e=energy, size=0.45, z=2.75, color=(1.0, 0.78, 0.52)):
        light = bpy.data.lights.new('pool', 'SPOT')
        light.spot_size = math.radians(132)
        light.spot_blend = 0.9
        light.shadow_soft_size = size
        light.energy = e
        light.color = color
        obj = bpy.data.objects.new('pool', light)
        obj.location = W(x, y, z)
        obj.visible_camera = False
        col.objects.link(obj)

    step = 3.6 * S
    for r in office['rooms']:
        poly = r['polygon']
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        nx = max(1, round((x1 - x0) / step))
        ny = max(1, round((y1 - y0) / step))
        k = 1.0 if r['kind'] in ('office', 'meeting') else 0.85
        if r['id'] in ('core', 'store', 'data-center'):
            continue
        if r['kind'] == 'service':
            k = 0.5
        for i in range(nx):
            for j in range(ny):
                x = x0 + (i + 0.5) * (x1 - x0) / nx
                y = y0 + (j + 0.5) * (y1 - y0) / ny
                if point_in_poly(x, y, poly):
                    add(x, y, energy * k)
    for x, y in L.EXTRA_LIGHTS:
        add(x, y, energy * 0.6)


def setup_world(scene, ambient, color=(0.42, 0.46, 0.55)):
    world = bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (*color, 1)
    bg.inputs['Strength'].default_value = ambient


def add_sun(col):
    light = bpy.data.lights.new('sun', 'SUN')
    light.energy = 3.2
    light.angle = math.radians(2.5)
    light.color = (1.0, 0.95, 0.86)
    obj = bpy.data.objects.new('sun', light)
    obj.rotation_euler = (math.radians(52), math.radians(-18), math.radians(35))
    col.objects.link(obj)


def setup_hero_camera(scene):
    """Low, wide perspective from above the lounge corner across the reception toward the core."""
    cam_data = bpy.data.cameras.new('hero')
    cam_data.lens = 24
    cam_data.sensor_width = 36
    cam_data.dof.use_dof = True
    cam_data.dof.aperture_fstop = 5.6
    cam = bpy.data.objects.new('hero', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    # eye at standing height inside the lounge corner, looking across the reception
    # counter: the cut walls stay out of frame, the LED glow and the lounge lamp carry the mood
    eye = W(1098, 1010, 1.45)
    target = W(860, 790, 1.0)
    cam_data.lens = 32
    cam_data.dof.aperture_fstop = 2.8
    cam.location = eye
    cam.rotation_euler = (target - eye).to_track_quat('-Z', 'Y').to_euler()
    cam_data.dof.focus_distance = (target - eye).length * 0.9
    bpy.context.view_layer.update()
    return cam


def add_key_light(col, energy):
    light = bpy.data.lights.new('sky_key', 'AREA')
    light.shape = 'RECTANGLE'
    light.size = 26
    light.size_y = 26
    light.energy = energy
    light.color = (0.86, 0.9, 1.0)
    obj = bpy.data.objects.new('sky_key', light)
    obj.location = (-8, -10, 34)
    obj.rotation_euler = (math.radians(14), math.radians(-12), 0)
    obj.visible_camera = False
    col.objects.link(obj)


def add_ground(col):
    b = Builder('ground')
    b.box('slab', (0, 0, -L.SLAB - 0.05), (200, 200, 0.1))
    obj = b.to_object(col)
    obj.is_shadow_catcher = True
    return obj


# ------------------------------------------------------------------ camera
def bounds_points():
    pts = []
    for x, y in L.OUTLINE:
        pts += [W(x, y, -L.SLAB), W(x, y, L.WALL_H + 0.1)]
    for x0, y0, x1, y1 in L.FINS:
        for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
            pts += [W(x, y, -L.SLAB), W(x, y, 0.6)]
    return pts


def setup_camera(scene, yaw, pitch, lens, margin):
    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = lens
    cam_data.sensor_width = 36
    cam_data.sensor_fit = 'HORIZONTAL'
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    target = Vector((0, 0, 0))
    direction = Vector((math.sin(math.radians(yaw)) * math.cos(math.radians(pitch)),
                        -math.cos(math.radians(yaw)) * math.cos(math.radians(pitch)),
                        math.sin(math.radians(pitch))))
    pts = bounds_points()

    def fit(dist):
        cam.location = target + direction * dist
        cam.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()
        cam_data.shift_x = cam_data.shift_y = 0
        bpy.context.view_layer.update()
        uv = [world_to_camera_view(scene, cam, p) for p in pts]
        us, vs = [c.x for c in uv], [c.y for c in uv]
        return min(us), max(us), min(vs), max(vs)

    lo, hi = 10.0, 400.0
    aspect = scene.render.resolution_x / scene.render.resolution_y
    for _ in range(40):
        mid = (lo + hi) / 2
        u0, u1, v0, v1 = fit(mid)
        if (u1 - u0) <= 1 - 2 * margin and (v1 - v0) <= 1 - 2 * margin:
            hi = mid
        else:
            lo = mid
    u0, u1, v0, v1 = fit(hi)
    # centre with lens shift (shift is relative to the larger sensor dimension)
    cam_data.shift_x = (u0 + u1 - 1) / 2
    cam_data.shift_y = (v0 + v1 - 1) / 2 / aspect
    bpy.context.view_layer.update()
    return cam


def project(scene, cam, p):
    co = world_to_camera_view(scene, cam, p)
    return (co.x * scene.render.resolution_x, (1 - co.y) * scene.render.resolution_y)


def homography(src, dst):
    import numpy as np
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        A.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, _, vt = np.linalg.svd(np.array(A, dtype=float))
    h = vt[-1].reshape(3, 3)
    h = h / h[2, 2]
    err = 0.0
    for (x, y), (u, v) in zip(src, dst):
        w = h[2, 0] * x + h[2, 1] * y + h[2, 2]
        pu = (h[0, 0] * x + h[0, 1] * y + h[0, 2]) / w
        pv = (h[1, 0] * x + h[1, 1] * y + h[1, 2]) / w
        err = max(err, abs(pu - u), abs(pv - v))
    return [float(round(v, 10)) for v in h.flatten()], err


# ------------------------------------------------------------------ render
def configure_render(scene, res, samples, exposure):
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.02
    scene.cycles.use_denoising = True
    try:
        scene.cycles.denoiser = 'OPENIMAGEDENOISE'
    except TypeError:
        pass
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 3
    scene.cycles.glossy_bounces = 2
    scene.cycles.transmission_bounces = 4
    scene.cycles.transparent_max_bounces = 12
    scene.cycles.sample_clamp_indirect = 4.0
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.render.film_transparent = True
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '8'
    scene.view_settings.view_transform = 'AgX'
    try:
        scene.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    scene.view_settings.exposure = exposure


def render_to(scene, path):
    scene.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print(f'rendered {os.path.basename(path)} in {time.time() - t:.0f}s', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, '.twin-render'))  # PNGs: not the deployed folder
    ap.add_argument('--res', default='2400x1600')
    ap.add_argument('--samples', type=int, default=64)
    ap.add_argument('--yaw', type=float, default=-14.0)
    ap.add_argument('--pitch', type=float, default=50.0)
    ap.add_argument('--lens', type=float, default=50.0)
    ap.add_argument('--margin', type=float, default=0.035)
    ap.add_argument('--light', type=float, default=200.0, help='energy (W) per ceiling light pool')
    ap.add_argument('--ambient', type=float, default=0.16)
    ap.add_argument('--key', type=float, default=450.0)
    ap.add_argument('--exposure', type=float, default=0.0)
    ap.add_argument('--focus', default='meeting-large', help='comma-separated room ids to render focus crops for')
    ap.add_argument('--focus-frame', type=float, default=0.6)
    ap.add_argument('--preview', action='store_true')
    ap.add_argument('--no-plan', action='store_true')
    ap.add_argument('--save-blend', default='')
    ap.add_argument('--hero', action='store_true', help='render the welcome perspective instead of the plan views')
    ap.add_argument('--daylight', action='store_true', help='daylight rig (strong sun, bright sky) instead of the evening pools')
    args = ap.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])

    res = tuple(int(v) for v in args.res.lower().split('x'))
    if args.preview:
        res = (res[0] // 3, res[1] // 3)
        args.samples = min(args.samples, 24)
    os.makedirs(args.out, exist_ok=True)

    with open(os.path.join(ROOT, 'data', 'office.json'), encoding='utf-8') as fh:
        office = json.load(fh)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    configure_render(scene, res, args.samples, args.exposure)
    build_materials()
    col = bpy.data.collections.new('twin')
    scene.collection.children.link(col)
    t0 = time.time()
    build_architecture(col, office)
    build_furniture(col)
    if args.daylight:
        build_lights(col, office, args.light * 0.25)
        add_sun(col)
        add_key_light(col, args.key * 2.2)
        add_ground(col)
        setup_world(scene, max(args.ambient, 0.9), color=(0.62, 0.72, 0.88))
    else:
        build_lights(col, office, args.light)
        add_key_light(col, args.key)
        add_ground(col)
        setup_world(scene, args.ambient)
    if args.hero:
        cam = setup_hero_camera(scene)
    else:
        cam = setup_camera(scene, args.yaw, args.pitch, args.lens, args.margin)
    print(f'scene built in {time.time() - t0:.1f}s, objects: {len(bpy.data.objects)}', flush=True)
    if args.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=args.save_blend)

    if args.hero:
        scene.render.resolution_x, scene.render.resolution_y = res
        scene.render.film_transparent = False
        render_to(scene, os.path.join(args.out, 'hero-preview.png' if args.preview else 'hero.png'))
        print('done')
        return

    # projections (computed at the final resolution)
    full = tuple(int(v) for v in args.res.lower().split('x'))
    scene.render.resolution_x, scene.render.resolution_y = full
    bpy.context.view_layer.update()
    grid = [(x, y) for x in range(150, 1201, 150) for y in range(40, 1121, 120)]
    hom = {}
    for key, z in (('floor', 0.0), ('top', L.WALL_H)):
        dst = [project(scene, cam, W(x, y, z)) for x, y in grid]
        hom[key], err = homography(grid, dst)
        print(f'homography {key}: max reprojection error {err:.4f}px')
    info = {
        'image': {'width': full[0], 'height': full[1]},
        'plan': {'scale': S, 'wallHeight': L.WALL_H},
        'camera': {'yaw': args.yaw, 'pitch': args.pitch, 'lens': args.lens},
        'homography': hom,
        'focusFrame': args.focus_frame,
        'focus': {},
    }
    rooms = {r['id']: r for r in office['rooms']}
    focus_ids = [f for f in args.focus.split(',') if f]
    for rid in focus_ids:
        poly = rooms[rid]['polygon']
        pts = [project(scene, cam, W(x, y, z)) for x, y in poly for z in (0.0, L.WALL_H)]
        cx = (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2
        cy = (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2
        fw, fh = full[0] * args.focus_frame, full[1] * args.focus_frame
        x0 = min(max(cx - fw / 2, 0), full[0] - fw)
        y0 = min(max(cy - fh / 2, 0), full[1] - fh)
        info['focus'][rid] = {'rect': [round(x0, 2), round(y0, 2), round(fw, 2), round(fh, 2)]}

    scene.render.resolution_x, scene.render.resolution_y = res
    if not args.no_plan:
        render_to(scene, os.path.join(args.out, 'plan-preview.png' if args.preview else 'plan.png'))
    if focus_ids:
        k = 1 / args.focus_frame / (3 if args.preview else 1)
        for rid in focus_ids:
            x0, y0, fw, fh = info['focus'][rid]['rect']
            scene.render.resolution_x = round(full[0] * k)
            scene.render.resolution_y = round(full[1] * k)
            scene.render.use_border = True
            scene.render.use_crop_to_border = True
            scene.render.border_min_x = x0 / full[0]
            scene.render.border_max_x = (x0 + fw) / full[0]
            scene.render.border_min_y = 1 - (y0 + fh) / full[1]
            scene.render.border_max_y = 1 - y0 / full[1]
            render_to(scene, os.path.join(args.out, f'focus-{rid}{"-preview" if args.preview else ""}.png'))
            scene.render.use_border = False
    with open(os.path.join(args.out, 'twin.json'), 'w', encoding='utf-8') as fh:
        json.dump(info, fh, ensure_ascii=False, indent=2)
    print('done')


if __name__ == '__main__':
    main()
