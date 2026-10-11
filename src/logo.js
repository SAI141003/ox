// The colour helpers this module needs are local (they gate on the destination
// stream); src/ui.js's c.* utilities gate on stdout and no longer apply here.

// The ox head, rasterized from geometry: cubic-bezier tapered-stroke horns
// mirrored about the centreline, skull + muzzle ellipses unioned, eyes and
// nostrils subtracted. One connected component, zero mirror mismatches, and
// the eyes/nostrils are literal spaces. Leading indentation is the art;
// trailing whitespace is trimmed on purpose.
export const LOGO = [
  '  █                                        █',
  '  ██                                      ██',
  '   ███                                  ███',
  '    ████                              ████',
  '     █████       ████████████       █████',
  '       ██████   ██████████████   ██████',
  '         █████ ████████████████ █████',
  '           ████████████████████████',
  '            ██████  ██████  ██████',
  '             ████   ██████   ████',
  '              ████  ██████  ████',
  '               ████████████████',
  '                 ███  ██  ███',
  '                 ███  ██  ███',
  '                   ████████',
];

// Same mark, compact enough for narrow terminals.
export const LOGO_SMALL = [
  ' ██                              ██',
  ' ███                            ███',
  '  █████                      █████',
  '    ██████    ████████    ██████',
  '     ██████████████████████████',
  '       ██████████████████████',
  '         ██████████████████',
  '          ████  ████  ████',
  '           ███  ████  ███',
  '            ███ ████ ███',
  '            ███  ██  ███',
  '             ██  ██  ██',
];

const TAGLINE = 'the featherweight coding agent';

// Three acts at ~45ms a frame: a ~32-frame swarm convergence, an 8-frame
// ping-pong shine pulse across the settled mark, then the wordmark typing
// itself out a few glyphs a frame with a blinking block cursor. Still inside
// the 2.5s ceiling this needs because it runs on every interactive start
// (~45 intervals x 45ms ≈ 2.0s worst case).
const FRAMES = 32;
const SHINE_FRAMES = 8;
const FRAME_MS = 45;
// The typewriter act: how many wordmark glyphs land per frame, and how many
// blank cursor-blink frames hold on the finished line before the REPL takes
// over. CHUNK=3 keeps the wordmark act to ~6 frames; HOLD=2 gives the eye a
// beat to land without stretching the intro past its budget.
const TYPE_CHUNK = 3;
const TYPE_HOLD = 2;
const BLOCK = '█';
const CLEAR = '\x1b[H\x1b[2J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K';

// How far past the final silhouette the cloud opens before it converges. The
// spawn span is 2.2x the art box; the mark is 44x15, and keeping the tall axis
// nearer 1.6x spreads the swarm well past the logo without pushing a standard
// 24-row terminal into a scroll.
const SPREAD_X = 2.2;
const SPREAD_Y = 1.6;

// How much of the timeline a single particle lags by at the extreme.
const STAGGER = 0.45;

// In-flight particles ride a sine wobble perpendicular to their travel so the
// cloud reads as alive rather than sliding on rails. Kept small (about two
// cells at peak) so the swarm visibly shimmers without ever scattering past
// the frame the settled mark needs.
const WOBBLE = 2.2;

// A particle that is still far from its target is drawn as a scatter dot rather
// than as the glyph it will end up being, and only snaps to its real character
// over the last stretch of its travel. That is what makes a frame read as a
// swarm forming the logo instead of the logo wobbling into place. Two dot
// sizes fake depth: the far half of the cloud reads smaller and thinner.
const SCATTER = '\u00b7';
const SCATTER_FAR = '\u02d9';
const SNAP_FROM = 0.5;

// A settled glyph can twinkle — briefly lean one step toward white — without
// ever dropping out of the silhouette. Kept tiny (a few percent of settled
// glyphs per frame) so the mark reads solid, not flickery.
const TWINKLE_RATE = 0.06;

