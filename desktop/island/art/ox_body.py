# Blender script: the full-body OX for OX Island - a realistic graphite ox that
# walks while work runs, grazes while it waits for you, stamps when it needs an
# approval, and lies down when nothing is running.
#
#   Blender -b -P ox_body.py -- <out_dir> <mode> [width]
#   mode: still | walk | graze | alert | sleep | all
#
# Every mode renders from the same side camera so the island can swap cycles
# without the ox jumping. Frames: <out_dir>/<cycle>/<cycle>_0001.png ...

import math
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else ".")
MODE = argv[1] if len(argv) > 1 else "still"
WIDTH = int(argv[2]) if len(argv) > 2 else 480
HEIGHT = WIDTH * 3 // 4
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


def hide_material():
    m, p = principled("hide", "#1B1C20", 0.6, sheen=0.3)
    nt = m.node_tree
    fine = nt.nodes.new("ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = 140.0
    fine.inputs["Detail"].default_value = 8.0
    broad = nt.nodes.new("ShaderNodeTexNoise")
    broad.inputs["Scale"].default_value = 9.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.15
    nt.links.new(fine.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], p.inputs["Normal"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = hexc("#141518")
    ramp.color_ramp.elements[1].color = hexc("#272A30")
    nt.links.new(broad.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], p.inputs["Base Color"])
    return m


def horn_material():
    m, p = principled("horn", "#E8DCC4", 0.28, coat=0.6)
    nt = m.node_tree
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])
    a = nt.nodes.new("ShaderNodeMath")
    a.operation = "ABSOLUTE"
    nt.links.new(sep.outputs["X"], a.inputs[0])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.4
    mr.inputs["From Max"].default_value = 1.9
    nt.links.new(a.outputs["Value"], mr.inputs["Value"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = hexc("#E8DCC4")
    ramp.color_ramp.elements[1].position = 0.95
    ramp.color_ramp.elements[1].color = hexc("#2A2420")
    nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], p.inputs["Base Color"])
    return m


HIDE = hide_material()
HORN = horn_material()
NOSE = principled("nose", "#121214", 0.12, coat=1.0)[0]
EYE = principled("eye", "#1A0F0A", 0.03, coat=1.0)[0]
HOOF = principled("hoof", "#141416", 0.35, coat=0.4)[0]
GOLD = principled("gold", "#F2C14E", 0.16, metal=1.0)[0]
INNER = principled("ear_inner", "#5A4A48", 0.7)[0]
TUFT = principled("tuft", "#141518", 0.8)[0]


def blob(loc, scale, rot=(0, 0, 0), mat=None, name="blob", segs=40):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=segs // 2, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    if mat:
        o.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return o


def fuse(objs, name, voxel=0.04, smooth_iters=20):
    """Fuse ellipsoid volumes into ONE smooth organic surface with metaballs.

    Takes the blob objects (for their location/scale/rotation), deletes them,
    builds a metaball with one ellipsoid per blob, and converts it to a mesh.
    Metaballs blend volumes the way muscle and skin do - no creases at joins.
    """
    mb = bpy.data.metaballs.new(name + "_mb")
    mb.resolution = mb.render_resolution = voxel
    mb.threshold = 0.5
    mobj = bpy.data.objects.new(name, mb)
    scene.collection.objects.link(mobj)
    for o in objs:
        el = mb.elements.new()
        el.type = "ELLIPSOID"
        el.co = o.location
        el.radius = 1.45  # metaball iso-surface sits inside the radius; this matches the blob size
        el.size_x, el.size_y, el.size_z = (s * 1.0 for s in o.scale)
        el.rotation = o.rotation_euler.to_quaternion()
        el.stiffness = 2.0
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT")
    mobj.select_set(True)
    bpy.context.view_layer.objects.active = mobj
    bpy.context.view_layer.update()
    bpy.ops.object.convert(target="MESH")
    o = bpy.context.active_object
    o.name = name
    sm = o.modifiers.new("smooth", "CORRECTIVE_SMOOTH")
    sm.factor = 0.6
    sm.iterations = 6
    bpy.ops.object.modifier_apply(modifier="smooth")
    o.data.materials.clear()
    o.data.materials.append(HIDE)
    bpy.ops.object.shade_smooth()
    return o


