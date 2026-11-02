// Embers: ox gold sparks rise slowly from a bed of coals and fade into the dark.
Wall.run({
  fps: 14,
  chars: "*+.",
  shimmer: 0.5,
  background: {
    stops: [
      [0, "#07060a"],
      [0.7, "#120b08"],
      [1, "#2a1308"],
    ],
    glows: [{ x: 0.5, y: 1.05, r: 0.55, color: "#ff8a1e", a: 0.28 }],
  },
  init(g) {
    const random = g.rng(3);
    return { sparks: Array.from({ length: 90 }, () => ({ x: random(), speed: 1.2 + random() * 2.4, p: random(), sway: 0.5 + random() * 1.5, size: random() })) };
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    // Coals: a low, flickering bed.
    for (let x = 0; x < cols; x++) {
      const h = 1 + Math.floor(2 * (0.5 + 0.5 * Math.sin(x * 0.4 + t * 0.6)));
      for (let y = rows - h; y < rows; y++) {
        const f = g.hash(x, y, Math.floor(t * 3));
        g.cell(x, y, f > 0.7 ? "#ff9a2a" : f > 0.35 ? "#c4501a" : "#6e2410", f > 0.85 ? "*" : ".");
      }
    }
    for (const sp of s.sparks) {
      const travel = rows + 6;
      const y = rows - 2 - ((t * sp.speed + sp.p * travel) % travel);
      const life = 1 - (rows - y) / travel;
      const x = sp.x * cols + Math.sin(t * 0.8 + sp.p * 20) * sp.sway;
      const color = life > 0.6 ? "#ffd27a" : life > 0.3 ? "#ffb020" : "#e0661c";
      g.cell(x, y, g.alpha(color, 0.25 + 0.75 * life), sp.size > 0.8 ? "*" : sp.size > 0.4 ? "+" : ".");
    }
  },
});