// Gradient stops, in RGB, for the cyan -> violet -> magenta sweep. The middle
// stop earns its keep: a straight cyan -> magenta ramp drags green down while
// blue climbs, so the midpoint lands on a pale, desaturated lavender whose
// lightness peaks near 78% - and that peak sits on the middle rows, exactly
// where the eyes and nostrils are cut out of the silhouette, so the mark
// washed out through its own face. Routing the sweep through a violet keeps
// the mid rows saturated and under 73% lightness, so the negative space reads.
//
// Brand ramp (shared with OX Island): ivory at the horn tips, toffee hide
// through the face, deep hide at the muzzle. Mid-row luma ~0.69, so the
// eye/nostril negative space still reads.
const GRAD_FROM = [255, 246, 230]; // #FFF6E6 horn
const GRAD_MID = [233, 166, 107]; // #E9A66B hide
const GRAD_TO = [189, 113, 59]; // #BD713B hide shade

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Deterministic enough for a demo, cheap, and seedable for tests.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function linesFor(small) {
  // Copy so callers can never mutate the exported art.
  return (small ? LOGO_SMALL : LOGO).map((line) => line.replace(/[ \t]+$/, ''));
}

export function logoWidth(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  return arr.reduce((max, line) => Math.max(max, String(line ?? '').length), 0);
}

