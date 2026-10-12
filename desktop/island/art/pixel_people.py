# The pixel cast's sprite source of truth, plus a preview renderer.
#
#   python3 pixel_people.py              # write Resources/pixel/people.json
#   python3 pixel_people.py --sheet out  # also write preview sheets (needs Pillow)
#
# Every sprite is 16 x 24 art pixels, composed from layers: body (pose and
# frame), head, face (eyes and mouth), hair (style and direction) and
# accessories. Each layer is a list of 24 strings; '.' leaves what is below,
# any other code paints. The Swift side (PixelPeople.swift) reads the same
# JSON, composes the same way and adds the 1-px outline, so the preview here
# is exactly what the island draws.
#
# Codes: s skin, S skin shade, h hair, H hair light, d hair dark, c shirt,
# C shirt shade, p pants, P pants shade, k shoes, e eye, m mouth, t teeth,
# r tongue, b blush, g glasses, y hat, Y hat band, o overall strap, w white.

import json
import os
import sys

W, H = 16, 24
E = "." * W


def blank():
    return [E] * H


def at(rows_by_index):
    """Build a 24-row layer from {row: string}."""
    out = blank()
    for i, r in rows_by_index.items():
        assert len(r) == W, f"row {i} is {len(r)} wide: {r!r}"
        out[i] = r
    return out


# ------------------------------------------------------------------ heads

HEAD = {
    "front": at({
        3: "....ssssssss....",
        4: "...ssssssssss...",
        5: "...ssssssssss...",
        6: "...ssssssssss...",
        7: "..ssssssssssss..",
        8: "..ssssssssssss..",
        9: "...ssssssssss...",
        10: "...Sssssssss S..".replace(" ", "s"),
        11: "....SSssssSS....",
        12: "......SSSS......",
    }),
    "side": at({
        3: ".....ssssssss...",
        4: "....ssssssssss..",
        5: "....sssssssssss.",
        6: "....sssssssssss.",
        7: "....ssssssssssss",
        8: "....sssssssssss.",
        9: "....ssssssssss..",
        10: ".....Sssssssss..",
        11: "......SSsssSS...",
        12: ".......SSSS.....",
    }),
    "back": at({
        3: "....ssssssss....",
        4: "...ssssssssss...",
        5: "...ssssssssss...",
        6: "...ssssssssss...",
        7: "..ssssssssssss..",
        8: "..ssssssssssss..",
        9: "...ssssssssss...",
        10: "...ssssssssss...",
        11: "....SSssssSS....",
        12: "......SSSS......",
    }),
}

# Eyes (open / blink) per direction, painted over the head.
EYES = {
    "front": {"open": at({7: ".....e....e.....", 8: ".....e....e....."}),
              "blink": at({8: ".....e....e....."})},
    "side": {"open": at({7: "...........e....", 8: "...........e...."}),
             "blink": at({8: "...........e...."})},
}

# Mouths per direction for the talking visemes, plus blush.
MOUTHS = {
    "front": {
        "rest": at({10: ".......mm......."}),
        "closed": at({10: "......mmmm......"}),
        "small": at({10: ".......mm.......", 11: ".......mm......."}),
        "open": at({10: "......mmmm......", 11: ".......rr......."}),
        "wide": at({10: "......tttt......", 11: "......mmmm......"}),
        "round": at({9: ".......mm.......", 10: "......m..m......", 11: ".......mm......."}),
        "smile": at({10: "......m..m......", 11: ".......mm......."}),
    },
    "side": {
        "rest": at({10: "............m..."}),
        "closed": at({10: "...........mm..."}),
        "small": at({10: "............m...", 11: "............m..."}),
        "open": at({10: "...........mm...", 11: "...........rm..."}),
        "wide": at({10: "...........tm...", 11: "...........mm..."}),
        "round": at({10: "............m...", 11: "...........mm..."}),
        "smile": at({10: "............m...", 11: "...........m...."}),
    },
}

# ------------------------------------------------------------------ hair

