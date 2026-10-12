# Blender script: render OX Island's pasture cast from Quaternius' rigged,
# CC0 models - real skinned animation instead of a hand rig.
#   bull:   poly.pizza/m/a8PIIYwF7r (Bull)
#   farmer: poly.pizza/m/c3Ibh9I3udk (Animated Human, its own textures)
#
#   Blender -b -P bull_render.py -- <model.glb> <out_dir> [mode] [width] [bull|farmer]
#   mode: still | all | one cycle name (see PROFILES)
#
# All cycles share one side camera fitted to the union of every pose, so the
# island can swap cycles without the ox jumping. Frames:
# <out_dir>/<cycle>/<cycle>_0001.png ...

import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB = os.path.abspath(argv[0])
OUT = os.path.abspath(argv[1] if len(argv) > 1 else ".")
MODE = argv[2] if len(argv) > 2 else "still"
WIDTH = int(argv[3]) if len(argv) > 3 else 288
PROFILE = argv[4] if len(argv) > 4 else ("bull" if "bull" in os.path.basename(GLB).lower() else "farmer")
os.makedirs(OUT, exist_ok=True)

# cycle -> (action, frames to render). The bull's cycles drive the island's
# moods and its pasture routine (art/CHARACTERS.md); the farmer only visits.
PROFILES = {
    "bull": {
        "aspect": (4, 3),
        "still": "Idle",
        "cycles": {
            "walk": ("Walk", 24),
            "graze": ("Eating", 48),
            "alert": ("Attack_Headbutt", 24),
            "idle": ("Idle", 40),
            "look": ("Idle_2", 40),
            "gallop": ("Gallop", 14),
            "kick": ("Attack_Kick", 24),
        },
        # Graphite hide, warm belly, brand-gold horns.
        "look": {
            "Main": ("#2E2F35", 0.55, 0.0),
            "Main_Light": ("#6B5A4A", 0.6, 0.0),
            "Muzzle": ("#C79A76", 0.45, 0.0),
            "Hooves": ("#17171A", 0.35, 0.0),
            "Horns": ("#E9C27B", 0.25, 0.35),
            "Eye_Black": ("#050506", 0.08, 0.0),
            "Eye_White": ("#F4EFE6", 0.2, 0.0),
        },
    },
    "farmer": {
        "aspect": (3, 4),
        "still": "Idle",
        "cycles": {
            "walk": ("Walk", 24),
            # The model has no wave; a cheerful hop is its hello to the bull.
            "wave": ("Jump", 24),
            "idle": ("Idle", 32),
        },
        "look": {},  # keep the model's own textured clothes
    },
}
CFG = PROFILES[PROFILE]
CYCLES = CFG["cycles"]
HEIGHT = WIDTH * CFG["aspect"][1] // CFG["aspect"][0]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
# guess_original_bind_pose re-derives the bind pose from the first frame and
# skews the IK-driven hind legs of Quaternius rigs; trust the file's own.
bpy.ops.import_scene.gltf(filepath=GLB, guess_original_bind_pose=False)

arm = next(o for o in scene.objects if o.type == "ARMATURE")
# The importer stacks every animation as an NLA track; left on, they all blend
# over the active action (Death + Gallop + ...) and fold the legs. Mute them.
if arm.animation_data:
    for t in arm.animation_data.nla_tracks:
        t.mute = True
# Only the character renders: meshes skinned to the rig or parented to it
# (some models hang the head on a bone). The bull file also carries a stray
# helper sphere, which is neither.
def on_rig(o):
    if any(m.type == "ARMATURE" for m in o.modifiers):
        return True
    p = o.parent
    while p is not None:
        if p == arm:
            return True
        p = p.parent
    return False


meshes = [o for o in scene.objects if o.type == "MESH" and on_rig(o)]
for o in scene.objects:
    if o.type == "MESH" and o not in meshes:
        o.hide_render = True
        o.hide_viewport = True


def hexc(h):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb] + [1.0]


LOOK = CFG["look"]
for m in bpy.data.materials:
    spec = LOOK.get(m.name.split(".")[0])
    if not spec or not m.use_nodes:
        continue
    bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if not bsdf:
        continue
    for link in list(bsdf.inputs["Base Color"].links):
        m.node_tree.links.remove(link)
    color, rough, metal = spec
    bsdf.inputs["Base Color"].default_value = hexc(color)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if "Coat Weight" in bsdf.inputs and m.name.startswith("Main"):
        bsdf.inputs["Coat Weight"].default_value = 0.15  # a little sheen on the hide


def action(name):
    # Prefer the armature's own action ("AnimalArmature|Walk"); the bare-named
    # copies in the file are not bound to the rig and fold the legs.
    for a in sorted(bpy.data.actions, key=lambda a: "|" not in a.name):
        if a.name == name or a.name.endswith("|" + name):
            return a
    raise SystemExit(f"no action {name}: {[a.name for a in bpy.data.actions]}")