function rgbEscape(r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function blend(t) {
  const k = clamp(t, 0, 1);
  // Two half-ramps meeting at GRAD_MID. Still one blend() per row, so this is
  // no more work per rendered frame than the two-stop ramp it replaces.
  const [a, b, u] = k < 0.5
    ? [GRAD_FROM, GRAD_MID, k * 2]
    : [GRAD_MID, GRAD_TO, (k - 0.5) * 2];
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

function gradientText(text, t, brightness = 1) {
  const [r, g, b] = blend(t);
  const fade = clamp(brightness, 0, 1);
  const s = rgbEscape(Math.round(r * fade), Math.round(g * fade), Math.round(b * fade));
  return `${s}${text}\x1b[39m`;
}

// A post-convergence shine: a soft band sweeps left to right across the
// settled mark, lifting glyphs toward white at its centre. Pure and exported
// for tests. The sweep never moves a glyph, only its brightness; the p=1 edge
// and the paint-off path both return exactly renderLogo() so the handoff is
// invisible.
export function renderShineFrame({ small = false, progress = 1, color = true, stream = process.stdout } = {}) {
  const lines = linesFor(small);
  if (!colorsOn(color, stream)) return lines.join('\n');
  const p = clamp(Number(progress) || 0, 0, 1);
  // At the far edge the band has fully passed: hand back the plain logo so
  // the last shine frame is byte-identical to renderLogo().
  if (p >= 1) return renderLogo({ small, color, stream });
  const artW = Math.max(logoWidth(lines), 1);
  const last = Math.max(lines.length - 1, 1);
  // Centre travels one full width plus soft margins; brightness is a
  // gaussian-ish falloff over ~8 columns, peak +90, floored at 255.
  const bandX = p * (artW + 8) - 4;
  return lines.map((line, y) => {
    const t = y / last;
    const [r, g, b] = blend(t);
    if (line.length === 0) return gradientText(line, t);
    // Brightness varies per column, so paint cell-by-cell; every cell keeps
    // the row's own gradient colour, lifted by the band.
    let out = '';
    for (let x = 0; x < line.length; x++) {
      const d = Math.abs(x - bandX);
      const lift = Math.exp(-(d * d) / 8) * 90;
      const at = (v) => Math.round(clamp(v + lift, 0, 255));
      out += `${rgbEscape(at(r), at(g), at(b))}${line[x]}${RESET_FG}`;
    }
    return out;
  }).join('\n');
}

// Act 3: the wordmark types itself out under the settled mark, a few glyphs
// per frame, with a block cursor that blinks on the finished line. Pure and
// exported for tests. `shown` counts plain glyphs of the wordmark line
// (`ox <version> — <tagline>`); the logo rows above never move, and the
// cursor is appended raw (never counted as a glyph) so frames stay whole
// lines and the final hold frame hands off cleanly to banner().
export function renderTypeFrame({ version = null, shown = 0, cursor = true, color = true, stream = process.stdout } = {}) {
  const paint = colorsOn(color, stream);
  const logo = renderLogo({ color, stream }).split('\n');
  const line = wordmarkLine({ version, color, stream });
  const plain = stripEscapes(line);
  const n = clamp(Math.round(Number(shown) || 0), 0, plain.length);
  let cut = '';
  if (n > 0) {
    // Slice the painted line to the first n visible glyphs: walk it keeping
    // escape runs whole, counting only printable characters.
    let seen = 0;
    for (let i = 0; i < line.length && seen < n;) {
      if (line[i] === '\x1b') {
        const m = /\x1b\[[0-9;]*m/.exec(line.slice(i));
        const seq = m ? m[0] : line[i];
        cut += seq;
        i += seq.length;
      } else {
        cut += line[i];
        seen += 1;
        i += 1;
      }
    }
    if (paint) cut += RESET_ALL;
  }
  const caret = cursor ? (paint ? `${rgbEscape(...GRAD_TO)}${BLOCK}${RESET_FG}` : BLOCK) : '';
  return [...logo, '', cut + caret].join('\n');
}

// Total wordmark glyphs a typewriter run must cover (cursor excluded), so
// animateLogo can size its frame loop without duplicating the layout.
export function typeTotal({ version = null } = {}) {
  return stripEscapes(wordmarkLine({ version, color: false })).length;
}

function colorsOn(color, stream = process.stdout) {
  // The gate reads the stream the art is ABOUT TO BE WRITTEN TO, not always
  // stdout: the `ox acp server` banner goes to stderr while stdout carries
  // JSON-RPC (never a TTY under an editor), so keying off stdout left the mark
  // permanently plain in the one place a human actually watches it — and
  // conversely `ox acp server 2>log` from a real terminal would have sprayed
  // escapes into the log file. NO_COLOR still wins over any stream.
  return Boolean(color) && Boolean(stream?.isTTY) && !process.env.NO_COLOR;
}

export function isInteractive() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !process.env.OX_NO_ANIM;
}

export function renderLogo({ small = false, color = true, stream = process.stdout } = {}) {
  const lines = linesFor(small);
  if (!colorsOn(color, stream)) return lines.join('\n');
  // The gradient is keyed to the art's own line count, not a baked-in number.
  const last = Math.max(lines.length - 1, 1);
  return lines.map((line, i) => gradientText(line, i / last)).join('\n');
}

// c.bold/c.dim in src/ui.js gate on process.stdout.isTTY, which is the wrong
// stream for a banner rendered for `stream` (stderr on the acp path). These two
// helpers apply the same SGR pairs under the banner's own gate, so the wordmark
// keeps its bold/dim exactly when the mark keeps its gradient — same bytes as
// c.bold/c.dim whenever stdout is the destination.
const wordmarkBold = (s, on) => (on ? `\x1b[1m${s}\x1b[22m` : s);
const wordmarkDim = (s, on) => (on ? `\x1b[2m${s}\x1b[22m` : s);

export function banner({ small = false, color = true, version = null, stream = process.stdout } = {}) {
  const v = version == null || version === '' ? '' : String(version).replace(/^v/i, '');
  // Wordmark reads name, tagline, version: `ox · the featherweight coding
  // agent · v0.1.0`. The bare `ox ${VERSION}` line is deliberately NOT in here —
  // printVersion() in src/cli.js appends it as its own line on a TTY, which is
  // what keeps the piped `ox 0.1.0` byte-identical for tests and CI.
  const name = 'ox';
  const rest = ` · ${TAGLINE}${v ? ` · v${v}` : ''}`;
  const painted = colorsOn(color, stream);
  if (!painted) {
    return `${renderLogo({ small, color: false, stream })}\n\n${name}${rest}`;
  }
  // The wordmark wears the same cyan the gradient starts on. c.cyan is the
  // legacy 8-bit SGR 36, which most terminals render as a dull teal that reads
  // as a different, older palette sitting under a 24-bit neon mark.
  return `${renderLogo({ small, color: true, stream })}\n\n${wordmarkBold(rgbEscape(...GRAD_FROM) + name + '\x1b[39m', true)}${wordmarkDim(rest, true)}`;
}

// Every non-space glyph in the logo becomes one particle with that glyph as its target.
function targetCells(lines) {
  const cells = [];
  lines.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      const ch = line[x];
      if (ch === ' ' || ch === '\t') continue;
      cells.push({ x, y, ch, t: lines.length > 1 ? y / (lines.length - 1) : 0 });
    }
  });
  return cells;
}