HAIR = {
    "spiky": {
        "front": at({
            0: ".....h..h..h....",
            1: "....hhh.hh.hh...",
            2: "...hhhhhhhhhhh..",
            3: "..hhHHHhhhhhhhh.",
            4: "..hhhhhhhhhhhhh.",
            5: "..hhh.hhh.hhhhh.",
            6: "..hh.......h.hh.",
            7: "..h..........h..",
        }),
        "side": at({
            0: "......h..h.h....",
            1: ".....hhh.hhhh...",
            2: "....hhhhhhhhhh..",
            3: "...hhHHHhhhhhhh.",
            4: "...hhhhhhhhhhhh.",
            5: "...hhhhhhhh.hhh.",
            6: "...hhhhhh....h..",
            7: "...hhhh.........",
            8: "....hh..........",
        }),
        "back": at({
            0: ".....h..h..h....",
            1: "....hhh.hh.hh...",
            2: "...hhhhhhhhhhh..",
            3: "..hhHHHhhhhhhhh.",
            4: "..hhhhhhhhhhhhh.",
            5: "..hhhhhhhhhhhhh.",
            6: "..hhhhhhhhhhhhh.",
            7: "..dhhhhhhhhhhhd.",
            8: "...dhhhhhhhhhd..",
            9: "....dhhhhhhd....",
        }),
    },
    "long": {
        "front": at({
            1: ".....hhhhhh.....",
            2: "...hhhhhhhhhh...",
            3: "..hhhHHHhhhhhh..",
            4: "..hhhhhhhhhhhh..",
            5: "..hhhhhh.hhhhh..",
            6: "..hhh.......hh..",
            7: "..hh........hh..",
            8: "..hh........hh..",
            9: "..hh........hh..",
            10: "..hh........hh..",
            11: "..hhh......hhh..",
            12: "..hhh......hhh..",
            13: "..dhh......hhd..",
            14: "...dh......hd...",
        }),
        "side": at({
            1: "......hhhhhh....",
            2: "....hhhhhhhhhh..",
            3: "...hhhHHHhhhhhh.",
            4: "...hhhhhhhhhhhh.",
            5: "...hhhhhhhhh.hh.",
            6: "...hhhhhh.......",
            7: "...hhhhh........",
            8: "...hhhhh........",
            9: "...hhhhh........",
            10: "...hhhhh........",
            11: "...hhhhh........",
            12: "...dhhhh........",
            13: "...dhhh.........",
            14: "....dh..........",
        }),
        "back": at({
            1: ".....hhhhhh.....",
            2: "...hhhhhhhhhh...",
            3: "..hhhHHHhhhhhh..",
            4: "..hhhhhhhhhhhh..",
            5: "..hhhhhhhhhhhh..",
            6: "..hhhhhhhhhhhh..",
            7: "..hhhhhhhhhhhh..",
            8: "..hhhhhhhhhhhh..",
            9: "..hhhhhhhhhhhh..",
            10: "..hhhhhhhhhhhh..",
            11: "..hhhhhhhhhhhh..",
            12: "..dhhhhhhhhhhd..",
            13: "..dhhhhhhhhhhd..",
            14: "...dhhhhhhhhd...",
        }),
    },
    "afro": {
        "front": at({
            0: ".....hhhhhh.....",
            1: "...hhhhhhhhhh...",
            2: "..hhhHhhhhHhhh..",
            3: ".hhhhhhhhhhhhhh.",
            4: ".hhHhhhhhhhhHhh.",
            5: ".hhhhhhhhhhhhhh.",
            6: ".hhh........hhh.",
            7: ".hh..........hh.",
            8: "..h..........h..",
        }),
        "side": at({
            0: "......hhhhhh....",
            1: "....hhhhhhhhhh..",
            2: "...hhhHhhhhHhhh.",
            3: "..hhhhhhhhhhhhhh",
            4: "..hhHhhhhhhhhhh.",
            5: "..hhhhhhhhhh.hh.",
            6: "..hhhhhhh.......",
            7: "..hhhhhhh.......",
            8: "..hhhhhh........",
            9: "...hhhh.........",
        }),
        "back": at({
            0: ".....hhhhhh.....",
            1: "...hhhhhhhhhh...",
            2: "..hhhHhhhhHhhh..",
            3: ".hhhhhhhhhhhhhh.",
            4: ".hhHhhhhhhhhHhh.",
            5: ".hhhhhhhhhhhhhh.",
            6: ".hhhhhhhhhhhhhh.",
            7: ".hhhhhhhhhhhhhh.",
            8: "..dhhhhhhhhhhd..",
            9: "...dhhhhhhhhd...",
        }),
    },
    "bob": {
        "front": at({
            1: ".....hhhhhh.....",
            2: "...hhhhhhhhhh...",
            3: "..hhhHHHhhhhhh..",
            4: "..hhhhhhhhhhhh..",
            5: "..hhhhhhhhhhhh..",
            6: "..hh.hhhhhh.hh..",
            7: "..hh........hh..",
            8: "..hh........hh..",
            9: "..hh........hh..",
            10: "..dh........hd..",
        }),
        "side": at({
            1: "......hhhhhh....",
            2: "....hhhhhhhhhh..",
            3: "...hhhHHHhhhhhh.",
            4: "...hhhhhhhhhhhh.",
            5: "...hhhhhhhhh.hh.",
            6: "...hhhhhh.......",
            7: "...hhhhhh.......",
            8: "...hhhhhh.......",
            9: "...hhhhhh.......",
            10: "...dhhhhd.......",
        }),
        "back": at({
            1: ".....hhhhhh.....",
            2: "...hhhhhhhhhh...",
            3: "..hhhHHHhhhhhh..",
            4: "..hhhhhhhhhhhh..",
            5: "..hhhhhhhhhhhh..",
            6: "..hhhhhhhhhhhh..",
            7: "..hhhhhhhhhhhh..",
            8: "..hhhhhhhhhhhh..",
            9: "..hhhhhhhhhhhh..",
            10: "..dhhhhhhhhhhd..",
        }),
    },
    "short": {
        "front": at({
            1: ".....hhhhhh.....",
            2: "...hhhhhhhhhh...",
            3: "..hhHHHhhhhhhh..",
            4: "..hhhhhhhhhhhh..",
            5: "..hhhh....hhhh..",
            6: "..h..........h..",
        }),
        "side": at({
            1: "......hhhhhh....",
            2: "....hhhhhhhhhh..",
            3: "...hhHHHhhhhhhh.",
            4: "...hhhhhhhhhhhh.",
            5: "...hhhhhhh..hh..",
            6: "...hhhhh........",
            7: "...hhhh.........",
        }),
        "back": at({
            1: ".....hhhhhh.....",
            2: "...hhhhhhhhhh...",
            3: "..hhHHHhhhhhhh..",
            4: "..hhhhhhhhhhhh..",
            5: "..hhhhhhhhhhhh..",
            6: "..hhhhhhhhhhhh..",
            7: "..dhhhhhhhhhhd..",
            8: "...dhhhhhhhhd...",
        }),
    },
    "curly": {
        "front": at({
            0: "....h.hh.hh.h...",
            1: "...hhhhhhhhhhh..",
            2: "..hhHhhHhhHhhhh.",
            3: "..hhhhhhhhhhhhh.",
            4: "..hhHhhhHhhhHhh.",
            5: "..hh.hh.hh.h.hh.",
            6: "..h..........h..",
            7: "..h..........h..",
        }),
        "side": at({
            0: ".....h.hh.hh.h..",
            1: "....hhhhhhhhhhh.",
            2: "...hhHhhHhhHhhhh",
            3: "...hhhhhhhhhhhh.",
            4: "...hhHhhhHhh.hh.",
            5: "...hhhhhhhh.....",
            6: "...hhhhhh.......",
            7: "...hhhhh........",
            8: "....hh..........",
        }),
        "back": at({
            0: "....h.hh.hh.h...",
            1: "...hhhhhhhhhhh..",
            2: "..hhHhhHhhHhhhh.",
            3: "..hhhhhhhhhhhhh.",
            4: "..hhHhhhHhhhHhh.",
            5: "..hhhhhhhhhhhhh.",
            6: "..hhhhhhhhhhhhh.",
            7: "..dhhhhhhhhhhhd.",
            8: "...dhhhhhhhhhd..",
        }),
    },
}

