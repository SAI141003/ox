# Blender script: a realistic bull head for OX (logo, island mascot, intro).
# Organic forms are built from overlapping volumes, fused with a voxel remesh,
# smoothed, and given skin detail; graphite hide, wet nose, glossy eyes, heavy
# horns, gold nose ring, cinematic three-point light, transparent background.
#
#   Blender -b -P ox_real.py -- <out_dir> [size] [mode]
#   mode: still (default) | idle  (idle = looping breathing/ear/blink frames)

import math
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else ".")
SIZE = int(argv[1]) if len(argv) > 1 else 768
MODE = argv[2] if len(argv) > 2 else "still"
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def hexc(h):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb) + (1.0,)


def principled(name, color, rough, metal=0.0, coat=0.0, sheen=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = hexc(color)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    for k, v in (("Coat Weight", coat), ("Sheen Weight", sheen)):
        if k in p.inputs:
            p.inputs[k].default_value = v
    return m, p


# ---------------------------------------------------------------- materials
def hide_material():
    m, p = principled("hide", "#2E3036", 0.62, sheen=0.6)
    nt = m.node_tree
    # Fine skin/fur bump: two noise scales so it reads at any size.
    tex = nt.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = 120.0
    tex.inputs["Detail"].default_value = 8.0
    tex2 = nt.nodes.new("ShaderNodeTexNoise")
    tex2.inputs["Scale"].default_value = 18.0
    mix = nt.nodes.new("ShaderNodeMixRGB")
    mix.inputs["Fac"].default_value = 0.35
    nt.links.new(tex.outputs["Fac"], mix.inputs["Color1"])
    nt.links.new(tex2.outputs["Fac"], mix.inputs["Color2"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.18
    nt.links.new(mix.outputs["Color"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], p.inputs["Normal"])
    # Slight colour variation so the hide is not plastic.
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = hexc("#23252A")
    ramp.color_ramp.elements[1].color = hexc("#3A3D45")
    nt.links.new(tex2.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], p.inputs["Base Color"])
    return m


def horn_material():
    m, p = principled("horn", "#E8DCC4", 0.28, coat=0.6)
    nt = m.node_tree
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])
    absx = nt.nodes.new("ShaderNodeMath")
    absx.operation = "ABSOLUTE"
    nt.links.new(sep.outputs["X"], absx.inputs[0])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    # Pale base near the skull darkening to a polished black tip.
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = hexc("#E8DCC4")
    ramp.color_ramp.elements[1].position = 0.95
    ramp.color_ramp.elements[1].color = hexc("#2A2420")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.4
    mr.inputs["From Max"].default_value = 1.9
    nt.links.new(absx.outputs["Value"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], p.inputs["Base Color"])
    return m


HIDE = hide_material()
HORN = horn_material()
NOSE, _ = principled("nose", "#121214", 0.12, coat=1.0)          # wet nose
EYE, _ = principled("eye", "#1A0F0A", 0.03, coat=1.0)            # glossy dark eye
LID, _ = principled("lid", "#1E1F24", 0.7)
GOLD, _ = principled("gold", "#F2C14E", 0.16, metal=1.0)
INNER, _ = principled("ear_inner", "#5A4A48", 0.7)

