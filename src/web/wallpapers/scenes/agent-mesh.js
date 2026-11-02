// Agent Mesh: your agents as a slow constellation; gold pulses travel between
// them like messages, nodes glow when one arrives.
Wall.run({
  fps: 12,
  chars: ".:",
  shimmer: 0.3,
  background: {
    stops: [
      [0, "#060a18"],
      [1, "#0d1530"],
    ],
    glows: [
      { x: 0.3, y: 0.3, r: 0.5, color: "#3b6cff", a: 0.12 },
      { x: 0.8, y: 0.75, r: 0.4, color: "#ffb020", a: 0.07 },
    ],
  },
  init(g) {
    const random = g.rng(23);
    const nodes = Array.from({ length: 16 }, () => ({ x: 0.06 + random() * 0.88, y: 0.08 + random() * 0.84, p: random() * 10, gold: random() < 0.3 }));
    const edges = [];
    for (let i = 0; i < nodes.length; i++) {
      const near = nodes.map((n, j) => [Math.hypot(n.x - nodes[i].x, n.y - nodes[i].y), j]).filter(([, j]) => j !== i).sort((a, b) => a[0] - b[0]).slice(0, 2);
      for (const [, j] of near) if (!edges.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) edges.push([i, j, random() * 10, 0.08 + random() * 0.1]);
    }
    return { nodes, edges };
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    const pos = (n) => [n.x * cols + Math.sin(t * 0.07 + n.p) * 2, n.y * rows + Math.cos(t * 0.05 + n.p) * 1.2];
    const arrivals = new Set();
    for (const [a, b, p, speed] of s.edges) {
      const [x1, y1] = pos(s.nodes[a]);
      const [x2, y2] = pos(s.nodes[b]);
      const steps = Math.max(2, Math.ceil(Math.hypot(x2 - x1, (y2 - y1) / g.ASPECT)));
      for (let i = 1; i < steps; i += 2) g.cell(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, "rgba(120,150,255,0.13)", "·");
      // A message on its way, and the node it lands on lights up.
      const u = (t * speed + p) % 1;
      const fwd = Math.floor(t * speed + p) % 2 === 0;
      const k = fwd ? u : 1 - u;
      g.cell(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k, "#ffc24a", "•");
      if (u > 0.93) arrivals.add(fwd ? b : a);
    }
    s.nodes.forEach((n, i) => {
      const [x, y] = pos(n);
      const glow = arrivals.has(i) ? 1 : 0.55 + 0.25 * Math.sin(t * 1.1 + n.p);
      if (arrivals.has(i)) g.disc(x, y, 1.6, "rgba(255,194,74,0.25)", " ");
      g.disc(x, y, 0.9, g.alpha(n.gold ? "#ffb020" : "#8fb0ff", glow), "o");
    });
  },
});
