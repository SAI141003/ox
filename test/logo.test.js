import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const SRC = new URL('../src/logo.js', import.meta.url).pathname;

// The colour path is gated on process.stdout.isTTY, which is false under the
// test runner. Force it so the colour branches actually run, and restore it
// afterwards so the non-TTY assertions below are measuring the real gate.
function withTty(fn) {
  const was = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    return fn();
  } finally {
    process.stdout.isTTY = was;
  }
}

const ESCAPE = /\x1b\[[0-9;]*m/g;
const stripEscapes = (s) => s.replace(ESCAPE, '');
const plainArt = (art) => art.map((l) => l.replace(/[ \t]+$/, '')).join('\n');
async function withTtyAsync(fn) {
  const was = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    return await fn();
  } finally {
    process.stdout.isTTY = was;
  }
}

const colorsOf = (text) => [...text.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)]
  .map((m) => `${m[1]},${m[2]},${m[3]}`);

test('color:false output is byte-identical to the plain art, with zero escapes', async () => {
  const { LOGO, LOGO_SMALL, renderLogo } = await import(SRC);
  for (const [art, small] of [[LOGO, false], [LOGO_SMALL, true]]) {
    const out = withTty(() => renderLogo({ small, color: false }));
    assert.equal(out, plainArt(art), `LOGO${small ? '_SMALL' : ''} plain art`);
    assert.equal(out.includes('\x1b'), false, 'no escape bytes at all');
    assert.equal(out.match(ESCAPE), null);
    // color defaults to true, so on a TTY the default render IS coloured --
    // this is the control that proves color:false is doing real work.
    assert.ok(withTty(() => renderLogo({ small })).includes('\x1b'));
  }
});