// Particle state for a seed. Pure: same seed and logo always give the same
// swarm, which is what keeps renderSwarmFrame deterministic under a fixed seed.
// Two seeded PRNG streams, one per property, so the draw order stays put as the
// constants are retuned - tuning the spread must not reshuffle the stagger.
function buildParticles({ lines, seed }) {
  const artW = Math.max(logoWidth(lines), 1);
  const artH = lines.length;
  const n = Math.max(targetCells(lines).length, 1);
  const base = seed == null ? Date.now() : Number(seed);
  const rnd = mulberry32(base);
  // Second stream, so the stagger jitter is independent of the spawn draw order.
  const jitterRnd = mulberry32((base ^ 0x9e3779b9) >>> 0);

  return targetCells(lines).map((cell, i) => {
    const z = rnd();
    // Stagger blends the particle's index with its depth, so the cloud flows in
    // as a visible front instead of arriving as one rigid block.
    const jitter = jitterRnd();
    // Per-particle wobble phase, derived from the index (not the RNG stream)
    // so retuning the motion never reshuffles the stagger draws the tests pin.
    const phase = (i / Math.max(n - 1, 1)) * Math.PI * 2;
    return {
      ...cell,
      z,
      index: i,
      phase,
      delay: clamp(STAGGER * ((i / (n - 1)) * 0.6 + z * 0.3 + jitter * 0.1), 0, STAGGER),
      // Spawn spans reach past the art box on both sides so the swarm visibly
      // opens out beyond the silhouette it is about to become.
      sx: clamp(Math.round(cell.x + (rnd() * 2 - 1) * artW * (SPREAD_X - 1) / 2), 0, Math.round(artW * SPREAD_X) - 1),
      sy: clamp(Math.round(cell.y + (rnd() * 2 - 1) * artH * (SPREAD_Y - 1) / 2), 0, Math.round(artH * SPREAD_Y) - 1),
    };
  });
}

// One particle's state at a point in the timeline. arrival is 0 while it is
// still dispersed and 1 once it has landed; far particles read as SCATTER and
// only take on their real character over the last stretch of travel. In flight
// each particle also rides a small sine wobble perpendicular to its travel, so
// the cloud shimmers instead of sliding on rails — the wobble fades to zero on
// landing, so the settled frame is untouched.
function place(p, progress) {
  const t = clamp((progress - p.delay) / Math.max(1e-6, 1 - p.delay), 0, 1);
  // A soft exponent rather than the cubic ease-out the old swarm used. The
  // cubic put ~88% of the travel behind us by the halfway frame, so the mark
  // read as already parked and twitching. 1.6 leaves the cloud visibly moving
  // from the first frame (an ease-in start reads as a hitch before the motion
  // starts) while still easing the swarm in as it assembles.
  const eased = 1 - Math.pow(1 - t, 1.6);
  // Sine wobble perpendicular to travel: full strength mid-flight, gone at
  // both ends so spawn and landing positions stay exact (and arrival, which
  // is eased, still hits exactly 0/1 at the ends).
  const wob = Math.sin(t * Math.PI * 2 + p.phase) * WOBBLE * Math.sin(t * Math.PI);
  const dx = p.x - p.sx;
  const dy = p.y - p.sy;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: p.sx + dx * eased + (-dy / len) * wob,
    y: p.sy + dy * eased + (dx / len) * wob,
    arrival: eased,
  };
}

// Rebuilds a run of line `y` as escape-wrapped colour, then trims the padding
// the swarm grid added. Spaces are absorbed into the run they sit in and are
// trimmed off the end, so a settled row collapses to exactly the static logo's
// line - that is what keeps the final frame byte-identical to renderLogo().
function composeRow(grid, y, left, width, color) {
  const pieces = [];
  let run = null;
  let pending = '';
  for (let i = 0; i < width; i++) {
    const cell = grid[y][left + i];
    if (cell.ch === ' ') {
      // Hold the gap open, then decide from the next colour that lands: if it
      // continues the open run the space belongs to it, otherwise it leads the
      // next one. Either way the space survives, so columns never slide.
      if (run) run.chars += ' ';
      else pending += ' ';
      continue;
    }
    if (run && run.r === cell.r && run.g === cell.g && run.b === cell.b) {
      run.chars += cell.ch;
      pending = '';
      continue;
    }
    if (run) pieces.push(run);
    run = { r: cell.r, g: cell.g, b: cell.b, chars: pending + cell.ch };
    pending = '';
  }
  if (run) pieces.push(run);
  // Only the row's own trailing padding goes. Trimming every run ate the gap
  // before a colour change and slid those columns left.
  const tail = pieces[pieces.length - 1];
  if (tail) tail.chars = tail.chars.replace(/ +$/, '');
  if (!color) return pieces.map((piece) => piece.chars).join('');
  return pieces
    .map((piece) => `${rgbEscape(piece.r, piece.g, piece.b)}${piece.chars}\x1b[39m`)
    .join('');
}

