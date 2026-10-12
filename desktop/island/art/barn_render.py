# Blender script: the bull's barn, modelled here (no downloaded asset) in the
# same low-poly style, lighting and camera as bull_render.py, so the two read
# as one world. Renders the states the island animates between:
#
#   Blender -b -P barn_render.py -- <out_dir> [width]
#   -> barn/open.png, barn/closed.png, barn/closed_lit.png
#
# Three-quarter view from the front-left: the door faces the bull's approach.

import math
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else ".")
WIDTH = int(argv[1]) if len(argv) > 1 else 256
os.makedirs(os.path.join(OUT, "barn"), exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def hexc(h, a=1.0):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb] + [a]


def mat(name, color, rough=0.7, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = hexc(color)
    b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission Color"].default_value = hexc(emit)
        b.inputs["Emission Strength"].default_value = strength
    return m


RED = mat("barn_red", "#A3352B", 0.75)
RED_DARK = mat("barn_red_dark", "#7A2620", 0.8)
TRIM = mat("trim", "#F1E6D2", 0.6)
ROOF = mat("roof", "#3A2B24", 0.85)
STONE = mat("stone", "#6B6660", 0.9)
DARK = mat("inside", "#140C0A", 1.0)
HAY = mat("hay", "#E2B65A", 0.9)


def box(name, size, loc, material, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    o.data.materials.append(material)
    return o


# Body: 3 wide (x), 2.4 deep (y), 2 tall, on a stone footing.
W, D, H = 3.0, 2.4, 2.0
box("footing", (W + 0.1, D + 0.1, 0.18), (0, 0, 0.09), STONE)
body = box("body", (W, D, H), (0, 0, 0.18 + H / 2), RED)
# Vertical plank grooves on the front face.
for i in range(1, 10):
    box(f"plank{i}", (0.02, 0.02, H - 0.05), (-W / 2 + i * W / 10, -D / 2 - 0.005, 0.18 + H / 2), RED_DARK)
# Corner trim.
for sx in (-1, 1):
    for sy in (-1, 1):
        box(f"corner{sx}{sy}", (0.1, 0.1, H), (sx * W / 2, sy * D / 2, 0.18 + H / 2), TRIM)

# Gambrel roof. The gable profile is drawn across the WIDTH (x) at the front
# and back walls (y = -/+D/2), and the roof runs front to back along y, so the
# classic barn shape faces the camera with the door under it.
top = 0.18 + H
PROFILE = [(-W / 2 - 0.12, top), (-W / 2 * 0.62, top + 0.62), (0, top + 1.0), (W / 2 * 0.62, top + 0.62), (W / 2 + 0.12, top)]


def gable(name, y, material):
    verts = [(x, y, z) for x, z in PROFILE]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], [list(range(len(verts)))])
    o = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(o)
    o.data.materials.append(material)
    sol = o.modifiers.new("thick", "SOLIDIFY")
    sol.thickness = 0.08
    return o


gable("gable_front", -D / 2 + 0.01, RED)
gable("gable_back", D / 2 - 0.01, RED)

# Roof slabs along each profile edge, overhanging front and back.
for i in range(len(PROFILE) - 1):
    (x0, z0), (x1, z1) = PROFILE[i], PROFILE[i + 1]
    length = math.hypot(x1 - x0, z1 - z0) + 0.06
    ang = math.atan2(z1 - z0, x1 - x0)
    box(f"roof{i}", (length, D + 0.4, 0.09), ((x0 + x1) / 2, 0, (z0 + z1) / 2 + 0.05), ROOF, rot=(0, -ang, 0))
# White barge trim along the front edge of the roof.
for i in range(len(PROFILE) - 1):
    (x0, z0), (x1, z1) = PROFILE[i], PROFILE[i + 1]
    length = math.hypot(x1 - x0, z1 - z0) + 0.04
    ang = math.atan2(z1 - z0, x1 - x0)
    box(f"barge{i}", (length, 0.06, 0.07), ((x0 + x1) / 2, -D / 2 - 0.22, (z0 + z1) / 2 + 0.06), TRIM, rot=(0, -ang, 0))

# Hay loft in the gable: a dark opening with hay and a trim frame.
loft_z = top + 0.42
box("loft", (0.62, 0.05, 0.42), (0, -D / 2 - 0.03, loft_z), DARK)
box("loft_hay", (0.52, 0.06, 0.14), (0, -D / 2 - 0.04, loft_z - 0.13), HAY)
box("loft_top", (0.74, 0.07, 0.06), (0, -D / 2 - 0.05, loft_z + 0.24), TRIM)
box("loft_sill", (0.74, 0.07, 0.06), (0, -D / 2 - 0.05, loft_z - 0.24), TRIM)
for dx in (-0.34, 0.34):
    box(f"loft_trim{dx}", (0.06, 0.07, 0.48), (dx, -D / 2 - 0.05, loft_z), TRIM)

