// From Zeus-Deus/t3code-wallpapers (https://github.com/Zeus-Deus/t3code-wallpapers), MIT; see engine.js.
// Jellyfish: soft bells pulse upward through deep water, tentacles trailing behind.
const KINDS = [
  { bell: "#f2a7cf", rim: "#d77fb3", light: "#fbd3e8", tentacle: "#e79ac4" },
  { bell: "#b896e8", rim: "#9572cf", light: "#dccbf6", tentacle: "#a98ad9" },
  { bell: "#f5c4a0", rim: "#e29a72", light: "#fde3cf", tentacle: "#eab08c" },
];

Wall.run({
  fps: 15,
  chars: "$%t:.",
  background: {
    stops: [
      [0, "#0d3b74"],
      [0.55, "#0a2a57"],
      [1, "#06173a"],
    ],
    glows: [{ x: 0.5, y: -0.1, r: 0.6, color: "#3d8fe0", a: 0.35 }],
    dots: "rgba(160, 200, 255, 0.07)",
  },
  init(g) {
    const random = g.rng(3);
    return {
      jellies: Array.from({ length: 7 }, (_, i) => ({
        kind: KINDS[i % KINDS.length],
        x: 0.08 + random() * 0.84,
        y: random(),
        size: 3.4 + random() * 2.4,
        speed: 0.5 + random() * 0.6,
        phase: random() * 10,
        tentacles: 4 + Math.floor(random() * 3),
      })),
      bubbles: Array.from({ length: 30 }, () => ({ x: random(), y: random(), s: 1 + random() * 3 })),
    };
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    for (const b of s.bubbles) {
      const y = (((b.y * rows - t * b.s) % rows) + rows) % rows;
      g.cell(b.x * cols + Math.sin(t + b.y * 20) * 0.8, y, "rgba(190,225,255,0.16)", "o");
    }
    for (const j of s.jellies) {
      const span = rows + j.size * 6;
      // Rise in pulses: quick push, slow glide.
      const pulse = Math.sin(t * 1.6 + j.phase);
      const travel = t * j.speed * 1.6 + Math.sin(t * 1.6 + j.phase) * 0.9;
      const y = span - ((((j.y * span + travel * 3) % span) + span) % span) - j.size * 2;
      const x = j.x * cols + Math.sin(t * 0.25 + j.phase) * 3;
      const r = j.size * (1 + 0.12 * pulse);
      const h = j.size * (0.95 - 0.12 * pulse);

      // Tentacles sway after the bell.
      const length = Math.round(j.size * 2.6);
      for (let k = 0; k < j.tentacles; k++) {
        const base = x - r * 0.75 + (k / (j.tentacles - 1)) * r * 1.5;
        for (let step = 1; step <= length; step++) {
          const sway = Math.sin(t * 2 - step * 0.45 + k * 1.3 + j.phase) * (step / length) * 1.6;
          if ((step + k) % 4 === 3) continue;
          g.cell(base + sway, y + step, j.kind.tentacle);
        }
      }
      // Bell: a dome with a rim and a highlight.
      g.shape(x, y, r + 1, 0, (lx, ly) => {
        const vy = ly;
        if (vy > 0.4) return null;
        const d = (lx * lx) / (r * r) + (vy * vy) / (h * h);
        if (d > 1) return null;
        if (vy > -0.4) return j.kind.rim;
        if (lx < -r * 0.2 && vy < -h * 0.45 && d < 0.75) return j.kind.light;
        return j.kind.bell;
      });
    }
  },
});