// Pure frame renderer: no terminal writes, no side effects, so a single frame of
// the swarm can be inspected and tested without a pty. Refactored out of
// animateLogo so the render logic exists exactly once.
export function renderSwarmFrame({ small = false, progress = 1, seed = null, color = true } = {}) {
  const lines = linesFor(small);
  const paint = colorsOn(color);
  const artW = Math.max(logoWidth(lines), 1);
  const artH = lines.length;
  const particles = buildParticles({ lines, seed });
  const swarmW = Math.max(Math.round(artW * SPREAD_X), artW + 1);
  const swarmH = Math.max(Math.round(artH * SPREAD_Y), artH + 1);
  const p = clamp(Number(progress) || 0, 0, 1);

  const grid = Array.from({ length: swarmH }, () =>
    Array.from({ length: swarmW }, () => ({ ch: ' ', r: 0, g: 0, b: 0 })));

  // Far particles first so near ones paint over them: low z is near, solid and
  // leading; high z is dimmed and trails in.
  const ordered = particles.slice().sort((a, b) => b.z - a.z);
  for (const q of ordered) {
    const at = place(q, p);
    const x = clamp(Math.round(at.x), 0, swarmW - 1);
    const y = clamp(Math.round(at.y), 0, swarmH - 1);
    // Reads as a particle while it is in flight, as the mark once it arrives.
    // Far particles read as a smaller dot, so the cloud gets real depth.
    const ch = at.arrival >= SNAP_FROM ? q.ch : (q.z > 0.5 ? SCATTER_FAR : SCATTER);
    // Dim by depth on the way in, full brightness on landing, so a settled
    // frame is exactly renderLogo() rather than a slightly darker copy of it.
    // A settled glyph can twinkle: a small deterministic fraction leans one
    // step toward white for the frame. The gate hashes the particle index
    // with the timeline position, so there is no RNG draw to keep stable —
    // the stagger draws (and the seeded-frame test) never see it.
    const frameIdx = Math.round(p * 1000);
    const tw = Math.imul(q.index + 1, 2654435761) ^ Math.imul(frameIdx + 1, 40503);
    // The settled frame (p === 1) must be byte-identical to renderLogo(), so
    // twinkle never fires once the swarm has parked. It only applies on the
    // frames that are still in flight, where a deterministic flicker reads as
    // life without ever moving the final mark.
    const twinkle = p < 1 && at.arrival >= 1 && ((tw >>> 0) % 100) < Math.round(TWINKLE_RATE * 100);
    const dim = 0.3 + 0.7 * (1 - q.z);
    const fade = dim + (1 - dim) * at.arrival;
    // Landing sparkle: a half-sine brightness swell over the last fifth of
    // travel so arrivals crackle instead of fading in. It settles back to
    // exactly the gradient at arrival 1 (sin(pi) = 0), keeping the mark
    // identical, and never fires on settled glyphs.
    const spark = at.arrival >= 0.8 && at.arrival < 1
      ? 1 + 0.45 * Math.sin(((at.arrival - 0.8) / 0.2) * Math.PI)
      : 1;
    const lift = twinkle ? 60 : 0;
    const [r, g, b] = blend(q.t);
    const atc = (v) => Math.round(clamp(v * fade * spark + lift, 0, 255));
    grid[y][x] = { ch, r: atc(r), g: atc(g), b: atc(b) };
  }

  // Always keep the art box in frame and take only the swarm's own extra reach,
  // so nothing is drawn mid-flight and the settled frame is just the logo.
  let minX = 0;
  let minY = 0;
  let maxX = artW - 1;
  let maxY = artH - 1;
  for (const q of particles) {
    const at = place(q, p);
    const x = clamp(Math.round(at.x), 0, swarmW - 1);
    const y = clamp(Math.round(at.y), 0, swarmH - 1);
    if (x < minX) minX = x;
    else if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    else if (y > maxY) maxY = y;
  }
  const width = maxX - minX + 1;
  const rows = [];
  for (let y = minY; y <= maxY; y++) rows.push(composeRow(grid, y, minX, width, paint));
  return rows;
}

// ---------------------------------------------------------------------------
// The charge: the launch moment shared with OX Island. A small ox charges in
// from the left, hits a pane of glass at centre, the glass shatters into
// shards, and the full mark resolves where the pane was. ~1.7 s at 45 ms.
// ---------------------------------------------------------------------------