def empty(name, loc, parent=None):
    e = bpy.data.objects.new(name, None)
    scene.collection.objects.link(e)
    e.location = loc
    if parent:
        e.parent = parent
    return e


def parent_keep(child, parent):
    bpy.context.view_layer.update()  # matrix_world is stale until the depsgraph runs
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_world = mw


# ---------------------------------------------------------------- rig roots
# The ox faces +X (walks right). Ground is z = 0.
root = empty("root", (0, 0, 0))
body_pivot = empty("body", (0, 0, 0), root)

# ---------------------------------------------------------------- barrel
barrel = fuse([
    blob((0.85, 0, 1.80), (0.72, 0.58, 0.66)),     # chest
    blob((0.0, 0, 1.70), (1.05, 0.56, 0.55)),      # belly
    blob((-0.95, 0, 1.85), (0.66, 0.56, 0.6)),      # hindquarters
    blob((0.65, 0, 2.30), (0.5, 0.42, 0.32)),      # hump / withers
    blob((-0.2, 0, 2.17), (0.9, 0.46, 0.28)),      # back line
    blob((1.2, 0, 1.45), (0.3, 0.16, 0.34)),        # dewlap
    blob((0.85, 0, 1.25), (0.32, 0.36, 0.3)),       # shoulder into foreleg
    blob((-0.95, 0, 1.33), (0.34, 0.36, 0.32)),    # thigh into hind leg
], "barrel")
parent_keep(barrel, body_pivot)

# ---------------------------------------------------------------- neck + head (pivots down to graze)
neck_pivot = empty("neck", (1.25, 0, 2.1), body_pivot)


def build_head():
    """Head built facing -Y at the origin (same proportions as ox_real.py)."""
    parts = []
    skull = fuse([
        blob((0, 0.1, 0.35), (0.86, 0.95, 0.72)),
        blob((0, 0.05, 0.78), (0.72, 0.45, 0.3)),
        blob((0, -0.55, 0.18), (0.62, 0.8, 0.55)),
        blob((0, -1.15, -0.25), (0.6, 0.55, 0.5)),
        blob((0, -1.0, -0.6), (0.5, 0.55, 0.28)),
        blob((0.5, -0.35, 0.42), (0.3, 0.32, 0.22)),
        blob((-0.5, -0.35, 0.42), (0.3, 0.32, 0.22)),
        blob((0.55, -0.05, -0.1), (0.38, 0.55, 0.45)),
        blob((-0.55, -0.05, -0.1), (0.38, 0.55, 0.45)),
    ], "skull", voxel=0.035, smooth_iters=25)
    parts.append(skull)
    parts.append(blob((0, -1.62, -0.18), (0.42, 0.12, 0.3), mat=NOSE, name="nosepad"))
    for sx in (-1, 1):
        parts.append(blob((0.2 * sx, -1.72, -0.2), (0.08, 0.05, 0.12), mat=principled(f"nostril{sx}", "#050505", 0.4)[0], name="nostril"))
        parts.append(blob((0.6 * sx, -0.52, 0.28), (0.13, 0.13, 0.11), mat=EYE, name=f"eye{sx}"))
        parts.append(blob((0.62 * sx, -0.5, 0.36), (0.17, 0.12, 0.07), mat=HIDE, rot=(math.radians(-8), 0, math.radians(25 * sx)), name=f"lid{sx}"))
    ears = []
    for sx in (-1, 1):
        ear = blob((1.0 * sx, 0.2, 0.32), (0.42, 0.12, 0.2), mat=HIDE, rot=(0, math.radians(-28 * sx), math.radians(10 * sx)), name=f"ear{sx}")
        parts.append(ear)
        ears.append(ear)
        parts.append(blob((1.02 * sx, 0.12, 0.31), (0.3, 0.04, 0.12), mat=INNER, rot=(0, math.radians(-28 * sx), math.radians(10 * sx)), name=f"earin{sx}"))
    for sx in (-1, 1):
        curve = bpy.data.curves.new(f"horn{sx}", "CURVE")
        curve.dimensions = "3D"
        curve.bevel_depth = 0.19
        curve.bevel_resolution = 10
        curve.use_fill_caps = True
        spl = curve.splines.new("BEZIER")
        pts = [(0.5, 0.15, 0.72), (1.05, 0.05, 0.85), (1.5, -0.2, 1.05), (1.62, -0.42, 1.48)]
        spl.bezier_points.add(len(pts) - 1)
        for bp, (x, y, z), r in zip(spl.bezier_points, pts, [1.0, 0.82, 0.55, 0.12]):
            bp.co = (x * sx, y, z)
            bp.handle_left_type = bp.handle_right_type = "AUTO"
            bp.radius = r
        horn = bpy.data.objects.new(f"horn{sx}", curve)
        scene.collection.objects.link(horn)
        horn.data.materials.append(HORN)
        parts.append(horn)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.17, minor_radius=0.032, location=(0, -1.74, -0.42), rotation=(math.radians(90), 0, 0))
    ring = bpy.context.active_object
    ring.data.materials.append(GOLD)
    bpy.ops.object.shade_smooth()
    parts.append(ring)
    return parts, ears