def reset_pose():
    # Actions only key the bones they animate. Eating and Idle leave the
    # hind-leg IK bones unkeyed, so without this they keep whatever pose the
    # previous action left and the legs fold.
    for b in arm.pose.bones:
        b.location = (0, 0, 0)
        b.rotation_quaternion = (1, 0, 0, 0)
        b.rotation_euler = (0, 0, 0)
        b.scale = (1, 1, 1)


def use_action(name):
    a = action(name)
    reset_pose()
    arm.animation_data_create()
    arm.animation_data.action = a
    if hasattr(arm.animation_data, "action_slot") and a.slots:
        arm.animation_data.action_slot = a.slots[0]
    return a


# ---- side camera (ortho) on the bull's left, so it faces screen-right like OxWalker expects.
bpy.ops.object.camera_add(location=(-12, 0, 1.2), rotation=(math.radians(90), 0, math.radians(-90)))
cam = bpy.context.active_object
cam.data.type = "ORTHO"
scene.camera = cam


def sample_points(frames_per_cycle=4):
    """Every deformed vertex in camera space, across all cycles."""
    inv = cam.matrix_world.inverted()
    xs, ys = [], []
    for act, n in CYCLES.values():
        a = use_action(act)
        f0, f1 = a.frame_range
        for i in range(frames_per_cycle):
            scene.frame_set(int(f0 + (f1 - f0) * i / max(1, frames_per_cycle - 1)))
            dg = bpy.context.evaluated_depsgraph_get()
            for o in meshes:
                ev = o.evaluated_get(dg)
                me = ev.to_mesh()
                verts = me.vertices
                for vi in range(0, len(verts), 7):
                    p = inv @ (ev.matrix_world @ verts[vi].co)
                    xs.append(p.x)
                    ys.append(p.y)
                ev.to_mesh_clear()
    return xs, ys


def autoframe(margin=1.06, extra_bottom_frac=0.06):
    xs, ys = sample_points()
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    eb = h * extra_bottom_frac
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2 - eb / 2
    cam.data.ortho_scale = max(w, (h + eb) * WIDTH / HEIGHT) * margin
    cam.location = cam.matrix_world @ Vector((cx, cy, 0))
    return min(ys)


def light(loc, energy, rot, size, color):
    bpy.ops.object.light_add(type="AREA", location=loc, rotation=rot)
    l = bpy.context.active_object
    l.data.energy = energy
    l.data.size = size
    l.data.color = hexc(color)[:3]


# Bounds are in metres of the imported model; scale lights to its size.
dims = max(arm.dimensions) or 1.0
S = max(1.0, dims / 2.0)
light((-6 * S, -5 * S, 6 * S), 900 * S * S, (math.radians(45), 0, math.radians(-50)), 5 * S, "#FFE6C7")  # warm key
light((-6 * S, 6 * S, 2 * S), 300 * S * S, (math.radians(75), 0, math.radians(-135)), 6 * S, "#C9D8FF")  # cool fill
light((6 * S, 0, 5 * S), 1400 * S * S, (math.radians(-55), 0, math.radians(90)), 4 * S, "#BFD4FF")  # rim

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
scene.render.resolution_y = HEIGHT
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
try:
    scene.view_settings.view_transform = "AgX"
except TypeError:
    scene.view_settings.view_transform = "Filmic"
if hasattr(scene, "eevee"):
    scene.eevee.taa_render_samples = 32

autoframe()


def render_cycle(name):
    act, n = CYCLES[name]
    a = use_action(act)
    f0, f1 = a.frame_range
    d = os.path.join(OUT, name)
    os.makedirs(d, exist_ok=True)
    for f in os.listdir(d):
        if f.endswith(".png"):
            os.remove(os.path.join(d, f))
    # Resample the action's own loop to n evenly spaced frames (last == first is skipped).
    for i in range(n):
        t = f0 + (f1 - f0) * i / n
        scene.frame_set(int(t), subframe=t - int(t))
        scene.render.filepath = os.path.join(d, f"{name}_{i + 1:04d}.png")
        bpy.ops.render.render(write_still=True)
    print("OX_CYCLE_DONE", name, n, act, (f0, f1))


if MODE == "still":
    use_action(CFG["still"])
    scene.frame_set(1)
    scene.render.filepath = os.path.join(OUT, f"{PROFILE}-still.png")
    bpy.ops.render.render(write_still=True)
else:
    for name in (CYCLES if MODE == "all" else [MODE]):
        render_cycle(name)
print("OX_RENDER_DONE", PROFILE, OUT, MODE)
