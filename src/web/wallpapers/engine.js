// Live ASCII wallpapers: the cell engine. From Zeus-Deus/t3code-wallpapers
// (https://github.com/Zeus-Deus/t3code-wallpapers), used under its MIT license:
//
//   MIT License
//   Copyright (c) 2026 Zeus-Deus
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify, merge,
//   publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
//   to whom the Software is furnished to do so, subject to the following conditions:
//   The above copyright notice and this permission notice shall be included in all copies or
//   substantial portions of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
//
// ox's scenes (scenes/*.js) are its own; src/wallpapers.js puts the engine and
// one scene into a page that the app shows behind itself.
// A tiny ASCII-cell renderer shared by every wallpaper. Each scene paints coloured cells on a
// character grid; the engine draws them as small tiles with a glyph on top, over a cached
// background, at a low frame rate. It pauses while hidden and holds still for reduced motion.
(function () {
  "use strict";

  const CELL_W = 17;
  const CELL_H = 20;
  const ASPECT = CELL_W / CELL_H; // multiply a vertical cell distance by this for round shapes
  const FONT = '600 12px ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });
  const backdrop = document.createElement("canvas");
  const bctx = backdrop.getContext("2d");

  // ---------- colour helpers ----------
  const rgbCache = new Map();
  function rgb(color) {
    let value = rgbCache.get(color);
    if (value) return value;
    const hex = color.replace("#", "");
    const full = hex.length === 3 ? hex.replace(/./g, "$&$&") : hex;
    const n = parseInt(full.slice(0, 6), 16);
    value = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(color, value);
    return value;
  }
  const toHex = (c) =>
    "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  function mix(a, b, amount) {
    const x = rgb(a);
    const y = rgb(b);
    return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * amount));
  }
  function alpha(color, a) {
    const c = rgb(color);
    return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  }
  const glyphCache = new Map();
  /** A glyph tone that reads on the tile: darker on light tiles, lighter on dark ones. */
  function glyphFor(fill) {
    let glyph = glyphCache.get(fill);
    if (glyph) return glyph;
    if (fill.startsWith("rgba")) {
      glyph = "rgba(255,255,255,0.18)";
    } else {
      const [r, g, b] = rgb(fill);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      glyph = lum > 0.55 ? mix(fill, "#000000", 0.32) : mix(fill, "#ffffff", 0.3);
    }
    glyphCache.set(fill, glyph);
    return glyph;
  }

  // ---------- randomness ----------
  function hash(x, y, s) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul((s | 0) + 1, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function rng(seed) {
    let a = seed >>> 0 || 1;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- the cell buffer ----------
  let cols = 0;
  let rows = 0;
  let fills = [];
  let chars = [];
  let touched = [];

  /** Paint one cell. Later paints win, so draw back to front. `ch` overrides the scene's glyph. */
  function cell(x, y, fill, ch) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= cols || y >= rows || !fill) return;
    const i = y * cols + x;
    if (fills[i] === undefined) touched.push(i);
    fills[i] = fill;
    chars[i] = ch;
  }

  /**
   * Rasterise a shape around (cx, cy) in cell units. `paint(lx, ly)` gets local coordinates in
   * cell widths (vertical already corrected for the cell aspect, then rotated by `angle`) and
   * returns a colour, `[colour, glyph]`, or nothing.
   */
  function shape(cx, cy, radius, angle, paint) {
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const ry = radius * ASPECT + 1;
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      if (y < 0 || y >= rows) continue;
      for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
        if (x < 0 || x >= cols) continue;
        const dx = x - cx;
        const dy = (y - cy) / ASPECT;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        const out = paint(lx, ly, x, y);
        if (!out) continue;
        if (typeof out === "string") cell(x, y, out);
        else cell(x, y, out[0], out[1]);
      }
    }
  }

  function disc(cx, cy, r, fill, ch) {
    shape(cx, cy, r, 0, (lx, ly) => (lx * lx + ly * ly <= r * r ? (ch ? [fill, ch] : fill) : null));
  }

  /**
   * Pixel art: rows of characters, each mapped through `palette` (missing or space = clear).
   * Centred on (cx, cy); `flip` mirrors it horizontally.
   */
  function sprite(art, palette, cx, cy, flip) {
    const h = art.length;
    const w = art.reduce((m, line) => Math.max(m, line.length), 0);
    const left = Math.round(cx - w / 2);
    const top = Math.round(cy - h / 2);
    for (let r = 0; r < h; r++) {
      const line = art[r];
      for (let c = 0; c < w; c++) {
        const key = line[flip ? w - 1 - c : c];
        const fill = key && palette[key];
        if (fill) cell(left + c, top + r, fill);
      }
    }
  }

  // ---------- scene lifecycle ----------
  let scene = null;
  let state = null;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let started = 0;
  let lastDraw = -Infinity;
  let lastT = 0;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const api = {
    CELL_W,
    CELL_H,
    ASPECT,
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    cell,
    shape,
    disc,
    sprite,
    mix,
    alpha,
    hash,
    rng,
  };

  function paintBackdrop() {
    backdrop.width = canvas.width;
    backdrop.height = canvas.height;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = scene.background;
    const gradient = bctx.createLinearGradient(0, 0, bg.angle === "diagonal" ? width : 0, height);
    for (const [offset, color] of bg.stops) gradient.addColorStop(offset, color);
    bctx.fillStyle = gradient;
    bctx.fillRect(0, 0, width, height);
    for (const glow of bg.glows || []) {
      const r = glow.r * Math.max(width, height);
      const radial = bctx.createRadialGradient(glow.x * width, glow.y * height, 0, glow.x * width, glow.y * height, r);
      radial.addColorStop(0, alpha(glow.color, glow.a ?? 0.35));
      radial.addColorStop(1, alpha(glow.color, 0));
      bctx.fillStyle = radial;
      bctx.fillRect(0, 0, width, height);
    }
    if (bg.dots) {
      bctx.fillStyle = bg.dots;
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++)
          if ((x + y) % 2 === 0) bctx.fillRect(x * CELL_W + CELL_W / 2 - 1, y * CELL_H + CELL_H / 2 - 1, 2, 2);
    }
  }

  function resize(redraw = true) {
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (nextDpr !== dpr) atlas.clear();
    dpr = nextDpr;
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const nextCols = Math.ceil(width / CELL_W);
    const nextRows = Math.ceil(height / CELL_H);
    const grew = nextCols !== cols || nextRows !== rows;
    cols = nextCols;
    rows = nextRows;
    fills = new Array(cols * rows);
    chars = new Array(cols * rows);
    touched = [];
    paintBackdrop();
    if (!redraw) return;
    if (grew && scene.resize) scene.resize(api, state);
    draw(lastT, 0);
  }

  function draw(t, dt) {
    for (const i of touched) {
      fills[i] = undefined;
      chars[i] = undefined;
    }
    touched = [];
    scene.frame(api, state, t, dt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(backdrop, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Tiles, then glyphs, so each pass changes canvas state as little as possible.
    for (const i of touched) {
      ctx.fillStyle = fills[i];
      ctx.fillRect((i % cols) * CELL_W + 1, Math.floor(i / cols) * CELL_H + 1, CELL_W - 2, CELL_H - 2);
    }
    // Glyphs come from a small atlas of pre-rendered characters; drawImage is far cheaper than
    // fillText for hundreds of cells a frame.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const set = scene.chars;
    const shimmer = Math.floor(t * (scene.shimmer ?? 0.6));
    for (const i of touched) {
      const x = i % cols;
      const y = Math.floor(i / cols);
      let ch = chars[i];
      if (ch === undefined) {
        const pick = hash(x, y, shimmer + Math.floor(hash(y, x, 7) * 9));
        ch = set[Math.floor(pick * set.length)];
      }
      if (ch === " " || ch === "") continue;
      const glyph = atlasGlyph(ch, glyphFor(fills[i]));
      ctx.drawImage(glyph, Math.round(x * CELL_W * dpr), Math.round(y * CELL_H * dpr));
    }
  }

  const atlas = new Map();
  function atlasGlyph(ch, color) {
    const key = ch + color;
    let image = atlas.get(key);
    if (image) return image;
    image = document.createElement("canvas");
    image.width = Math.ceil(CELL_W * dpr);
    image.height = Math.ceil(CELL_H * dpr);
    const g = image.getContext("2d");
    g.scale(dpr, dpr);
    g.font = FONT;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = color;
    g.fillText(ch, CELL_W / 2, CELL_H / 2 + 0.5);
    atlas.set(key, image);
    return image;
  }

  function loop(now) {
    if (!started) started = now;
    // Scenes are functions of time; starting mid-scene means nothing has to swim in first.
    const t = (scene.stillAt ?? 12) + (now - started) / 1000;
    const interval = 1000 / (scene.fps || 15);
    if (now - lastDraw >= interval) {
      const dt = Math.max(0, Math.min(0.25, t - lastT));
      lastDraw = now;
      lastT = t;
      draw(t, dt);
    }
    if (!reducedMotion.matches) requestAnimationFrame(loop);
  }

  window.Wall = {
    /** Average milliseconds per frame over `n` redraws; for tuning scenes. */
    bench(n = 100) {
      const start = performance.now();
      for (let k = 0; k < n; k++) draw(lastT + k / 15, 1 / 15);
      return (performance.now() - start) / n;
    },
    run(definition) {
      scene = definition;
      document.documentElement.style.background = definition.background.stops[0][1];
      resize(false);
      state = definition.init ? definition.init(api) : {};
      window.addEventListener("resize", () => resize());
      reducedMotion.addEventListener("change", () => {
        if (!reducedMotion.matches) {
          started = 0;
          requestAnimationFrame(loop);
        }
      });
      // A still frame mid-scene reads better than t=0 for reduced motion.
      lastT = definition.stillAt ?? 12;
      draw(lastT, 0);
      if (!reducedMotion.matches) requestAnimationFrame(loop);
    },
  };
})();
