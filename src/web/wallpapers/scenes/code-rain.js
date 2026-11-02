// Code Rain: sparse amber code trickling down, the way an agent's work scrolls by.
const GLYPHS = "{}()<>=;:/*+-[]01ox#$&";

Wall.run({
  fps: 12,
  chars: GLYPHS,
  shimmer: 1.2,
  background: {
    stops: [
      [0, "#050507"],
      [1, "#0c0a07"],
    ],
    glows: [{ x: 0.5, y: 0, r: 0.6, color: "#ffb020", a: 0.06 }],
  },
  init(g) {
    const random = g.rng(17);
    const drops = [];
    for (let c = 0; c < 400; c++) if (random() < 0.33) drops.push({ c, speed: 3 + random() * 6, p: random() * 200, len: 6 + Math.floor(random() * 12) });
    return { drops };
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    for (const d of s.drops) {
      if (d.c >= cols) continue;
      const head = ((t * d.speed + d.p) % (rows + d.len + 10)) - 4;
      for (let i = 0; i < d.len; i++) {
        const y = Math.floor(head) - i;
        if (y < 0 || y >= rows) continue;
        const ch = GLYPHS[Math.floor(g.hash(d.c, y, Math.floor(t * 2) + i) * GLYPHS.length)];
        if (i === 0) g.cell(d.c, y, "#ffd27a", ch);
        else g.cell(d.c, y, g.alpha("#ffb020", 0.5 * (1 - i / d.len)), ch);
      }
    }
  },
});
