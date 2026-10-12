# Blender script: builds the OX Island mascot (an original ox character) and
# renders it to PNG with a transparent background. The island draws the eyes
# live (blink, gaze, moods), so by default no eyes are modelled and the eye
# anchor points are written to ox-body.json. Pass `eyes` to bake preview eyes.
#
#   Blender -b -P ox_model.py -- <out_dir> [size] [style] [eyes]
#   style: soft | toy | noir   (default soft)
#
# Re-run after any change; commit the PNG + JSON next to the Swift sources.

import json
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else ".")
SIZE = int(argv[1]) if len(argv) > 1 else 512
STYLE = argv[2] if len(argv) > 2 else "soft"
BAKE_EYES = len(argv) > 3 and argv[3] == "eyes"
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def hexc(h, a=1.0):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, a)


def material(name, color, rough=0.4, coat=0.0, metal=0.0, sss=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = hexc(color)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    for key, val in (("Coat Weight", coat), ("Subsurface Weight", sss)):
        if key in p.inputs:
            p.inputs[key].default_value = val
    return m


def sphere(name, loc, scale, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    o.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return o


def horn_pair(mat, pts, radii, depth):
    for sx in (-1, 1):
        curve = bpy.data.curves.new(f"horn_{sx}", "CURVE")
        curve.dimensions = "3D"
        curve.bevel_depth = depth
        curve.bevel_resolution = 8
        curve.use_fill_caps = True
        spl = curve.splines.new("BEZIER")
        spl.bezier_points.add(len(pts) - 1)
        for bp, (x, y, z), r in zip(spl.bezier_points, pts, radii):
            bp.co = (x * sx, y, z)
            bp.handle_left_type = bp.handle_right_type = "AUTO"
            bp.radius = r
        obj = bpy.data.objects.new(f"horn_{sx}", curve)
        scene.collection.objects.link(obj)
        obj.data.materials.append(mat)


# Eye placement shared by every style (head-local, front surface).
EYE = (0.34, -0.9, 0.16)

if STYLE == "soft":
    # Coucou-grade softness, our own character: a plump cream bean, nub horns,
    # tiny ears, blush, a small brass ring. Nothing sharp anywhere.
    BODY = material("body", "#FFF4E6", rough=0.38, coat=0.35, sss=0.25)
    ACCENT = material("accent", "#F4B98A", rough=0.45, coat=0.2)
    HORN = material("horn", "#E9A66B", rough=0.3, coat=0.5)
    BLUSH = material("blush", "#FF9E8F", rough=0.6)
    BRASS = material("brass", "#F2C14E", rough=0.18, metal=1.0)
    sphere("head", (0, 0, 0), (1.15, 0.95, 1.0), BODY)
    horn_pair(HORN, [(0.55, 0.0, 0.78), (0.78, -0.02, 0.98), (0.86, -0.04, 1.18)], [1.0, 0.8, 0.45], 0.15)
    for sx in (-1, 1):
        sphere(f"ear_{sx}", (1.12 * sx, 0.08, 0.32), (0.32, 0.14, 0.17), ACCENT, rot=(0, math.radians(-20 * sx), 0))
        sphere(f"blush_{sx}", (0.58 * sx, -0.86, -0.12), (0.15, 0.04, 0.09), BLUSH)
        sphere(f"nostril_{sx}", (0.13 * sx, -0.99, -0.34), (0.045, 0.03, 0.06), material(f"n{sx}", "#C98A6A"))
    bpy.ops.mesh.primitive_torus_add(major_radius=0.12, minor_radius=0.03, location=(0, -0.98, -0.5), rotation=(math.radians(90), 0, 0))
    bpy.context.active_object.data.materials.append(BRASS)
    bpy.ops.object.shade_smooth()
    EYE = (0.34, -0.93, 0.12)
    EYE_COLOR = "#1A1512"
    cam_scale, cam_z = 3.3, 0.2
else:
    noir = STYLE == "noir"
    BODY = material("body", "#2A2B30" if noir else "#D9894E", rough=0.5 if noir else 0.32, coat=0.25 if noir else 0.6, sss=0.0 if noir else 0.08)
    DARK = material("dark", "#1C1D21" if noir else "#A9602F", rough=0.45, coat=0.3)
    SNOUT = material("snout", "#3A3B42" if noir else "#FFE1C2", rough=0.4, coat=0.4)
    HORN = material("horn", "#F2C14E" if noir else "#FFF3DE", rough=0.2, coat=0.8, metal=1.0 if noir else 0.0)
    EAR_IN = material("ear_in", "#55565E" if noir else "#F49C8E", rough=0.5)
    NOSTRIL = material("nostril", "#111214" if noir else "#5A3320", rough=0.6)
    BRASS = material("brass", "#F2C14E", rough=0.18, metal=1.0)
    bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
    head = bpy.context.active_object
    head.scale = (1.08, 0.92, 0.98)
    bev = head.modifiers.new("bevel", "BEVEL")
    bev.width = 0.75
    bev.segments = 6
    sub = head.modifiers.new("subsurf", "SUBSURF")
    sub.levels = sub.render_levels = 3
    head.data.materials.append(BODY)
    bpy.ops.object.shade_smooth()
    sphere("snout", (0, -0.86, -0.5), (0.7, 0.4, 0.44), SNOUT)
    for sx in (-1, 1):
        sphere(f"nostril_{sx}", (0.24 * sx, -1.21, -0.44), (0.085, 0.05, 0.11), NOSTRIL)
        sphere(f"ear_{sx}", (1.12 * sx, 0.05, 0.28), (0.42, 0.16, 0.22), DARK, rot=(0, math.radians(-25 * sx), 0))
        sphere(f"ear_in_{sx}", (1.14 * sx, -0.06, 0.27), (0.3, 0.06, 0.13), EAR_IN, rot=(0, math.radians(-25 * sx), 0))
    bpy.ops.mesh.primitive_torus_add(major_radius=0.2, minor_radius=0.045, location=(0, -1.19, -0.72), rotation=(math.radians(90), 0, 0))
    bpy.context.active_object.data.materials.append(BRASS)
    bpy.ops.object.shade_smooth()
    horn_pair(HORN, [(0.78, 0.05, 0.6), (1.25, -0.02, 0.72), (1.36, -0.06, 1.05)], [1.0, 0.78, 0.25], 0.21)
    EYE_COLOR = "#FFB347" if noir else "#1A1512"
    cam_scale, cam_z = 3.9, 0.4

if BAKE_EYES:
    INK = material("eye", EYE_COLOR, rough=0.15, coat=1.0)
    SHINE = material("shine", "#FFFFFF", rough=0.1)
    for sx in (-1, 1):
        x, y, z = EYE
        sphere(f"eye_{sx}", (x * sx, y, z), (0.1, 0.05, 0.14), INK)
        sphere(f"glint_{sx}", (x * sx - 0.03, y - 0.05, z + 0.05), (0.035, 0.02, 0.035), SHINE)

# ---------------------------------------------------------------- camera & light
bpy.ops.object.camera_add(location=(0, -8.0, cam_z), rotation=(math.radians(87), 0, 0))
cam = bpy.context.active_object
cam.data.type = "ORTHO"
cam.data.ortho_scale = cam_scale
scene.camera = cam


def area(loc, energy, size, rot):
    bpy.ops.object.light_add(type="AREA", location=loc, rotation=rot)
    l = bpy.context.active_object
    l.data.energy = energy
    l.data.size = size


area((-3.2, -4.5, 4.2), 900, 4.0, (math.radians(50), 0, math.radians(-35)))
area((3.5, -4.0, 1.0), 300, 5.0, (math.radians(75), 0, math.radians(40)))
area((0.0, 4.0, 3.5), 800, 3.0, (math.radians(-45), 0, 0))
world = bpy.data.worlds.new("w")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.18, 0.18, 0.2, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6

for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = SIZE
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Standard"
name = "ox-body" if not BAKE_EYES else f"preview-{STYLE}"
scene.render.filepath = os.path.join(OUT, f"{name}.png")
bpy.ops.render.render(write_still=True)

if not BAKE_EYES:
    def project(v):
        p = world_to_camera_view(scene, cam, Vector(v))
        return [round(p.x, 4), round(1 - p.y, 4)]
    x, y, z = EYE
    left, right = project((-x, y, z)), project((x, y, z))
    edge = project((x + 0.12, y, z))
    with open(os.path.join(OUT, "ox-body.json"), "w") as f:
        json.dump({"left": left, "right": right, "radius": round(abs(edge[0] - right[0]), 4), "style": STYLE, "eyeColor": EYE_COLOR}, f, indent=2)
print("OX_RENDER_DONE", OUT, STYLE)
