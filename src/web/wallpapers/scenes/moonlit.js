// From Zeus-Deus/t3code-wallpapers (https://github.com/Zeus-Deus/t3code-wallpapers), MIT; see engine.js.
// Moonlit: a crescent moon over drifting night clouds, stars twinkling, the odd shooting star.
const MOON = "#efe2b8";
const MOON_SHADE = "#d8c894";
const CLOUD = "#3e5aa8";
const CLOUD_LIGHT = "#5672c4";

Wall.run({
  fps: 12,
  chars: "%$t:",
  shimmer: 0.25,
  background: {
    stops: [
      [0, "#0a1440"],
      [0.6, "#14246a"],
      [1, "#1d3488"],
    ],
    glows: [{ x: 0.78, y: 0.22, r: 0.35, color: "#c9d2ff", a: 0.16 }],
    dots: "rgba(200, 210, 255, 0.05)",
  },
  init(g) {
    const random = g.rng(29);
    return {
      stars: Array.from({ length: 90 }, () => ({ x: random(), y: random() * 0.85, p: random() * 10, s: 0.5 + random() * 2 })),
      bands: Array.from({ length: 6 }, (_, i) => ({
        y: 0.42 + i * 0.1 + random() * 0.04,
        length: 14 + random() * 22,
        x: random(),
        speed: 0.4 + random() * 0.7,
        thick: 1 + Math.floor(random() * 2),
      })),
    };
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    for (const star of s.stars) {
      const tw = Math.sin(t * star.s + star.p);
      if (tw < -0.2) continue;
      g.cell(star.x * cols, star.y * rows, tw > 0.85 ? "#fff6d8" : `rgba(230,235,255,${(0.15 + 0.25 * tw).toFixed(3)})`, tw > 0.85 ? "+" : ".");
    }
    // A shooting star every so often.
    const cycle = t % 14;
    if (cycle < 1.2) {
      const p = cycle / 1.2;
      const sx = cols * (0.15 + p * 0.35);
      const sy = rows * (0.08 + p * 0.18);
      for (let k = 0; k < 7; k++) {
        g.cell(sx - k * 1.6, sy - k * 0.6, `rgba(255,248,220,${(0.9 - k * 0.12).toFixed(3)})`, k === 0 ? "*" : "-");
      }
    }
    // Crescent: a disc with a second disc taken out of it.
    const mx = cols * 0.78;
    const my = rows * 0.22;
    const r = Math.min(cols, rows / g.ASPECT) * 0.13;
    g.shape(mx, my, r + 1, 0, (lx, ly) => {
      if (lx * lx + ly * ly > r * r) return null;
      const cx = lx - r * 0.42;
      const cy = ly + r * 0.12;
      if (cx * cx + cy * cy < (r * 0.82) ** 2) return null;
      return lx < -r * 0.45 ? MOON : MOON_SHADE;
    });
    // Long, low clouds: a flat base with a couple of soft bumps on top.
    for (const b of s.bands) {
      const span = cols + b.length * 2;
      const x = ((b.x * span + t * b.speed) % span) - b.length;
      const y = b.y * rows;
      const half = b.length / 2;
      const h = 0.9 + b.thick * 0.6;
      g.shape(x, y, half + 2, 0, (lx, ly) => {
        if (ly > h * 0.6) return null;
        const base = (lx / half) ** 2 + (ly / h) ** 2 <= 1;
        const bump1 = (lx + half * 0.25) ** 2 + (ly + h * 0.6) ** 2 <= (h * 1.2) ** 2;
        const bump2 = (lx - half * 0.3) ** 2 + (ly + h * 0.4) ** 2 <= (h * 0.9) ** 2;
        if (!base && !bump1 && !bump2) return null;
        return ly < -h * 0.2 ? CLOUD_LIGHT : CLOUD;
      });
    }
  },
});