head_pivot = empty("head", (0, 0, 0))
head_parts, ears = build_head()
for p in head_parts:
    parent_keep(p, head_pivot)
# Turn the -Y-facing head to face +X, scale to the body, hang it off the neck.
head_pivot.rotation_euler = (0, 0, math.radians(90))
head_pivot.scale = (0.6, 0.6, 0.6)
head_pivot.location = (0.85, 0, 0.25)  # relative to the neck pivot
head_pivot.parent = neck_pivot

neck = fuse([
    blob((0.0, 0, 0.0), (0.55, 0.42, 0.5)),
    blob((0.45, 0, 0.12), (0.45, 0.36, 0.42)),
    blob((0.75, 0, 0.2), (0.35, 0.3, 0.36)),
], "neckmesh")
neck.location = (1.25, 0, 2.1)
neck.parent = None
parent_keep(neck, neck_pivot)

# ---------------------------------------------------------------- legs
legs = {}


def leg(name, x, y):
    hip = empty(f"{name}_hip", (x, y, 1.45), body_pivot)
    upper = blob((x, y, 1.05), (0.19, 0.17, 0.5), mat=HIDE, name=f"{name}_upper")
    parent_keep(upper, hip)
    knee = empty(f"{name}_knee", (0, 0, -0.85), hip)
    lower = blob((x, y, 0.33), (0.1, 0.1, 0.36), mat=HIDE, name=f"{name}_lower")
    parent_keep(lower, knee)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.11, depth=0.12, location=(x + 0.02, y, 0.06))
    hoof = bpy.context.active_object
    hoof.data.materials.append(HOOF)
    parent_keep(hoof, knee)
    legs[name] = (hip, knee)


leg("lf", 0.85, -0.3)
leg("rf", 0.85, 0.3)
leg("lh", -0.95, -0.3)
leg("rh", -0.95, 0.3)

# Tail: a rope with a dark tuft, swinging from the rump.
tail_pivot = empty("tail", (-1.58, 0, 2.1), body_pivot)
tc = bpy.data.curves.new("tailc", "CURVE")
tc.dimensions = "3D"
tc.bevel_depth = 0.04
tc.use_fill_caps = True
spl = tc.splines.new("BEZIER")
spl.bezier_points.add(2)
for bp, co, r in zip(spl.bezier_points, [(0, 0, 0), (-0.12, 0, -0.45), (-0.08, 0, -0.95)], [1.4, 1.0, 0.7]):
    bp.co = co
    bp.handle_left_type = bp.handle_right_type = "AUTO"
    bp.radius = r
tail = bpy.data.objects.new("tailobj", tc)
scene.collection.objects.link(tail)
tail.data.materials.append(HIDE)
tail.parent = tail_pivot
tuft = blob((-1.66, 0, 1.1), (0.08, 0.08, 0.16), mat=TUFT, name="tuft")
parent_keep(tuft, tail_pivot)

