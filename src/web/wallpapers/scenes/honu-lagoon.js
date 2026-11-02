// From Zeus-Deus/t3code-wallpapers (https://github.com/Zeus-Deus/t3code-wallpapers), MIT; see engine.js.
// Honu Lagoon: sea turtles glide across a sunlit lagoon while a school of fish darts past.
const SHELL = "#6f8f3a";
const SHELL_LIGHT = "#9bb44f";
const SHELL_EDGE = "#4f6a2a";
const SKIN = "#c8b88a";
const SKIN_DARK = "#a8956a";
const FISH = ["#ff6b4a", "#ffd23f", "#ff8fb1"];

Wall.run({
  fps: 15,
  chars: "$%tS:",
  background: {
    stops: [
      [0, "#3fc1c9"],
      [0.5, "#1e9bb0"],
      [1, "#0f6f8f"],
    ],
    glows: [
      { x: 0.3, y: -0.05, r: 0.55, color: "#e8fff6", a: 0.35 },
      { x: 0.9, y: 0.9, r: 0.4, color: "#0b4d6e", a: 0.45 },
    ],
    dots: "rgba(230, 255, 255, 0.08)",
  },
  init(g) {
    const random = g.rng(21);
    return {
      turtles: Array.from({ length: 3 }, (_, i) => ({
        size: 4.5 + random() * 2,
        y: 0.18 + i * 0.3 + random() * 0.06,
        speed: 1.4 + random() * 0.8,
        dir: i % 2 === 0 ? 1 : -1,
        phase: random() * 10,
        offset: random(),
      })),
      fish: Array.from({ length: 14 }, (_, i) => ({
        color: FISH[i % FISH.length],
        dx: random() * 10,
        dy: (random() - 0.5) * 7,
        phase: random() * 6,
      })),
      rays: Array.from({ length: 6 }, () => ({ x: random(), w: 2 + random() * 4, p: random() * 6 })),
    };
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    // Light shafts from the surface.
    for (const ray of s.rays) {
      const a = 0.05 + 0.04 * Math.sin(t * 0.5 + ray.p);
      const x0 = ray.x * cols + Math.sin(t * 0.2 + ray.p) * 4;
      for (let y = 0; y < rows * 0.7; y += 1) {
        const x = x0 + y * 0.35;
        for (let w = 0; w < ray.w; w++) if ((x + w + y) % 3 < 1) g.cell(x + w, y, `rgba(240,255,250,${a})`, " ");
      }
    }

    // A school of fish following a leader in a loose ribbon.
    const leadX = ((t * 4) % (cols + 40)) - 20;
    const leadY = rows * 0.62 + Math.sin(t * 0.6) * rows * 0.12;
    for (const f of s.fish) {
      const x = cols - (leadX - f.dx);
      const y = leadY + f.dy + Math.sin(t * 2 + f.phase) * 0.6;
      g.cell(x, y, f.color);
      g.cell(x + 1, y, f.color);
      g.cell(x + 2, y + (Math.sin(t * 8 + f.phase) > 0 ? 0 : 0), g.mix(f.color, "#000000", 0.2), "<");
    }

    for (const tu of s.turtles) {
      const span = cols + tu.size * 10;
      const travel = ((tu.offset * span + t * tu.speed) % span) - tu.size * 5;
      const x = tu.dir > 0 ? travel : cols - travel;
      const y = tu.y * rows + Math.sin(t * 0.4 + tu.phase) * 2;
      const heading = (tu.dir > 0 ? 0 : Math.PI) + Math.cos(t * 0.4 + tu.phase) * 0.12 * tu.dir;
      const stroke = Math.sin(t * 1.8 + tu.phase);
      const r = tu.size;
      g.shape(x, y, r * 2.2, heading, (lx, ly) => {
        // Front flippers sweep; back flippers paddle.
        for (const side of [-1, 1]) {
          const fx = lx - r * 0.35;
          const fy = ly * side - r * 0.75;
          const ang = 0.6 + stroke * 0.5;
          const along = fx * Math.cos(ang) + fy * Math.sin(ang);
          const across = -fx * Math.sin(ang) + fy * Math.cos(ang);
          if (along > -0.2 && along < r * 0.95 && Math.abs(across) < 0.55 + along * 0.08) {
            return along > r * 0.6 ? SKIN_DARK : SKIN;
          }
          const bx = lx + r * 0.7;
          const by = ly * side - r * 0.55;
          if (bx * bx + by * by * 2 < (r * 0.32) ** 2 * (1.2 + stroke * side * 0.3)) return SKIN;
        }
        // Head.
        const hx = lx - r * 1.15;
        if (hx * hx + ly * ly < (r * 0.36) ** 2) {
          if (hx > 0 && Math.abs(ly) > r * 0.12 && Math.abs(ly) < r * 0.3) return ["#2b2b22", "o"];
          return SKIN;
        }
        // Shell with scutes.
        const e = (lx * lx) / (r * r) + (ly * ly) / (r * 0.78) ** 2;
        if (e > 1) return null;
        if (e > 0.72) return SHELL_EDGE;
        const scute = (Math.floor(lx / (r * 0.4) + 10) + Math.floor(ly / (r * 0.4) + 10)) % 2;
        return scute ? SHELL : SHELL_LIGHT;
      });
    }
  },
});
