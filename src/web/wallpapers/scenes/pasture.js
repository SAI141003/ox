// Pasture: ox's own scene. An ox ambles across rolling hills at dusk, stopping
// to graze; the grass sways, a low sun glows, birds cross now and then.
const OX = [
  "            h  h ",
  "  BBBBBBBBBBBHHH ",
  " BBBBbbBBBBBBHHHn",
  "BBBBbbbbBBBBBHHH ",
  " BBBBBBBBBBBB    ",
];
const LEGS = [
  ["  L  L     L  L  ", "  L  L     L  L  "],
  [" L    L   L    L ", "  L  L     L  L  "],
];
// Dark against the dusk hill, with a lighter flank and pale horns so it reads at a glance.
const OX_COLORS = { B: "#3a2418", b: "#6b4428", H: "#2a1a12", h: "#f3e6c8", n: "#120c08", L: "#24160f" };
const NEAR = ["#2f5a2c", "#386a32", "#2a5127"];
const FAR = "#3d4f3a";

Wall.run({
  fps: 12,
  chars: "\"',.;",
  shimmer: 0.4,
  background: {
    stops: [
      [0, "#15112a"],
      [0.45, "#3b2240"],
      [0.75, "#8a4a3a"],
      [1, "#c47a3c"],
    ],
    glows: [{ x: 0.72, y: 0.62, r: 0.35, color: "#ffb020", a: 0.32 }],
  },
  init(g) {
    const random = g.rng(11);
    return {
      birds: Array.from({ length: 4 }, () => ({ y: 0.12 + random() * 0.25, speed: 2 + random() * 2, p: random() * 200 })),
      stars: Array.from({ length: 30 }, () => ({ x: random(), y: random() * 0.3, p: random() * 10 })),
    };
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    const far = (x) => rows * (0.6 + 0.05 * Math.sin(x * 0.045 + 2) + 0.02 * Math.sin(x * 0.17));
    const near = (x) => rows * (0.7 + 0.06 * Math.sin(x * 0.035) + 0.025 * Math.sin(x * 0.11 + 1));

    for (const st of s.stars) {
      const tw = Math.sin(t * 0.9 + st.p);
      if (tw > 0.3) g.cell(st.x * cols, st.y * rows, `rgba(255,236,200,${(0.1 + 0.2 * tw).toFixed(3)})`, ".");
    }
    // The sun, low and soft.
    g.disc(cols * 0.72, rows * 0.6, 4, "#f7b84a", " ");

    for (let x = 0; x < cols; x++) {
      for (let y = Math.floor(far(x)); y < rows; y++) g.cell(x, y, FAR);
      const top = Math.floor(near(x));
      for (let y = top; y < rows; y++) g.cell(x, y, NEAR[(x * 7 + y * 3) % NEAR.length]);
      // Grass tips lean with the wind.
      const lean = Math.sin(t * 1.3 + x * 0.35);
      g.cell(x, top - 1, "#44743a", lean > 0.3 ? "/" : lean < -0.3 ? "\\" : "|");
    }

    // The ox walks a while, then stops to graze, then walks on.
    const cycle = 26;
    const k = Math.floor(t / cycle);
    const u = (t % cycle) / cycle;
    const walking = u < 0.6;
    const dist = k * cycle * 0.6 * 1.1 + Math.min(u, 0.6) * cycle * 1.1;
    const span = cols + 40;
    // Starts a third of the way in, so the ox is in view from the first frame.
    const x = ((dist + cols * 0.3 + 20) % span) - 20;
    const ground = near(Math.max(0, Math.min(cols - 1, Math.round(x))));
    const step = walking ? Math.floor(t * 4) % 2 : 0;
    const art = OX.map((line, i) => (!walking && i === 1 ? line.replace("HHH", "   ") : line));
    if (!walking) art[3] = art[3].replace("HHH ", "  HHH");
    g.sprite([...art, ...LEGS[step]], OX_COLORS, x, ground - 5, false);

    for (const b of s.birds) {
      const bx = ((t * b.speed + b.p) % (cols + 20)) - 10;
      g.cell(bx, b.y * rows + Math.sin(t * 2 + b.p) * 0.6, "rgba(30,20,40,0.55)", Math.floor(t * 5 + b.p) % 2 ? "v" : "-");
    }
  },
});
