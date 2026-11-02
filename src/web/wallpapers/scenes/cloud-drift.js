// From Zeus-Deus/t3code-wallpapers (https://github.com/Zeus-Deus/t3code-wallpapers), MIT; see engine.js.
// Cloud Drift: puffy pixel clouds crossing a bright sky at three depths.
const WHITE = "#ffffff";
const SHADE = "#e3eef8";
const FAR = "#d5e8f8";

Wall.run({
  fps: 12,
  chars: "%o:~",
  shimmer: 0.3,
  background: {
    stops: [
      [0, "#3f9ae8"],
      [0.6, "#7fc0f2"],
      [1, "#cfe8fb"],
    ],
    glows: [{ x: 0.82, y: 0.08, r: 0.35, color: "#fff7d6", a: 0.45 }],
    dots: "rgba(255, 255, 255, 0.10)",
  },
  init(g) {
    const random = g.rng(11);
    const clouds = [];
    for (const [depth, count] of [
      [0, 5],
      [1, 4],
      [2, 3],
    ]) {
      for (let i = 0; i < count; i++) {
        const puffs = Array.from({ length: 4 + Math.floor(random() * 4) }, (_, k) => ({
          dx: (k - 2.5) * (2.2 + random()) * (1 + depth * 0.5),
          dy: (random() - 0.6) * 1.4 * (1 + depth * 0.4),
          r: (1.6 + random() * 1.8) * (1 + depth * 0.55),
        }));
        clouds.push({ depth, puffs, x: random(), y: 0.08 + random() * 0.8, speed: 0.6 + depth * 0.9 });
      }
    }
    return { clouds };
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    const span = cols + 40;
    for (const c of s.clouds) {
      const x = ((c.x * span + t * c.speed) % span) - 20;
      const y = c.y * rows + Math.sin(t * 0.2 + c.x * 9) * 0.6;
      for (const p of c.puffs) {
        const top = c.depth === 0 ? FAR : WHITE;
        g.shape(x + p.dx, y + p.dy, p.r, 0, (lx, ly) => {
          if (lx * lx + ly * ly > p.r * p.r) return null;
          if (ly > p.r * 0.45) return c.depth === 0 ? FAR : SHADE;
          return top;
        });
      }
    }
  },
});
