# Blender script (OX Island's ox, new look: art/ox_cute_render.py): render OX Island's pasture cast from Quaternius' rigged,
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
import bmesh
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
            # cycle: (action, frames, eyes, brows)
            "walk": ("Walk", 24, "open", "calm"),
            "graze": ("Eating", 48, "content", "calm"),
            "idle": ("Idle", 40, "blink", "calm"),
            "look": ("Idle_2", 40, "blink", "calm"),
            "gallop": ("Gallop", 14, "focused", "focused"),
            "alert": ("Jump_toIdle", 24, "wide", "up"),
            "kick": ("Idle_HitReact_Left", 24, "wide", "up"),
            "doze": ("Idle_Headlow", 40, "closed", "calm"),
            "happy": ("Gallop_Jump", 24, "happy", "up"),
            "think": ("Idle_2", 40, "lookup", "think"),
            "worried": ("Idle_Headlow", 40, "open", "worried"),
            "dizzy": ("Idle_Headlow", 40, "x", "worried"),
            # Family life on the pasture: drinking at the trough, head-butting a friend in play.
            "drink": ("Idle_Headlow", 40, "content", "calm"),
            "play": ("Attack_Headbutt", 28, "happy", "up"),
        },
        # The concept (docs/ISLAND_VS.md): cream coat with charcoal patches,
        # pink muzzle, amber horns, charcoal hooves; the model's own small eyes
        # are painted over by the cartoon eyes added below.
        "look": {
            "Main": ("#F4EFE6", 0.6, 0.0),
            "Main_Light": ("#FBF8F2", 0.65, 0.0),
            "Muzzle": ("#F2B2A8", 0.5, 0.0),
            "Hooves": ("#3A3A40", 0.4, 0.0),
            "Horns": ("#E9A66B", 0.3, 0.1),
            "Eye_Black": ("#F4EFE6", 0.6, 0.0),
            "Eye_White": ("#F4EFE6", 0.6, 0.0),
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


# OX_OWN_LOOK=1: keep the model's own coat (a horse, deer or fox as it is), cartoon face still added.
OWN_LOOK = os.environ.get("OX_OWN_LOOK") == "1"
LOOK = {} if OWN_LOOK else CFG["look"]
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
    # Same rig, slightly different names on some models (the fox: Idle_2_HeadLow, Jump_ToIdle, Attack).
    alias = {"Idle_Headlow": ["Idle_2_HeadLow", "Idle_HeadLow"], "Jump_toIdle": ["Jump_ToIdle"], "Attack_Headbutt": ["Attack"], "Idle_HitReact_Left": ["Idle_HitReact_Right"]}
    for alt in alias.get(name, []):
        for a in sorted(bpy.data.actions, key=lambda a: "|" not in a.name):
            if a.name.lower() == alt.lower() or a.name.lower().endswith("|" + alt.lower()):
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
    for act, n, *_ in CYCLES.values():
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
scene.render.film_transparent = os.environ.get("OX_REVIEW") != "1"
if os.environ.get("OX_REVIEW") == "1":
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.008, 0.008, 0.01, 1)
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

# A bigger head reads as friendlier at notch size (the face is what you see).
HEAD = float(os.environ.get("OX_HEAD", "1.3"))
def _big_head(scene, *_):
    pb = arm.pose.bones.get("Head")
    if pb:
        pb.scale = (HEAD, HEAD, HEAD)
bpy.app.handlers.frame_change_post.append(_big_head)

# ---- the cartoon face, on the Head bone ---------------------------------------
import bmesh
from mathutils import Matrix

AZ = float(os.environ.get("OX_AZ", "32"))      # degrees toward the front: both eyes read
EYE = {k: float(v) for k, v in (kv.split("=") for kv in os.environ.get("OX_EYE", "").split(",") if "=" in kv)}