ACC = {
    "glasses": {
        "front": at({6: "....ggg..ggg....", 7: "....g.gggg.g....", 8: "....g.g..g.g....", 9: "....ggg..ggg...."}),
        "side": at({6: "..........ggg...", 7: "........ggg.g...", 8: "..........g.g...", 9: "..........ggg..."}),
    },
    "hat": {
        "front": at({
            0: "....yyyyyyyy....",
            1: "....yyyyyyyy....",
            2: "....YYYYYYYY....",
            3: ".yyyyyyyyyyyyyy.",
            4: "..yyyyyyyyyyyy..",
        }),
        "side": at({
            0: ".....yyyyyyy....",
            1: ".....yyyyyyy....",
            2: ".....YYYYYYY....",
            3: "..yyyyyyyyyyyyyy",
            4: "...yyyyyyyyyyy..",
        }),
        "back": at({
            0: "....yyyyyyyy....",
            1: "....yyyyyyyy....",
            2: "....YYYYYYYY....",
            3: ".yyyyyyyyyyyyyy.",
            4: "..yyyyyyyyyyyy..",
        }),
    },
}

# ------------------------------------------------------------------ bodies

FRONT_TORSO = {
    13: "....cccccccc....",
    14: "...cccccccccc...",
    15: "...cCccccccCc...",
    16: "...cCccccccCc...",
    17: "...sCccccccCs...",
    18: "...s.pppppp.s...",
    19: ".....pppppp.....",
}
FRONT_LEGS = {
    "stand": {20: ".....pp..pp.....", 21: ".....pp..pp.....", 22: ".....kk..kk.....", 23: "....kkk..kkk...."},
    "stepL": {20: ".....pp..pp.....", 21: ".....pp..kk.....", 22: ".....kk.kkk.....", 23: "....kkk........."},
    "stepR": {20: ".....pp..pp.....", 21: ".....kk..pp.....", 22: ".....kkk.kk.....", 23: ".........kkk...."},
}