export const CHARGE_SECONDS = 1.7;
const IMPACT_AT = 0.7;
const MINI_OX = [
  '▀▄      ▄▀',
  ' ▀█▄▄▄▄█▀ ',
  '  █▀██▀█  ',
  '  ▀█▄▄█▀  ',
  '   ▀██▀   ',
];
const SHARD_GLYPHS = ['◢', '◣', '◤', '◥', '▴', '◆', '·', '*'];
const HORN = [255, 246, 230];
const HIDE = [233, 166, 107];
const GLASS = [190, 225, 245];

function easeIn3(x) {
  return x * x * x;
}
function easeOutExpo(x) {
  return x >= 1 ? 1 : 1 - 2 ** (-10 * x);
}

/**
 * One frame of the charge at time t (seconds) as an array of lines. Pure and
 * deterministic for a seed. At t >= CHARGE_SECONDS it returns exactly
 * renderLogo(), so the handoff to the banner is seamless.
 */
export function renderChargeFrame({ small = false, t = 0, seed = 7, color = true } = {}) {
  if (t >= CHARGE_SECONDS) return renderLogo({ small, color }).split('\n');
  const art = linesFor(small);
  const W = logoWidth(art);
  const H = art.length;
  const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: ' ', r: 0, g: 0, b: 0 })));
  const put = (x, y, ch, [r, g, b], k = 1) => {
    x = Math.round(x);
    y = Math.round(y);
    if (y < 0 || y >= H || x < 0 || x >= W) return;
    const f = clamp(k, 0, 1);
    grid[y][x] = { ch, r: Math.round(r * f), g: Math.round(g * f), b: Math.round(b * f) };
  };
  const px = Math.floor(W / 2);
  const mid = Math.floor(H / 2);
  const since = t - IMPACT_AT;

  // The pane, intact until the hit.
  if (since < 0) {
    const glint = Math.floor((t / IMPACT_AT) * H);
    for (let y = 0; y < H; y++) put(px, y, '│', GLASS, y === glint ? 0.95 : 0.45);
  }

  // Cracks race out from the hit point for a few frames.
  if (since >= 0 && since < 0.25) {
    const rand = mulberry32(seed ^ 0x51ab);
    const grow = easeOutExpo(clamp(since / 0.1, 0, 1));
    const fade = 1 - clamp((since - 0.1) / 0.15, 0, 1);
    for (let ray = 0; ray < 8; ray++) {
      const a = (ray / 8) * Math.PI * 2 + (rand() - 0.5) * 0.4;
      const len = Math.round((3 + rand() * 4) * grow);
      for (let s = 1; s <= len; s++) {
        const x = px + Math.cos(a) * s * 2;
        const y = mid + Math.sin(a) * s;
        const ch = Math.abs(Math.sin(a)) < 0.38 ? '─' : Math.abs(Math.cos(a)) < 0.38 ? '│' : Math.sin(a) * Math.cos(a) > 0 ? '╲' : '╱';
        put(x, y, ch, [255, 255, 255], fade);
      }
    }
  }

  // Shards: blown forward and outward, falling, fading.
  if (since >= 0 && since < 0.6) {
    const rand = mulberry32(seed);
    for (let i = 0; i < 26; i++) {
      const vx = 8 + rand() * 34; // cells / s, mostly forward
      const vy = (rand() - 0.5) * 22;
      const back = rand() < 0.25 ? -1 : 1;
      const glyph = SHARD_GLYPHS[Math.floor(rand() * SHARD_GLYPHS.length)];
      const x = px + back * vx * since * 2;
      const y = mid + vy * since + 0.5 * 28 * since * since;
      put(x, y, glyph, GLASS, 1 - since / 0.6);
    }
  }

  // The mini ox: charges (ease-in), recoils, then gives way to the full mark.
  // Gone before the mark resolves, so it never shows through the eye holes.
  const oxAlpha = t < 0.95 ? 1 : 1 - clamp((t - 0.95) / 0.1, 0, 1);
  if (oxAlpha > 0) {
    const k = since < 0 ? easeIn3(clamp((t - 0.1) / (IMPACT_AT - 0.1), 0, 1)) : 1;
    const recoil = since >= 0 ? Math.round(2 * (1 - easeOutExpo(clamp(since / 0.4, 0, 1)))) : 0;
    const ox0 = Math.round(-10 + (px - 10 + 10) * k) - recoil;
    const oy = mid - 2;
    MINI_OX.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch !== ' ') put(ox0 + c, oy + r, ch, r === 0 ? HORN : HIDE, oxAlpha);
      });
    });
    // Dust trail while charging.
    if (since < 0.15 && t > 0.2) for (let d = 1; d <= 4; d++) put(ox0 - d * 2, oy + 4, '·', [189, 113, 59], 0.6 - d * 0.12);
  }

  // Impact flash: one bright frame on the pane line.
  if (since >= 0 && since < 0.05) for (let y = 0; y < H; y++) put(px, y, '█', [255, 255, 255], 0.9);

  // Reveal: the full mark resolves row by row, top to bottom.
  const rv = clamp((t - 1.05) / 0.55, 0, 1);
  if (rv > 0) {
    art.forEach((line, y) => {
      const rowK = clamp(rv * 1.6 - (y / H) * 0.6, 0, 1);
      if (rowK <= 0) return;
      const rgb = blend(H > 1 ? y / (H - 1) : 0);
      [...line].forEach((ch, x) => {
        if (ch !== ' ') put(x, y, ch, rgb, easeOutExpo(rowK));
      });
    });
  }

  const paint = colorsOn(color);
  const rows = [];
  for (let y = 0; y < H; y++) rows.push(composeRow(grid, y, 0, W, paint));
  return rows;
}