# Doorway: a dark opening; the door itself is toggled per render.
DOOR_W, DOOR_H = 1.3, 1.45
box("doorway", (DOOR_W, 0.05, DOOR_H), (0, -D / 2 - 0.01, 0.18 + DOOR_H / 2), DARK)
door = box("door", (DOOR_W, 0.08, DOOR_H), (0, -D / 2 - 0.05, 0.18 + DOOR_H / 2), RED_DARK)
door_x = []
for a in (1, -1):
    door_x.append(box(f"door_x{a}", (math.hypot(DOOR_W, DOOR_H) * 0.95, 0.03, 0.08),
                      (0, -D / 2 - 0.1, 0.18 + DOOR_H / 2), TRIM, rot=(0, a * math.atan2(DOOR_H, DOOR_W), 0)))
frame = [box("door_top", (DOOR_W + 0.14, 0.09, 0.08), (0, -D / 2 - 0.06, 0.18 + DOOR_H + 0.04), TRIM)]
for dx in (-1, 1):
    frame.append(box(f"door_side{dx}", (0.08, 0.09, DOOR_H), (dx * (DOOR_W / 2 + 0.04), -D / 2 - 0.06, 0.18 + DOOR_H / 2), TRIM))

# The lantern above the door: off, or lit (emissive + a small light).
LANTERN_OFF = mat("lantern_off", "#5C4A2E", 0.5)
LANTERN_ON = mat("lantern_on", "#FFC96B", 0.3, emit="#FFB547", strength=12.0)
lantern = box("lantern", (0.16, 0.16, 0.22), (DOOR_W / 2 + 0.3, -D / 2 - 0.12, 0.18 + DOOR_H + 0.15), LANTERN_OFF)
bpy.ops.object.light_add(type="POINT", location=(DOOR_W / 2 + 0.3, -D / 2 - 0.4, 0.18 + DOOR_H + 0.1))
lamp = bpy.context.active_object
lamp.data.energy = 0
lamp.data.color = hexc("#FFB547")[:3]
lamp.data.shadow_soft_size = 0.3

# ---- camera and light: the bull's look (ortho, warm key, cool fill, rim).
bpy.ops.object.camera_add(location=(-7.5, -9.5, 4.2))
cam = bpy.context.active_object
cam.data.type = "ORTHO"
cam.data.ortho_scale = 5.6
target = bpy.data.objects.new("target", None)
scene.collection.objects.link(target)
target.location = (0, 0, 1.35)
c = cam.constraints.new("TRACK_TO")
c.target = target
c.track_axis = "TRACK_NEGATIVE_Z"
c.up_axis = "UP_Y"
scene.camera = cam


def light(loc, energy, size, color):
    bpy.ops.object.light_add(type="AREA", location=loc)
    l = bpy.context.active_object
    l.data.energy = energy
    l.data.size = size
    l.data.color = hexc(color)[:3]
    t = l.constraints.new("TRACK_TO")
    t.target = target
    t.track_axis = "TRACK_NEGATIVE_Z"
    t.up_axis = "UP_Y"


light((-6, -5, 6), 900, 5, "#FFE6C7")   # warm key
light((-6, 6, 2), 260, 6, "#C9D8FF")    # cool fill
light((6, 2, 5), 1100, 4, "#BFD4FF")    # rim

world = bpy.data.worlds.new("w")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.1, 0.1, 0.12, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6

for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
scene.render.film_transparent = True
scene.render.resolution_x = WIDTH
scene.render.resolution_y = WIDTH * 9 // 10
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
try:
    scene.view_settings.view_transform = "AgX"
except TypeError:
    scene.view_settings.view_transform = "Filmic"


def shot(name, door_open, lit):
    for o in [door, *door_x]:
        o.hide_render = door_open
    lantern.data.materials[0] = LANTERN_ON if lit else LANTERN_OFF
    lamp.data.energy = 40 if lit else 0
    scene.render.filepath = os.path.join(OUT, "barn", f"{name}.png")
    bpy.ops.render.render(write_still=True)


shot("open", True, False)
shot("closed", False, False)
shot("closed_lit", False, True)
print("OX_BARN_DONE", OUT)