def body(torso, legs, extra=None):
    rows = dict(torso)
    rows.update(legs)
    if extra:
        rows.update(extra)
    return at(rows)


BODIES = {
    "front": {
        "stand": [body(FRONT_TORSO, FRONT_LEGS["stand"])],
        "walk": [body(FRONT_TORSO, FRONT_LEGS["stand"]), body(FRONT_TORSO, FRONT_LEGS["stepL"]),
                 body(FRONT_TORSO, FRONT_LEGS["stand"]), body(FRONT_TORSO, FRONT_LEGS["stepR"])],
        # Right hand (viewer's right) up beside the head, swinging.
        "wave": [
            body({**FRONT_TORSO, 14: "...ccccccccccss.", 15: "...cCccccccCcss.", 16: "...cCccccccC....", 17: "...sCccccccC...."},
                 FRONT_LEGS["stand"], {11: ".............ss.", 12: "......SSSS...ss.", 13: "....cccccccccc.."}),
            body({**FRONT_TORSO, 14: "...ccccccccccc..", 15: "...cCccccccCcc..", 16: "...cCccccccC....", 17: "...sCccccccC...."},
                 FRONT_LEGS["stand"], {10: "..............ss", 11: "..............ss", 12: "......SSSS...cc.", 13: "....cccccccccc.."}),
        ],
        "point": [body({**FRONT_TORSO, 15: "...cCcccccccccss", 16: "...cCccccccC....", 17: "...sCccccccC...."}, FRONT_LEGS["stand"])],
        # Both hands up and open: explaining, or cheering.
        "open": [body({**FRONT_TORSO, 13: "..s.cccccccc.s..", 14: "..sccccccccccs..", 15: "...cCccccccCc...", 16: "...cCccccccCc...", 17: "....Ccccccc C....".replace(" ", "")[:16], 18: ".....pppppp....."},
                      FRONT_LEGS["stand"])],
        "think": [body({**FRONT_TORSO, 16: "...cCccccccC....", 17: "...sCccccccC....", 13: "....cccccccc.s..", 14: "...ccccccccccs.."}, FRONT_LEGS["stand"],
                       {12: "......SSSS.ss..."})],
    },
    "side": {
        "stand": [at({13: ".....cccccc.....", 14: ".....cccccc.....", 15: ".....cCcccc.....", 16: ".....cCcccc.....", 17: ".....cCccsc.....",
                      18: ".....pppppp.....", 19: ".....pppppp.....", 20: "......pppp......", 21: "......pppp......", 22: "......kkkkk.....", 23: "......kkkkkk...."})],
        "walk": [
            at({13: ".....cccccc.....", 14: ".....cccccc.....", 15: ".....cCcccc.....", 16: ".....cCcccc.....", 17: ".....cCccsc.....",
                18: ".....pppppp.....", 19: ".....pppppp.....", 20: "......pppp......", 21: "......pppp......", 22: "......kkkkk.....", 23: "......kkkkkk...."}),
            at({13: ".....cccccc.....", 14: ".....cccccc.....", 15: "....scCcccc.....", 16: ".....cCccccs....", 17: ".....cCcccc.....",
                18: ".....pppppp.....", 19: "....pppPpppp....", 20: "...ppp...ppp....", 21: "...pp.....pp....", 22: "..kkk.....kkk...", 23: "..kk.......kkk.."}),
            at({13: ".....cccccc.....", 14: ".....cccccc.....", 15: ".....cCcccc.....", 16: ".....cCcccc.....", 17: ".....cCccsc.....",
                18: ".....pppppp.....", 19: ".....pppppp.....", 20: "......pppp......", 21: "......pppp......", 22: "......kkkkk.....", 23: "......kkkkkk...."}),
            at({13: ".....cccccc.....", 14: ".....cccccc.....", 15: ".....cCccccs....", 16: "....scCcccc.....", 17: ".....cCcccc.....",
                18: ".....pppppp.....", 19: "....ppppPppp....", 20: "....ppp..ppp....", 21: "....pp....pp....", 22: "...kkk....kkk...", 23: "...kk.......kkk."}),
        ],
    },
    "back": {
        "stand": [body({13: "....cccccccc....", 14: "...cccccccccc...", 15: "...cCccccccCc...", 16: "...cCccccccCc...",
                        17: "...sCCccccCCs...", 18: "...s.pppppp.s...", 19: ".....pppppp....."}, FRONT_LEGS["stand"])],
        # Seated at a desk, seen from behind: the chair and desk hide the legs.
        "type": [
            at({13: "....cccccccc....", 14: "...cccccccccc...", 15: "..scCccccccCcs..", 16: "..s.CccccccC.s..", 17: "....CCccccCC...."}),
            at({13: "....cccccccc....", 14: "..scccccccccc...", 15: "..s.CccccccCcs..", 16: "....CcccccccCs..", 17: "....CCccccCC...."}),
        ],
        "read": [
            at({13: "....cccccccc....", 14: "...cccccccccc...", 15: "...cCccccccCc...", 16: "..ssCccccccCss..", 17: "....CCccccCC...."}),
        ],
    },
}