def mat(name, color, rough=0.35, emit=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = hexc(color)
    b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission Color"].default_value = hexc(color)
        b.inputs["Emission Strength"].default_value = emit
    return m

M_WHITE, M_INK, M_SHINE = mat("EyeWhite2", "#FFFFFF", 0.25), mat("EyeInk", "#16161A", 0.2), mat("Shine", "#FFFFFF", 0.1, 2.0)
M_BROW, M_BLUSH = mat("Brow", "#3A3A40", 0.6), mat("Blush", "#F29B8F", 0.7)

# Charcoal patches on the coat (object space noise, so they stay put as it moves).
for m in bpy.data.materials:
    if OWN_LOOK or m.name.split(".")[0] != "Main" or not m.use_nodes:
        continue
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = float(os.environ.get("OX_PATCH_SCALE", "2.2"))
    nz.inputs["Detail"].default_value = 1.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = hexc("#F4EFE6")
    ramp.color_ramp.elements[1].position = float(os.environ.get("OX_PATCH", "0.62"))
    ramp.color_ramp.elements[1].color = hexc("#3A3A40")
    nt.links.new(tc.outputs["Generated"], nz.inputs["Vector"])
    nt.links.new(nz.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])

cow = next(o for o in meshes if len(o.data.vertices) > 1000)
_ws = [cow.matrix_world @ v.co for v in cow.data.vertices]
print("OX_WORLD", tuple(round(max(p[i] for p in _ws) - min(p[i] for p in _ws), 2) for i in range(3)), "scale", tuple(round(x, 3) for x in cow.matrix_world.to_scale()))
# Soft, rounded body (the low-poly facets read as rough at notch size). The
# file stores each face with its own corners (flat-shading export): merge them
# first, or smoothing rounds every face into its own blob.
_bm = bmesh.new(); _bm.from_mesh(cow.data)
bmesh.ops.remove_doubles(_bm, verts=_bm.verts, dist=1e-5)
_bm.to_mesh(cow.data); _bm.free()
for o in meshes:
    if o.type == "MESH":
        for poly in o.data.polygons:
            poly.use_smooth = True
sub = cow.modifiers.new("smooth", "SUBSURF")
sub.levels = sub.render_levels = int(os.environ.get("OX_SUBDIV", "1"))
use_action(CFG["still"])
scene.frame_set(1)
reset_pose()
bpy.context.view_layer.update()
head_bone = arm.pose.bones["Head"]
# The head's vertices (weight to "Head") in world space at rest: where the eyes go.
vg = cow.vertex_groups.get("Head")
pts = [cow.matrix_world @ v.co for v in cow.data.vertices if vg and any(g.group == vg.index and g.weight > 0.6 for g in v.groups)]
hb = arm.matrix_world @ head_bone.matrix
fwd = (hb.to_3x3() @ Vector((0, 1, 0))).normalized()      # the head bone's axis
side = Vector((1, 0, 0)) if abs(fwd.x) < 0.7 else Vector((0, 1, 0))
side = (side - fwd * side.dot(fwd)).normalized()
up = fwd.cross(side).normalized()
if up.z < 0:
    up = -up
c = sum(pts, Vector()) / max(1, len(pts))
loc = lambda p: ((p - c).dot(fwd), (p - c).dot(side), (p - c).dot(up))
L = [loc(p) for p in pts]
flen = max(l[0] for l in L) - min(l[0] for l in L)
hw = max(abs(l[1]) for l in L)
hh = max(l[2] for l in L) - min(l[2] for l in L)
print("OX_HEAD", round(flen, 3), round(hw, 3), round(hh, 3), "fwd", tuple(round(x, 2) for x in fwd), "up", tuple(round(x, 2) for x in up))

R = hw * EYE.get("r", 0.42)                       # eye radius
face = {}

def add(kind, name, at, scale, material, rot=(0, 0, 0)):
    if kind == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, radius=1, location=at)
    elif kind == "cyl":
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=1, depth=2, location=at)
    elif kind == "arc":
        # A closed, smiling eye: the top half of a ring, in the face's plane
        # (local YZ, facing out along local X like the eye whites).
        bpy.ops.mesh.primitive_torus_add(major_radius=1, minor_radius=0.18, major_segments=32, minor_segments=8, location=at)
        o = bpy.context.active_object
        bm = bmesh.new(); bm.from_mesh(o.data)
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.radians(90), 3, "Y"))
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.02], context="VERTS")
        bm.to_mesh(o.data); bm.free()
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    o.rotation_euler = rot
    o.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    face[name] = o
    return o