# ---------------------------------------------------------------- head volumes
def blob(loc, scale, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = scale
    return o


# Forward is -Y. Units ~ 1 = half a head width.
volumes = [
    blob((0, 0.1, 0.35), (0.86, 0.95, 0.72)),        # cranium
    blob((0, 0.05, 0.78), (0.72, 0.45, 0.3)),        # poll (flat top between horns)
    blob((0, -0.55, 0.18), (0.62, 0.8, 0.55)),       # face plane
    blob((0, -1.15, -0.25), (0.6, 0.55, 0.5)),       # muzzle
    blob((0, -1.0, -0.6), (0.5, 0.55, 0.28)),        # lower jaw / chin
    blob((0.5, -0.35, 0.42), (0.3, 0.32, 0.22)),     # brow ridge R
    blob((-0.5, -0.35, 0.42), (0.3, 0.32, 0.22)),    # brow ridge L
    blob((0.55, -0.05, -0.1), (0.38, 0.55, 0.45)),   # cheek R
    blob((-0.55, -0.05, -0.1), (0.38, 0.55, 0.45)),  # cheek L
    blob((0, 0.75, -0.55), (0.85, 0.9, 0.95)),       # neck root
]
bpy.ops.object.select_all(action="DESELECT")
for v in volumes:
    v.select_set(True)
bpy.context.view_layer.objects.active = volumes[0]
bpy.ops.object.join()
head = bpy.context.active_object
head.name = "head"
rm = head.modifiers.new("remesh", "REMESH")
rm.mode = "VOXEL"
rm.voxel_size = 0.035
bpy.ops.object.modifier_apply(modifier="remesh")
sm = head.modifiers.new("smooth", "CORRECTIVE_SMOOTH")
sm.factor = 0.9
sm.iterations = 25
bpy.ops.object.modifier_apply(modifier="smooth")
sub = head.modifiers.new("sub", "SUBSURF")
sub.levels = sub.render_levels = 1
head.data.materials.append(HIDE)
bpy.ops.object.shade_smooth()

# ---------------------------------------------------------------- features
def part(loc, scale, mat, rot=(0, 0, 0), name="part"):
    o = blob(loc, scale, rot)
    o.name = name
    o.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return o


# Wet nose pad with flared nostrils.
part((0, -1.62, -0.18), (0.42, 0.12, 0.3), NOSE, name="nosepad")
for sx in (-1, 1):
    part((0.2 * sx, -1.72, -0.2), (0.08, 0.05, 0.12), principled(f"nostril{sx}", "#050505", 0.4)[0], rot=(0, math.radians(20 * sx), 0), name="nostril")

# Eyes sit on the sides of a bull's head, angled forward, under the brow.
eyes = []
for sx in (-1, 1):
    eye = part((0.6 * sx, -0.52, 0.28), (0.13, 0.13, 0.11), EYE, name=f"eye{sx}")
    lid = part((0.62 * sx, -0.5, 0.33), (0.17, 0.12, 0.08), LID, rot=(math.radians(-8), 0, math.radians(25 * sx)), name=f"lid{sx}")
    eyes.append((eye, lid))

# Ears: cupped leaves pointing out-and-down below the horns.
ears = []
for sx in (-1, 1):
    ear = part((1.0 * sx, 0.2, 0.32), (0.42, 0.12, 0.2), HIDE, rot=(0, math.radians(-28 * sx), math.radians(10 * sx)), name=f"ear{sx}")
    part((1.02 * sx, 0.12, 0.31), (0.3, 0.04, 0.12), INNER, rot=(0, math.radians(-28 * sx), math.radians(10 * sx)), name=f"earin{sx}")
    ears.append(ear)

# Horns: thick at the base, sweeping out, forward, then up - a real bull's arc.
for sx in (-1, 1):
    curve = bpy.data.curves.new(f"horn{sx}", "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = 0.19
    curve.bevel_resolution = 10
    curve.use_fill_caps = True
    spl = curve.splines.new("BEZIER")
    pts = [(0.5, 0.15, 0.72), (1.05, 0.05, 0.85), (1.5, -0.2, 1.05), (1.62, -0.42, 1.48)]
    radii = [1.0, 0.82, 0.55, 0.12]
    spl.bezier_points.add(len(pts) - 1)
    for bp, (x, y, z), r in zip(spl.bezier_points, pts, radii):
        bp.co = (x * sx, y, z)
        bp.handle_left_type = bp.handle_right_type = "AUTO"
        bp.radius = r
    obj = bpy.data.objects.new(f"horn{sx}", curve)
    scene.collection.objects.link(obj)
    obj.data.materials.append(HORN)

# Gold ring through the septum.
bpy.ops.mesh.primitive_torus_add(major_radius=0.17, minor_radius=0.032, location=(0, -1.74, -0.42), rotation=(math.radians(90), 0, 0))
bpy.context.active_object.data.materials.append(GOLD)
bpy.ops.object.shade_smooth()

# ---------------------------------------------------------------- camera & light
bpy.ops.object.camera_add(location=(2.6, -7.2, 1.35), rotation=(math.radians(82), 0, math.radians(20)))
cam = bpy.context.active_object
cam.data.lens = 85
scene.camera = cam


def light(kind, loc, energy, rot, size=3.0, color="#FFFFFF"):
    bpy.ops.object.light_add(type=kind, location=loc, rotation=rot)
    l = bpy.context.active_object
    l.data.energy = energy
    l.data.color = hexc(color)[:3]
    if kind == "AREA":
        l.data.size = size
    return l


light("AREA", (-4.0, -5.0, 4.5), 1400, (math.radians(50), 0, math.radians(-38)), 4.0, "#FFE6C7")   # warm key
light("AREA", (5.0, -3.0, 0.5), 300, (math.radians(80), 0, math.radians(55)), 6.0, "#C9D8FF")      # cool fill
light("AREA", (1.5, 5.5, 3.5), 2200, (math.radians(-50), 0, math.radians(165)), 3.0, "#BFD4FF")    # rim
light("AREA", (-3.5, 4.0, 2.0), 1200, (math.radians(-60), 0, math.radians(-140)), 2.5, "#FFD9A8") # warm kicker
world = bpy.data.worlds.new("w")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.12, 0.12, 0.14, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.5

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
scene.view_settings.view_transform = "AgX" if "AgX" in [i.identifier for i in scene.view_settings.bl_rna.properties["view_transform"].enum_items] else "Filmic"
scene.view_settings.look = "None"

# Frame the whole head + horns.
bpy.ops.object.select_all(action="SELECT")
cam.select_set(False)
bpy.ops.view3d.camera_to_view_selected() if False else None
cam.data.lens = 70

if MODE == "still":
    scene.render.filepath = os.path.join(OUT, "ox-real.png")
    bpy.ops.render.render(write_still=True)
else:
    # Idle loop, 48 frames @ 24 fps: breathing, an ear flick, one blink.
    scene.frame_start, scene.frame_end = 1, 48
    root = bpy.data.objects.new("root", None)
    scene.collection.objects.link(root)
    for o in list(scene.objects):
        if o.type in ("MESH", "CURVE") and o.parent is None:
            o.parent = root
    for f in range(1, 49):
        ph = (f - 1) / 48 * 2 * math.pi
        root.location = (0, 0, 0.025 * math.sin(ph))
        root.rotation_euler = (math.radians(1.2 * math.sin(ph)), 0, math.radians(1.5 * math.sin(ph * 0.5)))
        root.keyframe_insert("location", frame=f)
        root.keyframe_insert("rotation_euler", frame=f)
        for i, ear in enumerate(ears):
            sx = -1 if i == 0 else 1
            flick = math.exp(-((f - 30) ** 2) / 6) * 22 if i == 1 else 0
            ear.rotation_euler = (0, math.radians(-28 * sx), math.radians(10 * sx + flick))
            ear.keyframe_insert("rotation_euler", frame=f)
        close = 1.0 if f in (40, 41) else (0.5 if f in (39, 42) else 0.0)
        for eye, lid in eyes:
            lid.scale = (0.17, 0.12, 0.08 + 0.1 * close)
            lid.location.z = 0.33 - 0.06 * close
            lid.keyframe_insert("scale", frame=f)
            lid.keyframe_insert("location", frame=f)
    scene.render.filepath = os.path.join(OUT, "idle_")
    bpy.ops.render.render(animation=True)
print("OX_REAL_DONE", OUT, MODE)