# Grass tuft for grazing (hidden in other cycles).
grass = []
GRASS = principled("grass", "#4E8A3A", 0.6)[0]
for i in range(14):
    a = i / 14 * math.tau
    bpy.ops.mesh.primitive_cone_add(radius1=0.03, depth=0.32 + 0.12 * math.sin(i * 2.3), location=(2.25 + 0.14 * math.cos(a), 0.12 * math.sin(a), 0.15),
                                    rotation=(0.25 * math.sin(a * 3), 0.3 * math.cos(a * 2), 0))
    g = bpy.context.active_object
    g.data.materials.append(GRASS)
    grass.append(g)

# ---------------------------------------------------------------- camera & lights
bpy.ops.object.camera_add(location=(0.75, -9.5, 1.45), rotation=(math.radians(90), 0, math.radians(6)))
cam = bpy.context.active_object
cam.data.type = "ORTHO"
cam.data.ortho_scale = 6.2
scene.camera = cam


def autoframe(margin=1.12, extra_bottom=0.35):
    """Fit the ortho camera to every visible part, in camera space.

    extra_bottom leaves room under the hooves for the island's ground shadow
    and for the lying-down pose. Done once, on the neutral pose, so all cycles
    share one frame and the ox never jumps when the island switches cycles.
    """
    from mathutils import Vector
    bpy.context.view_layer.update()
    inv = cam.matrix_world.inverted()
    xs, ys = [], []
    for o in scene.objects:
        if o.type not in ("MESH", "CURVE") or o.hide_render:
            continue
        for corner in o.bound_box:
            p = inv @ (o.matrix_world @ Vector(corner))
            xs.append(p.x)
            ys.append(p.y)
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2 - extra_bottom / 2
    w = max(xs) - min(xs)
    h = max(ys) - min(ys) + extra_bottom
    aspect = WIDTH / HEIGHT
    cam.data.ortho_scale = max(w, h * aspect) * margin
    cam.location = cam.matrix_world @ Vector((cx, cy, 0))


def light(loc, energy, rot, size, color):
    bpy.ops.object.light_add(type="AREA", location=loc, rotation=rot)
    l = bpy.context.active_object
    l.data.energy = energy
    l.data.size = size
    l.data.color = hexc(color)[:3]


light((-3.5, -6.0, 5.5), 1800, (math.radians(45), 0, math.radians(-30)), 5.0, "#FFE6C7")
light((5.5, -4.0, 1.5), 450, (math.radians(80), 0, math.radians(55)), 6.0, "#C9D8FF")
light((0.5, 6.5, 4.0), 2600, (math.radians(-50), 0, math.radians(180)), 4.0, "#BFD4FF")
world = bpy.data.worlds.new("w")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.1, 0.1, 0.12, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.5

for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
scene.render.film_transparent = True
scene.render.resolution_x = WIDTH
scene.render.resolution_y = HEIGHT
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
try:
    scene.view_settings.view_transform = "AgX"
except TypeError:
    scene.view_settings.view_transform = "Filmic"
if hasattr(scene, "eevee"):
    scene.eevee.taa_render_samples = 32

# ---------------------------------------------------------------- animation
def key(obj, attr, frame):
    obj.keyframe_insert(attr, frame=frame)


def set_grass(visible):
    for g in grass:
        g.hide_render = not visible


def pose_neutral():
    for name, (hip, knee) in legs.items():
        hip.rotation_euler = (0, 0, 0)
        knee.rotation_euler = (0, 0, 0)
    neck_pivot.rotation_euler = (0, 0, 0)
    body_pivot.location = (0, 0, 0)
    body_pivot.rotation_euler = (0, 0, 0)
    tail_pivot.rotation_euler = (0, 0, 0)


def key_all(f):
    for hip, knee in legs.values():
        key(hip, "rotation_euler", f)
        key(knee, "rotation_euler", f)
    for o in (neck_pivot, tail_pivot, body_pivot):
        key(o, "rotation_euler", f)
    key(body_pivot, "location", f)
    for e in ears:
        key(e, "rotation_euler", f)