# Eye centres: toward the front of the head, out to each side, a little up.
for s, sgn in (("L", 1), ("R", -1)):
    # Cartoon three-quarter cheat: the camera sees the head from the R side, so
    # the far (L) eye sits just past the middle of the face instead of behind it.
    sd = EYE.get("s", 0.78) if s == "R" else EYE.get("sfar", -0.08)
    ec = c + fwd * flen * EYE.get("f", 0.18) + side * sgn * hw * sd + up * hh * EYE.get("u", 0.22)
    out = (side * sgn * (0.75 if s == "R" else 0.15) + fwd * 0.65 + side * -1 * 0.35).normalized()
    # basis: x = out of the face, z = up
    zb = up; xb = out; yb = zb.cross(xb).normalized()
    B = Matrix((xb, yb, zb)).transposed()
    eul = B.to_euler()
    add("sphere", f"white.{s}", ec, (R * 0.55, R, R * 1.1), M_WHITE, eul)
    add("sphere", f"pupil.{s}", ec + out * R * 0.42, (R * 0.32, R * 0.55, R * 0.66), M_INK, eul)
    add("sphere", f"shine.{s}", ec + out * R * 0.62 + up * R * 0.35 + yb * R * 0.18, (R * 0.12, R * 0.16, R * 0.16), M_SHINE, eul)
    add("sphere", f"lid.{s}", ec + out * R * 0.4, (R * 0.2, R * 1.02, R * 0.14), M_INK, eul)            # closed: a line
    add("arc", f"happy.{s}", ec + out * R * 0.3 - up * R * 0.25, (R * 0.7, R * 0.7, R * 0.7), M_INK, eul)
    for k, a in (("x1", 45), ("x2", -45)):
        add("cyl", f"{k}.{s}", ec + out * R * 0.35, (R * 0.11, R * 0.11, R * 0.6), M_INK, (B @ Matrix.Rotation(math.radians(a), 3, "X")).to_euler())
    add("cyl", f"brow.{s}", ec + up * R * 1.35 + out * R * 0.2, (R * 0.16, R * 0.16, R * 0.62), M_BROW, (B @ Matrix.Rotation(math.radians(90), 3, "X")).to_euler())
    add("sphere", f"blush.{s}", ec - up * R * 1.05 + out * R * 0.15 + fwd * R * 0.2, (R * 0.12, R * 0.45, R * 0.28), M_BLUSH, eul)

# Parent everything to the Head bone, keeping where it is now (bone parenting
# measures from the bone's tail, so the world matrix is put back after).
bpy.context.view_layer.update()
saved = {o.name: o.matrix_world.copy() for o in face.values()}
for o in face.values():
    o.parent = arm
    o.parent_type = "BONE"
    o.parent_bone = "Head"
bpy.context.view_layer.update()
for o in face.values():
    o.matrix_world = saved[o.name]
bpy.context.view_layer.update()
meshes.extend(face.values())

BROWS = {"calm": (0, 0), "up": (0, 0.35), "focused": (-18, -0.1), "worried": (22, 0.2), "think": (14, 0.25)}
BROW_REST = {}

