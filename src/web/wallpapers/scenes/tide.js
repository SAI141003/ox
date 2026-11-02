// Tide: slow swells roll under a night sky, foam catching the light. For deep work.
const WATER = ["#0c3a4a", "#0f4656", "#125363", "#16606f", "#1a6d7b"];

Wall.run({
  fps: 12,
  chars: "~-=",
  shimmer: 0.35,
  background: {
    stops: [
      [0, "#04121a"],
      [0.4, "#072230"],
      [1, "#0a2e3c"],
    ],
    glows: [{ x: 0.25, y: 0.18, r: 0.3, color: "#bfe8ff", a: 0.1 }],
  },
  init(g) {
    const random = g.rng(41);
    return { glints: Array.from({ length: 60 }, () => ({ x: random(), y: 0.45 + random() * 0.55, p: random() * 10 })) };
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    const bands = WATER.length;
    for (let k = 0; k < bands; k++) {
      const base = rows * (0.42 + k * 0.12);
      for (let x = 0; x < cols; x++) {
        const y = base + Math.sin(x * 0.09 + t * (0.5 + k * 0.08) + k * 1.7) * (1 + k * 0.35) + Math.sin(x * 0.23 - t * 0.7) * 0.4;
        // Down to where the next swell starts, so the water has no gaps.
        const bottom = k === bands - 1 ? rows : Math.floor(rows * (0.42 + (k + 1) * 0.12)) + 3;
        for (let yy = Math.floor(y); yy < Math.min(rows, bottom); yy++) g.cell(x, yy, WATER[k]);
        // The crest of each swell.
        if (Math.sin(x * 0.31 + t * 1.1 + k) > 0.55) g.cell(x, Math.floor(y), "rgba(200,240,255,0.22)", "~");
      }
    }
    for (const gl of s.glints) {
      const a = Math.sin(t * 1.6 + gl.p);
      if (a > 0.75) g.cell(gl.x * cols, gl.y * rows, "rgba(255,240,200,0.35)", "*");
    }
  },
});