def walk(frames=24):
    # Diagonal pairs move together (LF+RH, RF+LH): the bovine walk.
    phase = {"lf": 0.0, "rh": 0.0, "rf": math.pi, "lh": math.pi}
    for f in range(1, frames + 1):
        t = (f - 1) / frames * math.tau
        for name, (hip, knee) in legs.items():
            s = math.sin(t + phase[name])
            hip.rotation_euler = (0, math.radians(24 * s), 0)
            # The knee folds while the leg swings forward, straight under load.
            knee.rotation_euler = (0, math.radians(-38 * max(0.0, math.cos(t + phase[name]))), 0)
        body_pivot.location = (0, 0, 0.05 * abs(math.sin(t)))
        neck_pivot.rotation_euler = (0, math.radians(6 + 4 * math.sin(2 * t)), 0)
        tail_pivot.rotation_euler = (math.radians(14 * math.sin(t)), 0, 0)
        key_all(f)


def graze(frames=48):
    for f in range(1, frames + 1):
        t = (f - 1) / frames * math.tau
        pose_neutral()
        # Head down to the grass, nodding while it chews.
        neck_pivot.rotation_euler = (0, math.radians(58 + 4 * math.sin(4 * t)), 0)
        body_pivot.location = (0, 0, 0.012 * math.sin(t))
        tail_pivot.rotation_euler = (math.radians(20 * math.sin(t + 1)), 0, 0)
        flick = 25 * math.exp(-((f - 30) ** 2) / 5)
        for i, e in enumerate(ears):
            sx = -1 if i == 0 else 1
            e.rotation_euler = (0, math.radians(-28 * sx), math.radians(10 * sx + (flick if i == 1 else 0)))
        key_all(f)


def alert(frames=24):
    for f in range(1, frames + 1):
        t = (f - 1) / frames * math.tau
        pose_neutral()
        neck_pivot.rotation_euler = (0, math.radians(-12), 0)          # head up
        # One front hoof stamps twice per cycle.
        lift = max(0.0, math.sin(2 * t))
        legs["lf"][0].rotation_euler = (0, math.radians(-20 * lift), 0)
        legs["lf"][1].rotation_euler = (0, math.radians(70 * lift), 0)  # knee folds back: hoof goes behind
        body_pivot.rotation_euler = (0, math.radians(-2 * lift), 0)
        tail_pivot.rotation_euler = (math.radians(30 * math.sin(3 * t)), 0, 0)
        for i, e in enumerate(ears):
            sx = -1 if i == 0 else 1
            e.rotation_euler = (0, math.radians(-10 * sx), math.radians(25 * sx))  # ears forward
        key_all(f)


def sleep(frames=48):
    for f in range(1, frames + 1):
        t = (f - 1) / frames * math.tau
        pose_neutral()
        # Lying down: body lowered, legs folded under, head resting forward.
        body_pivot.location = (0, 0, -0.62 + 0.02 * math.sin(t))
        for name, (hip, knee) in legs.items():
            front = name.endswith("f")
            hip.rotation_euler = (0, math.radians(-70 if front else 75), 0)
            knee.rotation_euler = (0, math.radians(140 if front else -140), 0)
        neck_pivot.rotation_euler = (0, math.radians(22 + 1.5 * math.sin(t)), 0)
        tail_pivot.rotation_euler = (math.radians(-40), 0, 0)
        key_all(f)


def render_cycle(name, builder, frames):
    for o in (*[h for h, _ in legs.values()], *[k for _, k in legs.values()], neck_pivot, tail_pivot, body_pivot, *ears):
        o.animation_data_clear()
    pose_neutral()
    set_grass(name == "graze")
    builder(frames)
    scene.frame_start, scene.frame_end = 1, frames
    d = os.path.join(OUT, name)
    os.makedirs(d, exist_ok=True)
    scene.render.filepath = os.path.join(d, f"{name}_")
    bpy.ops.render.render(animation=True)
    print("OX_CYCLE_DONE", name, frames)


set_grass(False)
pose_neutral()
autoframe()
set_grass(True)  # grass is part of the graze cycle; frame was fitted without it

if MODE == "still":
    set_grass(False)
    pose_neutral()
    scene.render.filepath = os.path.join(OUT, "ox-body-still.png")
    bpy.ops.render.render(write_still=True)
else:
    plan = {"walk": (walk, 24), "graze": (graze, 48), "alert": (alert, 24), "sleep": (sleep, 48)}
    for name in (plan if MODE == "all" else [MODE]):
        fn, n = plan[name]
        render_cycle(name, fn, n)
print("OX_BODY_DONE", OUT, MODE)