def set_face(eyes, brows):
    def show(names, on):
        for n in names:
            for s in "LR":
                o = face.get(f"{n}.{s}")
                if o:
                    o.hide_render = not on
    open_ = eyes in ("open", "wide", "focused", "lookup", "content")
    show(["white", "pupil", "shine"], open_)
    show(["lid"], eyes in ("closed",))
    show(["happy"], eyes == "happy")
    show(["x1", "x2"], eyes == "x")
    show(["blush"], eyes in ("happy", "content", "closed"))
    for s, sgn in (("L", 1), ("R", -1)):
        w, p, sh = face[f"white.{s}"], face[f"pupil.{s}"], face[f"shine.{s}"]
        k = 1.18 if eyes == "wide" else 0.72 if eyes == "focused" else 0.8 if eyes == "content" else 1.0
        for o in (w, p, sh):
            base = BROW_REST.setdefault(o.name, (o.scale.copy(), o.location.copy()))
            o.scale = base[0].copy(); o.location = base[1].copy()
            o.scale.z *= k
        if eyes == "lookup":
            p.location = BROW_REST[p.name][1] + Vector((0, 0, R * 0.35)) * 0
        b = face[f"brow.{s}"]
        base = BROW_REST.setdefault(b.name, (b.rotation_euler.copy(), b.location.copy()))
        ang, lift = BROWS.get(brows, (0, 0))
        b.rotation_euler = base[0].copy()
        b.rotation_euler.rotate_axis("Y", math.radians(ang * sgn))
        b.location = base[1].copy()
        b.location.z += R * lift

set_face("open", "calm")