# ------------------------------------------------------------------ people

PEOPLE = {
    "mira": {"skin": "#F2C9A5", "skinShade": "#D9A07C", "hair": "#2B2230", "hairLight": "#4A3D55", "hairDark": "#1A141E",
             "shirt": "#D9485F", "shirtShade": "#A8344A", "pants": "#2E3A5C", "shoes": "#2A2226", "style": "long", "acc": []},
    "theo": {"skin": "#F5D0B0", "skinShade": "#DCA984", "hair": "#7A4A2A", "hairLight": "#A0663C", "hairDark": "#55331D",
             "shirt": "#3F7DD8", "shirtShade": "#2C5DA8", "pants": "#3A3A44", "shoes": "#1E1E24", "style": "spiky", "acc": []},
    "ade": {"skin": "#8A5A3C", "skinShade": "#6E4429", "hair": "#1C1715", "hairLight": "#3A2F2A", "hairDark": "#100D0C",
            "shirt": "#F08A3C", "shirtShade": "#C8682A", "pants": "#2E3A5C", "shoes": "#F4EFE6", "style": "afro", "acc": []},
    "lin": {"skin": "#F6D7BC", "skinShade": "#DDB395", "hair": "#1F2A2E", "hairLight": "#36505A", "hairDark": "#131B1E",
            "shirt": "#2BB3A3", "shirtShade": "#1F8579", "pants": "#46385E", "shoes": "#2A2226", "style": "bob", "acc": []},
    "sol": {"skin": "#C99572", "skinShade": "#A8775A", "hair": "#E6E2DC", "hairLight": "#FFFFFF", "hairDark": "#B9B3AB",
            "shirt": "#EADFC8", "shirtShade": "#C7B999", "pants": "#6B5A4A", "shoes": "#3A2E26", "style": "short", "acc": []},
    "rui": {"skin": "#E8B48E", "skinShade": "#C98F6A", "hair": "#5A3A22", "hairLight": "#7E5534", "hairDark": "#3E2716",
            "shirt": "#4FA36A", "shirtShade": "#3A7D50", "pants": "#3A3A44", "shoes": "#1E1E24", "style": "curly", "acc": ["glasses"]},
    "farmer": {"skin": "#E8B48E", "skinShade": "#C98F6A", "hair": "#7A4A2A", "hairLight": "#A0663C", "hairDark": "#55331D",
               "shirt": "#E9DCC0", "shirtShade": "#C9B999", "pants": "#3D6CB5", "shoes": "#5A3A22", "style": "short", "acc": ["hat"],
               "hat": "#E9C27B", "hatBand": "#B5462F"},
}