test('colour wraps every line in a truecolor SGR pair', async () => {
  const { LOGO, LOGO_SMALL, renderLogo } = await import(SRC);
  for (const [art, small] of [[LOGO, false], [LOGO_SMALL, true]]) {
    const out = withTty(() => renderLogo({ small, color: true }));
    const lines = out.split('\n');
    assert.equal(lines.length, art.length, 'one rendered line per art line');
    for (const line of lines) {
      assert.match(line, /^\x1b\[38;2;\d+;\d+;\d+m.*\x1b\[39m$/, `line wrapped: ${JSON.stringify(line)}`);
    }
    // Every line is a whole-art replacement, never a partial overlay.
    assert.deepEqual(lines.map(stripEscapes), art.map((l) => l.replace(/[ \t]+$/, '')));
  }
});

test('the gradient is keyed to the art\'s own line count, not a constant', async () => {
  const { LOGO, LOGO_SMALL, renderLogo } = await import(SRC);
  const steps = (art, small) => {
    const out = withTty(() => renderLogo({ small, color: true }));
    const lines = out.split('\n');
    assert.equal(lines.length, art.length);
    const per = lines.map((l) => {
      const m = l.match(/\x1b\[38;2;\d+;\d+;\d+m/);
      return m ? m[0] : null;
    });
    for (const v of per) assert.ok(v, 'every line carries its own colour');
    return { per, distinct: new Set(per).size };
  };
  const big = steps(LOGO, false);
  const small = steps(LOGO_SMALL, true);
  // One distinct step per row: a hardcoded 15-row denominator would leave the
  // 12-row variant reaching only 11/14 of the ramp (and a hardcoded 12 would
  // pin two rows of the 15-row mark to the same colour).
  assert.equal(big.distinct, LOGO.length);
  assert.equal(small.distinct, LOGO_SMALL.length);
  assert.notEqual(big.distinct, small.distinct, 'the two variants must not share a step count');
  // Both must still span the full ramp, first row to last row.
  assert.equal(big.per[0], small.per[0], 'both start on the same colour');
  assert.equal(big.per.at(-1), small.per.at(-1), 'both end on the same colour');
});

test('the ramp is not the washed-out 2-stop lavender at the midpoint', async () => {
  const { LOGO, renderLogo } = await import(SRC);
  const lines = withTty(() => renderLogo({ color: true })).split('\n');
  const rgb = lines.map((l) => {
    const m = l.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
    return [+m[1], +m[2], +m[3]];
  });
  const luma = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const mids = luma(rgb[Math.floor(rgb.length / 2)]);
  // A 2-stop cyan->magenta ramp peaks at ~78% lightness across the middle
  // rows, bleaching the eye/nostril band. Anything under 0.80 keeps the mark's
  // negative space legible; this is a regression guard, not a taste call.
  assert.ok(mids < 0.80, `mid-row luma ${mids.toFixed(3)} should stay under 0.80`);
  // Brand ramp: light horns to dark muzzle. The sweep must read as one motion,
  // so lightness descends monotonically from the first row to the last.
  const lumas = rgb.map(luma);
  assert.ok(lumas[0] > lumas.at(-1), 'starts light (ivory horn), ends dark (hide)');
  for (let i = 1; i < lumas.length; i++) assert.ok(lumas[i] <= lumas[i - 1] + 1e-9, `row ${i} is not darker than row ${i - 1}`);
});

test('banner color:false equals banner color:true with escapes stripped', async () => {
  const { banner } = await import(SRC);
  for (const small of [false, true]) {
    for (const version of ['0.1.0', '', null, 'v2.0.0']) {
      const colour = withTty(() => banner({ small, color: true, version }));
      const plain = withTty(() => banner({ small, color: false, version }));
      assert.equal(
        stripEscapes(colour),
        plain,
        `banner small=${small} version=${version}: colour must be purely additive`,
      );
      assert.ok(colour.includes('\x1b'), 'the coloured banner really is coloured');
    }
  }
});

test('NO_COLOR and non-TTY produce no escapes', async () => {
  const { LOGO, LOGO_SMALL, renderLogo, banner } = await import(SRC);

  // Non-TTY: isTTY left as the runner set it. It is undefined rather than
  // false here, but Boolean(undefined) is false either way, which is all
  // colorsOn() looks at.
  assert.ok(!process.stdout.isTTY, 'test runner stdout is not a TTY');
  for (const small of [false, true]) {
    const out = renderLogo({ small });
    assert.equal(out, plainArt(small ? LOGO_SMALL : LOGO), 'non-TTY still prints the art');
    assert.equal(out.includes('\x1b'), false, 'non-TTY emits no escapes');
    assert.equal(banner({ small }).includes('\x1b'), false, 'non-TTY banner is plain');
  }

  // NO_COLOR on a TTY.
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    for (const small of [false, true]) {
      const out = withTty(() => renderLogo({ small }));
      assert.equal(out, plainArt(small ? LOGO_SMALL : LOGO), 'NO_COLOR still prints the art');
      assert.equal(out.includes('\x1b'), false, 'NO_COLOR emits no escapes');
      assert.equal(withTty(() => banner({ small })).includes('\x1b'), false, 'NO_COLOR banner is plain');
    }
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
});

test('the real CLI emits no escapes when piped or with NO_COLOR', () => {
  const bin = new URL('../bin/ox.js', import.meta.url).pathname;
  const plain = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(plain.status, 0);
  assert.equal(plain.stdout.includes('\x1b'), false, 'piped --version must be escape-free');
  assert.match(plain.stdout, /ox \S+/, 'and must still print the version');

  // script(1) gives the child a real pty, so this is the TTY-with-NO_COLOR
  // path. Skipped where script(1) is unavailable rather than failing the run.
  const pty = spawnSync('script', ['-q', '/dev/null', process.execPath, bin, '--version'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (pty.error || pty.status !== 0) return;
  assert.equal(pty.stdout.includes('\x1b['), false, 'NO_COLOR on a pty must be escape-free');
});

test('swarm settled frame is the coloured logo, not the plain one', async () => {
  const { renderSwarmFrame, renderLogo, LOGO } = await import(SRC);
  const frame = withTty(() => renderSwarmFrame({ progress: 1, seed: 1 }).join('\n'));
  const logo = withTty(() => renderLogo({ color: true }));
  assert.equal(frame, logo, 'the settled swarm frame equals the coloured logo');
  assert.ok(frame.includes('\x1b[38;2;'), 'no one-frame colour dropout at rest');
});

test('the intro draws whole lines, not one escape-wrapped line per character', async () => {
  const { intro, LOGO } = await import(SRC);
  // animateLogo draws with `for (const line of frameLines(p))`, so every branch
  // of frameLines has to hand back an array. renderLogo() returns a string; if
  // the settled frame is not split, for...of walks it a character at a time and
  // the mark arrives shredded, one glyph per line.
  let out = '';
  const stream = { isTTY: true, write: (s) => { out += s; return true; } };
  // intro() gates the animation on isInteractive(), which reads
  // process.stdout.isTTY - not the injected stream - so the whole await has to
  // run inside the forced-TTY window.
  await withTtyAsync(() => intro({ animate: true, stream, seed: 1 }));
  const drawn = out.split('\x1b[2K\n').filter((s) => s.replace(/[\x1b\r\n]/g, '').trim());
  assert.ok(drawn.length > 0, 'something was drawn');
  for (const chunk of drawn) {
    // Strip the full SGR colour sequence (started with a single \x1b, not one
    // character), then drop everything else we never cared about.
    // Visible text only (every CSI sequence removed). The intro is the charge
    // (pane, cracks, shards, mini ox, mark), or the swarm under OX_INTRO=swarm.
    const visible = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.ok(
      visible.trim() === '' || /[█·˙│╱╲─▀▄◆◢◣◤◥▴*]|ox/.test(visible),
      `a draw chunk should be a full line, not a fragment: ${JSON.stringify(visible.slice(0, 24))}`,
    );
  }
  // The last drawn frame must be the mark itself, in colour, 15 rows tall.
  const frames = out.split('\x1b[H\x1b[2J');
  const lastFrame = frames[frames.length - 1].split('\n')[0];
  assert.ok(lastFrame.includes('\x1b[38;2;'), 'settled frame keeps its colour');
  // The horn-tip row must appear intact on one line, not split per glyph.
  const horn = LOGO[0];
  assert.ok(out.includes(horn), 'the horn-tip row is written contiguously');
});

test('the banner paints for the stream it will be written to (acp stderr path)', async () => {
  const { banner, renderLogo } = await import(SRC);
  const fake = (isTTY) => ({ isTTY, write: () => true });

  // The `ox acp server` case: stdout is the JSON-RPC pipe (never a TTY under
  // an editor), stderr is the agent log panel. The mark must still light up.
  const was = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    const painted = banner({ version: '0.1.0', stream: fake(true) });
    assert.ok(painted.includes('\x1b[38;2;'), 'coloured when the destination stream is a TTY');
    // The wordmark must keep its bold/dim too -- c.bold/c.dim gate on stdout
    // and would have silently stripped them on this path.
    assert.ok(painted.includes('\x1b[1m'), 'wordmark stays bold for a TTY destination');
    assert.ok(painted.includes('\x1b[2m'), 'tagline stays dim for a TTY destination');
    assert.ok(renderLogo({ stream: fake(true) }).includes('\x1b[38;2;'), 'renderLogo honours the stream too');
  } finally {
    process.stdout.isTTY = was;
  }

  // The converse: a piped destination must stay plain even when stdout is a
  // real terminal, so `ox acp server 2>log` never sprays escapes into the file.
  process.stdout.isTTY = true;
  try {
    const plain = banner({ version: '0.1.0', stream: fake(false) });
    assert.equal(plain.includes('\x1b'), false, 'plain when the destination stream is piped');
    assert.equal(renderLogo({ stream: fake(false) }).includes('\x1b'), false, 'renderLogo honours the pipe too');
  } finally {
    process.stdout.isTTY = was;
  }

  // NO_COLOR still beats every stream.
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    assert.equal(banner({ stream: fake(true) }).includes('\x1b'), false, 'NO_COLOR wins over a TTY stream');
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
});