# ---- the ox's friends: the same rig and animations, their own looks -------------
FRIEND = os.environ.get("OX_FRIEND", "")
FRIENDS = {
    # coat, patch colour, patch threshold, scarf, horns (scale, 0 = none), wool, face/legs colour
    "dot":  {"coat": "#FAFAF7", "patch": "#2A2A2E", "cut": 0.5,  "scarf": "#7C5CFF", "horns": 0.0, "wool": False, "head": 1.45},
    "pebble": {"coat": "#FAFAF7", "patch": "#2A2A2E", "cut": 0.66, "scarf": "#FF5A4E", "horns": 0.55, "wool": False, "head": 1.45},
    "puff": {"coat": "#FBFAF6", "patch": "#FBFAF6", "cut": 2.0,  "scarf": "#2EC4A0", "horns": 0.0, "wool": True, "head": 1.4, "face": "#2A2A2E"},
    # The elder, the first ox: the only dark one in the herd, bigger horns, a grey scarf.
    "elder": {"coat": "#3A3A40", "patch": "#2E2E33", "cut": 2.0, "scarf": "#8E939C", "horns": 1.15, "wool": False, "head": 1.3},
    # Maple the pony (the messenger): chestnut, a darker mane-coloured back, no horns, taller and slimmer.
    "maple": {"coat": "#A5643A", "patch": "#4A2A18", "cut": 0.62, "scarf": "#F5C542", "horns": 0.0, "wool": False, "head": 1.35, "face": "#8A5130", "shape": (0.86, 1.0, 1.16)},
}
if FRIEND in FRIENDS:
    F = FRIENDS[FRIEND]
    HEAD = F["head"]
    # A different build on the same rig (Maple: taller and slimmer); the walk cycles stay intact.
    if F.get("shape"):
        sx, sy, sz = F["shape"]
        arm.scale = (arm.scale[0] * sx, arm.scale[1] * sy, arm.scale[2] * sz)
    for m in bpy.data.materials:
        base = m.name.split(".")[0]
        if not m.use_nodes:
            continue
        nt = m.node_tree
        if base == "Main":
            ramp = next((n for n in nt.nodes if n.type == "VALTORGB"), None)
            if ramp:
                ramp.color_ramp.elements[0].color = hexc(F["coat"])
                ramp.color_ramp.elements[1].color = hexc(F["patch"])
                ramp.color_ramp.elements[1].position = F["cut"]
        elif base == "Main_Light":
            b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
            b.inputs["Base Color"].default_value = hexc(F.get("face", F["coat"]))
        elif base == "Muzzle" and F.get("face"):
            b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
            b.inputs["Base Color"].default_value = hexc(F["face"])
    # Horns: shrink (or hide) the horn geometry toward where it grows from.
    hm = next((i for i, m in enumerate(cow.data.materials) if m and m.name.split(".")[0] == "Horns"), None)
    if hm is not None:
        bm = bmesh.new(); bm.from_mesh(cow.data)
        horn_faces = [f for f in bm.faces if f.material_index == hm]
        # each horn is a connected island: scale it about its base (lowest point)
        seen = set()
        for f in horn_faces:
            if f in seen:
                continue
            island, stack = set(), [f]
            while stack:
                g = stack.pop()
                if g in island or g.material_index != hm:
                    continue
                island.add(g)
                for e in g.edges:
                    stack.extend(e.link_faces)
            seen |= island
            verts = {v for g in island for v in g.verts}
            base_pt = min((v.co.copy() for v in verts), key=lambda c: c.z)
            k = max(F["horns"], 0.02)
            for v in verts:
                v.co = base_pt + (v.co - base_pt) * k
        bm.to_mesh(cow.data); bm.free()
        if F["horns"] == 0:
            cow.data.materials[hm].node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = 0.0 if False else 1.0
    # Wool: a bumpy coat on the body (not the face, legs or hooves).
    if F["wool"]:
        main_ids = {i for i, m in enumerate(cow.data.materials) if m and m.name.split(".")[0] == "Main"}
        vgw = cow.vertex_groups.new(name="wool")
        ids = {v for poly in cow.data.polygons if poly.material_index in main_ids for v in poly.vertices}
        vgw.add(list(ids), 1.0, "REPLACE")
        tex = bpy.data.textures.new("woolTex", "CLOUDS")
        # The mesh is stored at 1/100 scale (object scale 100): sizes here are in its units.
        tex.noise_scale = float(os.environ.get("OX_WOOL", "0.0022"))
        disp = cow.modifiers.new("wool", "DISPLACE")
        disp.texture = tex
        disp.vertex_group = "wool"
        disp.strength = float(os.environ.get("OX_WOOL_STRENGTH", "0.0035"))
        disp.mid_level = 0.3
        # displace in rest pose: before the armature
        while cow.modifiers[0] != disp:
            bpy.ops.object.select_all(action="DESELECT")
            cow.select_set(True)
            bpy.context.view_layer.objects.active = cow
            bpy.ops.object.modifier_move_up(modifier="wool")
        sub.levels = sub.render_levels = 2
    # A lamb's charcoal face and lower legs, from the bones they move with.
    if F.get("face"):
        dark = mat("FaceDark", F["face"], 0.65)
        cow.data.materials.append(dark)
        di = len(cow.data.materials) - 1
        groups = {g.index: g.name for g in cow.vertex_groups}
        def heavy(v, names):
            return any(groups.get(g.group, "") in names and g.weight > 0.5 for g in v.groups)
        vs = cow.data.vertices
        keep = {i for i, m in enumerate(cow.data.materials) if m and m.name.split(".")[0] in ("Main", "Main_Light", "Muzzle")}
        for poly in cow.data.polygons:
            if poly.material_index not in keep:
                continue
            pv = [vs[i] for i in poly.vertices]
            if all(heavy(v, {"Head"}) for v in pv) or all(heavy(v, {"FrontLowerLeg.L", "FrontLowerLeg.R", "BackLowerLeg.L", "BackLowerLeg.R"}) for v in pv):
                poly.material_index = di
    # A scarf round the neck, on the neck bone.
    nb = arm.pose.bones.get("Neck2") or arm.pose.bones.get("Neck1")
    nw = arm.matrix_world @ nb.head
    nwt = arm.matrix_world @ nb.tail
    bpy.ops.mesh.primitive_torus_add(major_radius=hw * float(os.environ.get("OX_SCARF", "1.45")), minor_radius=hw * 0.3, major_segments=32, minor_segments=12, location=(nw + nwt) / 2)
    scarf = bpy.context.active_object
    axis = (nwt - nw).normalized()
    scarf.rotation_euler = axis.to_track_quat("Z", "Y").to_euler()
    scarf.data.materials.append(mat("Scarf", F["scarf"], 0.55))
    bpy.ops.object.shade_smooth()
    if FRIEND == "dot":
        bpy.ops.mesh.primitive_uv_sphere_add(radius=hw * 0.22, location=(nw + nwt) / 2 - up * hw * 1.0 + fwd * hw * 0.2)
        bell = bpy.context.active_object
        bell.data.materials.append(mat("Bell", "#EAB308", 0.25, 0.0))
        bpy.ops.object.shade_smooth()
        extra = [scarf, bell]
    else:
        extra = [scarf]
    for o in extra:
        w = o.matrix_world.copy()
        o.parent = arm; o.parent_type = "BONE"; o.parent_bone = nb.name
        bpy.context.view_layer.update()
        o.matrix_world = w
        meshes.append(o)