SHARED = {"eye": "#1A1214", "mouth": "#5A1E28", "teeth": "#FFFFFF", "tongue": "#D9566A", "blush": "#F08C8C",
          "glasses": "#D9A441", "outline": "#1A1214", "white": "#FFFFFF"}


def spec():
    return {"w": W, "h": H, "heads": HEAD, "eyes": EYES, "mouths": MOUTHS, "hair": HAIR, "acc": ACC,
            "bodies": BODIES, "people": PEOPLE, "shared": SHARED}


# ------------------------------------------------------------------ preview

def compose(person, direction, pose, frame=0, mouth="rest", blink=False):
    """The same composition the island does. Returns 24 rows of codes."""
    face_dir = "side" if direction == "side" else "front"
    grid = [list(r) for r in blank()]

    def stamp(layer):
        for y, row in enumerate(layer):
            for x, ch in enumerate(row):
                if ch != ".":
                    grid[y][x] = ch

    p = PEOPLE[person]
    frames = BODIES[direction][pose]
    stamp(frames[frame % len(frames)])
    stamp(HEAD[direction])
    if direction != "back":
        stamp(EYES[face_dir]["blink" if blink else "open"])
        stamp(MOUTHS[face_dir][mouth])
    stamp(HAIR[p["style"]][direction])
    for a in p["acc"]:
        if direction in ACC[a]:
            stamp(ACC[a][direction])
    return ["".join(r) for r in grid]


def colours(person):
    p = PEOPLE[person]
    return {"s": p["skin"], "S": p["skinShade"], "h": p["hair"], "H": p["hairLight"], "d": p["hairDark"],
            "c": p["shirt"], "C": p["shirtShade"], "p": p["pants"], "P": p["pants"], "k": p["shoes"],
            "e": SHARED["eye"], "m": SHARED["mouth"], "t": SHARED["teeth"], "r": SHARED["tongue"], "b": SHARED["blush"],
            "g": SHARED["glasses"], "y": p.get("hat", "#E9C27B"), "Y": p.get("hatBand", "#B5462F"), "o": p["pants"], "w": SHARED["white"]}


def render(rows, cmap, scale):
    from PIL import Image
    img = Image.new("RGBA", ((W + 2) * scale, (H + 2) * scale), (0, 0, 0, 0))
    px = img.load()
    filled = {(x, y) for y, r in enumerate(rows) for x, ch in enumerate(r) if ch != "."}

    def put(x, y, hexc):
        h = hexc.lstrip("#")
        rgb = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (255,)
        for dy in range(scale):
            for dx in range(scale):
                px[(x + 1) * scale + dx, (y + 1) * scale + dy] = rgb

    for y in range(-1, H + 1):
        for x in range(-1, W + 1):
            if (x, y) in filled:
                continue
            if any((x + dx, y + dy) in filled for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                put(x, y, SHARED["outline"])
    for (x, y) in filled:
        put(x, y, cmap[rows[y][x]])
    return img


def sheet(out):
    from PIL import Image
    os.makedirs(out, exist_ok=True)
    scale = 6
    cells = [("front", "stand", 0, "rest", False), ("front", "walk", 1, "rest", False), ("front", "wave", 0, "smile", False),
             ("front", "point", 0, "open", False), ("front", "open", 0, "wide", False), ("front", "think", 0, "closed", True),
             ("side", "walk", 1, "rest", False), ("side", "walk", 3, "open", False), ("back", "stand", 0, "rest", False),
             ("back", "type", 0, "rest", False), ("back", "type", 1, "rest", False)]
    cw, ch = (W + 2) * scale, (H + 2) * scale
    img = Image.new("RGBA", (cw * len(cells), ch * len(PEOPLE)), (36, 30, 40, 255))
    for r, person in enumerate(PEOPLE):
        for c, (d, pose, f, mouth, blink) in enumerate(cells):
            img.alpha_composite(render(compose(person, d, pose, f, mouth, blink), colours(person), scale), (c * cw, r * ch))
    img.save(os.path.join(out, "people-sheet.png"))
    print("sheet", os.path.join(out, "people-sheet.png"))


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, "..", "Sources", "OxIsland", "Resources", "pixel")
    os.makedirs(dest, exist_ok=True)
    with open(os.path.join(dest, "people.json"), "w") as f:
        json.dump(spec(), f, separators=(",", ":"))
    print("wrote", os.path.normpath(os.path.join(dest, "people.json")))
    if "--sheet" in sys.argv:
        sheet(sys.argv[sys.argv.index("--sheet") + 1])
