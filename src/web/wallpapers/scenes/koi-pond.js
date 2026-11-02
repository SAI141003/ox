// From Zeus-Deus/t3code-wallpapers (https://github.com/Zeus-Deus/t3code-wallpapers), MIT; see engine.js.
// Koi Pond: koi wind lazily between lily pads; their bodies follow the path they swim.
const PATTERNS = [
  ["#f2f2ea", "#e8662c", "#f2f2ea", "#e8662c", "#e8662c", "#f2f2ea", "#f2f2ea"],
  ["#e8662c", "#e8662c", "#f6a23c", "#e8662c", "#f6a23c", "#e8662c", "#e8662c"],
  ["#f2f2ea", "#f2f2ea", "#c93a2e", "#f2f2ea", "#f2f2ea", "#c93a2e", "#f2f2ea"],
  ["#f6c445", "#f6c445", "#f2f2ea", "#f6c445", "#f6c445", "#f2f2ea", "#f6c445"],
];
const PAD = "#4f9a3f";
const PAD_DARK = "#3a7d31";
const BLOSSOM = "#f3a6c0";

Wall.run({
  fps: 15,
  chars: "$%tS:",
  background: {
    stops: [
      [0, "#2f7a6c"],
      [1, "#1d5c55"],
    ],
    glows: [
      { x: 0.25, y: 0.2, r: 0.5, color: "#8fd3b8", a: 0.22 },
      { x: 0.8, y: 0.85, r: 0.4, color: "#0d3b3a", a: 0.5 },
    ],
    dots: "rgba(220, 255, 240, 0.07)",
  },
  init(g) {
    const random = g.rng(5);
    return {
      koi: PATTERNS.concat(PATTERNS.slice(0, 2)).map((pattern, i) => ({
        pattern,
        ax: 0.32 + random() * 0.12,
        ay: 0.3 + random() * 0.12,
        fx: 0.008 + random() * 0.006,
        fy: 0.011 + random() * 0.008,
        phase: i * 1.7 + random() * 3,
        cx: 0.3 + random() * 0.4,
        cy: 0.3 + random() * 0.4,
        size: 1.5 + random() * 0.5,
      })),
      pads: Array.from({ length: 9 }, () => ({
        x: random(),
        y: random(),
        r: 2.2 + random() * 2.2,
        notch: random() * Math.PI * 2,
        bloom: random() < 0.35,
      })),
      glints: Array.from({ length: 40 }, () => ({ x: random(), y: random(), p: random() * 10 })),
    };
  },
  frame(g, s, t) {
    const { cols, rows } = g;
    for (const glint of s.glints) {
      const a = Math.sin(t * 1.4 + glint.p);
      if (a > 0.6) g.cell(glint.x * cols, glint.y * rows, "rgba(200,255,235,0.14)", "~");
    }

    const path = (k, time) => [
      cols * (k.cx + k.ax * Math.sin(time * k.fx * 6.283 + k.phase)),
      rows * (k.cy + k.ay * Math.sin(time * k.fy * 6.283 + k.phase * 1.3)),
    ];
    for (const k of s.koi) {
      const segments = 14;
      // Tail first, head last, so the head paints over the body.
      for (let i = segments; i >= 0; i--) {
        const lag = 0.5;
        const [x, y] = path(k, t - i * lag);
        const [nx, ny] = path(k, t - i * lag + 0.2);
        const heading = Math.atan2((ny - y) / g.ASPECT, nx - x);
        const u = i / segments;
        const body = k.size * (u < 0.15 ? 1.2 + u * 2 : 1.5 * (1 - u) + 0.35);
        const color = k.pattern[Math.min(k.pattern.length - 1, Math.floor(u * k.pattern.length))];
        if (i === segments) {
          // Tail fan, waving.
          const wave = Math.sin(t * 5 + k.phase) * 0.6;
          g.shape(x, y, 2.6 * k.size, heading + wave, (lx, ly) =>
            lx < 0 && lx > -2.4 * k.size && Math.abs(ly) < -lx * 0.75 ? g.mix(color, "#ffffff", 0.15) : null,
          );
          continue;
        }
        if (i === 3) {
          // Pectoral fins.
          g.shape(x, y, 2.6 * k.size, heading, (lx, ly) =>
            Math.abs(ly) > body && Math.abs(ly) < body + 1.3 * k.size && lx < 0.5 && lx > -1.4
              ? "#f5ede0"
              : null,
          );
        }
        g.shape(x, y, body + 0.6, heading, (lx, ly) => {
          if (lx * lx + ly * ly > body * body) return null;
          if (i === 0 && lx > body * 0.2 && Math.abs(ly) > body * 0.35 && Math.abs(ly) < body * 0.8)
            return ["#1c1c1c", "o"];
          return color;
        });
      }
    }

    for (const pad of s.pads) {
      const x = pad.x * cols + Math.sin(t * 0.15 + pad.notch) * 0.8;
      const y = pad.y * rows;
      g.shape(x, y, pad.r, pad.notch + Math.sin(t * 0.1 + pad.x * 5) * 0.15, (lx, ly) => {
        const d = Math.hypot(lx, ly);
        if (d > pad.r) return null;
        const a = Math.atan2(ly, lx);
        if (a > -0.35 && a < 0.35 && d > pad.r * 0.15) return null; // the notch
        return d > pad.r * 0.75 ? PAD_DARK : PAD;
      });
      if (pad.bloom) g.disc(x, y, 0.9, BLOSSOM, "*");
    }
  },
});
