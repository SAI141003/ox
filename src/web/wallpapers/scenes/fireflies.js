// From Zeus-Deus/t3code-wallpapers (https://github.com/Zeus-Deus/t3code-wallpapers), MIT; see engine.js.
// Fireflies: a summer meadow at night; fireflies wander and blink above swaying grass.
const GLOW = "#ffe36e";
const GRASS = ["#2f6b33", "#3d7f3b", "#25562b"];

Wall.run({
  fps: 15,
  chars: "|!;:",
  shimmer: 0.2,
  background: {
    stops: [
      [0, "#07130e"],
      [0.7, "#0b2216"],
      [1, "#10301c"],
    ],
    glows: [{ x: 0.5, y: 1.05, r: 0.55, color: "#2f6b33", a: 0.35 }],
    dots: "rgba(200, 255, 200, 0.04)",
  },
  init(g) {
    const random = g.rng(13);
    return {
      flies: Array.from({ length: 34 }, () => ({
        x: random(),
        y: 0.1 + random() * 0.75,
        a: 2 + random() * 6,
        f: 0.08 + random() * 0.15,
        phase: random() * 20,
        blink: 0.4 + random() * 0.9,
      })),
      blades: [],
    };
  },
  resize(g, s) {
    const random = g.rng(17);
    s.blades = Array.from({ length: g.cols }, () => ({
      h: 2 + Math.floor(random() * 6),
      color: GRASS[Math.floor(random() * GRASS.length)],
      p: random() * 6,
    }));
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    if (s.blades.length !== cols) this.resize(g, s);
    for (const f of s.flies) {
      const x = f.x * cols + Math.sin(t * f.f * 6.283 + f.phase) * f.a + Math.sin(t * 0.37 + f.phase) * 2;
      const y = f.y * rows + Math.cos(t * f.f * 5.1 + f.phase) * f.a * 0.6;
      const light = Math.max(0, Math.sin(t * f.blink + f.phase)) ** 3;
      if (light < 0.05) {
        g.cell(x, y, "rgba(255,227,110,0.12)", ".");
        continue;
      }
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        g.cell(x + dx, y + dy, `rgba(255,227,110,${(0.22 * light).toFixed(3)})`, " ");
      }
      g.cell(x, y, light > 0.5 ? GLOW : g.mix(GLOW, "#0b2216", 0.5), "*");
    }
    // Grass along the bottom, tips swaying in the breeze.
    for (let x = 0; x < cols; x++) {
      const blade = s.blades[x];
      for (let k = 0; k < blade.h; k++) {
        const sway = k >= blade.h - 2 ? Math.round(Math.sin(t * 1.2 + x * 0.3 + blade.p) * 0.8) : 0;
        g.cell(x + sway, rows - 1 - k, blade.color);
      }
    }
  },
});