async function animateCharge({ small, stream, seed }) {
  const write = (s) => stream.write(s);
  write(HIDE_CURSOR);
  try {
    const frames = Math.ceil((CHARGE_SECONDS * 1000) / FRAME_MS);
    for (let f = 0; f <= frames; f++) {
      const t = Math.min(CHARGE_SECONDS, (f * FRAME_MS) / 1000);
      write(CLEAR);
      for (const line of renderChargeFrame({ small, t, seed: seed ?? 7 })) write(`${line}${CLEAR_LINE}\n`);
      if (f < frames) await sleep(FRAME_MS);
    }
  } finally {
    write(SHOW_CURSOR);
  }
}

// The intro: a dispersed swarm of glyph particles flies in and converges into
// the mark. Particles carry a pseudo-random z that fakes 2.5D depth — low z is
// near, bright, and lands early; high z is far, dim, and trails in.
async function animateLogo({ small, stream, seed }) {
  const write = (s) => stream.write(s);
  // The settled frame is the coloured logo. Short-circuiting to linesFor()
  // dropped every escape from the last frame, so the mark went flat for one
  // frame and then repainted itself in colour as the banner below it - a
  // visible one-frame dropout at the exact moment the eye is on the mark.
  // Always an array of lines: renderSwarmFrame returns one, and renderLogo
  // returns a string that has to be split, because the draw loop iterates this
  // with for...of and would otherwise walk a string one character at a time.
  const frameLines = (p) => (p >= 1
    ? renderLogo({ small, color: true }).split('\n')
    : renderSwarmFrame({ small, progress: p, seed }));

  write(HIDE_CURSOR);
  try {
    for (let frame = 0; frame < FRAMES; frame++) {
      // Frame 0 must draw the fully dispersed swarm: 1/FRAMES would already
      // have moved it a visible step.
      const progress = frame / (FRAMES - 1);
      write(CLEAR);
      for (const line of frameLines(progress)) write(`${line}${CLEAR_LINE}\n`);
      if (frame < FRAMES - 1) await sleep(FRAME_MS);
    }
  } finally {
    // Restored here, not after the loop, so an interrupted or throwing stream
    // can never leave the terminal without a cursor.
    write(SHOW_CURSOR);
  }
}

export async function intro({
  small = false,
  animate = true,
  version = null,
  stream = process.stdout,
  seed = null,
} = {}) {
  const out = stream ?? process.stdout;
  const write = (s) => out.write(s);
  if (!animate || !isInteractive() || !out.isTTY) {
    write(`${banner({ small, version, stream: out })}\n`);
    return;
  }
  try {
    // OX_INTRO=swarm keeps the previous particle-swarm intro.
    if (process.env.OX_INTRO === 'swarm') await animateLogo({ small, stream: out, seed });
    else await animateCharge({ small, stream: out, seed });
  } catch {
    // Never leave the terminal mid-frame if the animation blows up.
    write(CLEAR);
    write(`${renderLogo({ small, stream: out })}\n`);
  }
  write(`\n${banner({ small, version, stream: out })}\n`);
}