# ---- three-quarter camera: swing the side camera toward the bull's front.
def place_camera():
    cam.location = Vector((-12, 0, 1.2))
    cam.rotation_euler = (math.radians(90), 0, math.radians(-90))
    rot = Matrix.Rotation(math.radians(AZ), 4, "Z")
    cam.matrix_world = rot @ cam.matrix_world
place_camera()
bpy.context.view_layer.update()
print("OX_CAM", tuple(round(x, 2) for x in cam.location), tuple(round(math.degrees(a), 1) for a in cam.rotation_euler), "arm at", tuple(round(x, 2) for x in arm.matrix_world.translation), "bounds", tuple(round(x, 2) for x in arm.dimensions))

autoframe()


def render_cycle(name):
    act, n, eyes, brows = (CYCLES[name] + ("open", "calm"))[:4]
    set_face(eyes, brows)
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
        if eyes == "blink":
            set_face("closed" if 0.72 <= i / n < 0.8 else "open", brows)
        scene.render.filepath = os.path.join(d, f"{name}_{i + 1:04d}.png")
        bpy.ops.render.render(write_still=True)
    print("OX_CYCLE_DONE", name, n, act, (f0, f1))


def render_turntable(steps=16):
    """The bull standing, turned through 360 degrees in `steps` views
    (turn_0001 faces right like every cycle, then it turns toward the camera
    and on round). The island plays these to turn around instead of flipping."""
    use_action(CFG["still"])
    scene.frame_set(1)
    d = os.path.join(OUT, "turn")
    os.makedirs(d, exist_ok=True)
    root = arm.parent or arm
    # glTF imports use quaternion rotation, where rotation_euler is ignored.
    root.rotation_mode = "XYZ"
    base = root.rotation_euler.copy()
    # Turn about the bull's own middle, not the world origin.
    for i in range(steps):
        root.rotation_euler = base.copy()
        root.rotation_euler.z = base.z - 2 * math.pi * i / steps
        scene.render.filepath = os.path.join(d, f"turn_{i + 1:04d}.png")
        bpy.ops.render.render(write_still=True)
    root.rotation_euler = base
    print("OX_CYCLE_DONE turn", steps)


if MODE == "still":
    use_action(CFG["still"])
    scene.frame_set(1)
    scene.render.filepath = os.path.join(OUT, f"{PROFILE}-still.png")
    bpy.ops.render.render(write_still=True)
elif MODE == "sheet":
    # One frame of every cycle, with its face: the review sheet.
    d = os.path.join(OUT, "sheet")
    os.makedirs(d, exist_ok=True)
    only = [x for x in os.environ.get("OX_ONLY", "").split(",") if x]
    for name, spec in CYCLES.items():
        if only and name not in only:
            continue
        act, n, eyes, brows = (spec + ("open", "calm"))[:4]
        a = use_action(act)
        f0, f1 = a.frame_range
        scene.frame_set(int(f0 + (f1 - f0) * 0.45))
        set_face("open" if eyes == "blink" else eyes, brows)
        scene.render.filepath = os.path.join(d, f"{name}.png")
        bpy.ops.render.render(write_still=True)
    print("OX_SHEET_DONE")
elif MODE == "turn":
    render_turntable()
else:
    for name in (CYCLES if MODE == "all" else [MODE]):
        render_cycle(name)
print("OX_RENDER_DONE", PROFILE, OUT, MODE)
