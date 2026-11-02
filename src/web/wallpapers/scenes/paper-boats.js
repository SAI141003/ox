// From Zeus-Deus/t3code-wallpapers (https://github.com/Zeus-Deus/t3code-wallpapers), MIT; see engine.js.
// Paper Boats: folded boats bob down a calm canal, leaving rings; a few leaves ride along.
const PAPER = "#f4f1ea";
const FOLD = "#d9d4c8";
const SHADOW = "#a9b8b5";
const LEAVES = ["#e7893c", "#d4653a", "#f0b54a"];

Wall.run({
  fps: 14,
  chars: "%t:.",
  shimmer: 0.4,
  background: {
    stops: [
      [0, "#4b8a8c"],
      [1, "#2c6468"],
    ],
    angle: "diagonal",
    glows: [{ x: 0.2, y: 0.15, r: 0.5, color: "#bfe6e0", a: 0.22 }],
    dots: "rgba(230, 255, 250, 0.08)",
  },
  init(g) {
    const random = g.rng(9);
    return {
      boats: Array.from({ length: 5 }, () => ({
        x: random(),
        y: random(),
        size: 4.5 + random() * 2,
        speed: 0.8 + random() * 0.8,
        phase: random() * 10,
      })),
      leaves: Array.from({ length: 10 }, (_, i) => ({
        color: LEAVES[i % LEAVES.length],
        x: random(),
        y: random(),
        speed: 1 + random(),
        phase: random() * 6,
      })),
    };
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    // The current runs down and to the right.
    const flow = (item, speed) => {
      const span = cols + 30;
      const d = (((item.x * span + t * speed) % span) + span) % span;
      return [d - 15 + Math.sin(t * 0.3 + item.phase) * 2, item.y * rows + d * 0.2];
    };
    for (const leaf of s.leaves) {
      const [x, y] = flow(leaf, leaf.speed);
      g.cell(x, ((y % rows) + rows) % rows, leaf.color, "*");
    }
    for (const b of s.boats) {
      const [x, raw] = flow(b, b.speed);
      const y = ((raw % rows) + rows) % rows;
      // A ripple ring that widens and fades.
      const age = (t * 0.6 + b.phase) % 3;
      const ring = b.size * (1.3 + age * 0.9);
      const fade = 0.14 * (1 - age / 3);
      g.shape(x, y, ring + 1, 0, (lx, ly) => {
        const d = Math.hypot(lx, ly);
        return Math.abs(d - ring) < 0.5 ? `rgba(230,255,250,${fade.toFixed(3)})` : null;
      });
      const heading = 0.25 + Math.sin(t * 0.5 + b.phase) * 0.25;
      const r = b.size;
      // Shadow first, offset down-right.
      // Seen from above: a long hexagonal hull with the sail's triangle folded up the middle.
      const hullAt = (lx, ly) =>
        Math.abs(ly) <= r * 0.5 && Math.abs(lx) <= r * 1.5 - Math.max(0, Math.abs(ly) - r * 0.1) * 1.6;
      g.shape(x + 1, y + 1, r * 1.8, heading, (lx, ly) => (hullAt(lx, ly) ? SHADOW : null));
      g.shape(x, y, r * 1.8, heading, (lx, ly) => {
        if (!hullAt(lx, ly)) return null;
        const sail = Math.abs(lx) < r * 0.75 - Math.abs(ly) * 1.6 && ly < r * 0.15;
        if (sail) return lx < 0 ? PAPER : FOLD;
        return Math.abs(ly) < r * 0.12 ? [FOLD, "-"] : ly < 0 ? "#e9e5db" : "#cfc9bc";
      });
    }
  },
});
