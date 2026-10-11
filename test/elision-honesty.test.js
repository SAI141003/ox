// Two defects a verification pass found, both about the system being honest
// with the model.
//
// 1. The workspace tree elided its children globally, at the end. A directory
//    whose contents were cut therefore rendered as a bare `dir/` line, which
//    reads to the model as "this directory is empty". It is the same class of
//    lie this project keeps guarding against -- a silently truncated
//    representation that makes the agent believe something is absent -- only
//    relocated to the line the model actually reads. The global line still
//    ships; the per-directory marker is what stops `desktop/src/` from reading
//    as an empty directory.
//
// 2. `weather` was missing from WEB_KEYWORDS, so "what is the weather" -- the
//    plainest everyday case there is -- shipped no web tools at all.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sandbox HOME before importing src modules: config.js bakes CONFIG_DIR from
// os.homedir() at import time.
const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-elision-home-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });

const { buildContext, estimateTokens, treeBudgetTokens } = await import('../src/context.js');
const { listToolSchemas, narrowToolSchemas, NARROW_CORE_TOOLS, WEB_KEYWORDS } =
  await import('../src/tools/index.js');

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(fixture, { recursive: true, force: true });
  process.env.HOME = realHome;
});

// ---- the tree fixture --------------------------------------------------------
//
// Four top-level directories, walked dirs-first then alphabetical, so the
// budget is spent in a known order:
//   empty/   genuinely empty          -> must render unmarked
//   keep/    2 files, both survive    -> fully retained, must render unmarked
//   pack-a/  300 files, some survive  -> partially elided, must carry a marker
//   pack-b/  300 files, none survive  -> fully elided, must carry a marker
// The fixture is deliberately wider than the default 1000-token tree share so
// the elision is real rather than asserted.
let fixture;
const PACK = 300;

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-elision-tree-'));
  fs.mkdirSync(path.join(fixture, 'empty'));
  fs.mkdirSync(path.join(fixture, 'keep'));
  fs.writeFileSync(path.join(fixture, 'keep', 'index.ts'), '');
  fs.writeFileSync(path.join(fixture, 'keep', 'utils.ts'), '');
  for (const pack of ['pack-a', 'pack-b']) {
    fs.mkdirSync(path.join(fixture, pack));
    for (let i = 0; i < PACK; i++) {
      fs.writeFileSync(path.join(fixture, pack, `file-${String(i).padStart(3, '0')}.ts`), '');
    }
  }
});

function treeOf(cwd = fixture, budgetTokens = 8000) {
  return buildContext({ cwd, budgetTokens });
}

// Parse the rendered tree back into entries. Box drawing is the contract: a line
// is 4 gutter chars per level plus the 4-char branch, then the label (and its
// optional elision marker).
const LINE_RE = /^((?:(?:│   |    ))*)(?:├── |└── )(.*)$/;
const MARKER_RE = /^(.*?)\s{2}\(\+(\d+)(\+)?\)$/;

function parseTree(tree) {
  const lines = tree.split('\n');
  const entries = [];
  for (const line of lines.slice(1)) {
    if (/^\.\.\. /.test(line)) continue;
    const m = line.match(LINE_RE);
    if (!m) continue;
    const marked = m[2].match(MARKER_RE);
    entries.push({
      line,
      depth: m[1].length / 4,
      label: marked ? marked[1] : m[2],
      isDir: marked ? marked[1].endsWith('/') : m[2].endsWith('/'),
      elided: marked ? { n: Number(marked[2]), floor: marked[3] === '+' } : null,
    });
  }
  return entries;
}

const childrenOf = (entries, i) => {
  const out = [];
  for (let k = i + 1; k < entries.length && entries[k].depth > entries[i].depth; k++) {
    if (entries[k].depth === entries[i].depth + 1) out.push(entries[k]);
  }
  return out;
};

describe('tree elision: a truncated directory must not read as empty', () => {
  test('1. a directory whose children are elided carries its own marker', () => {
    const { tree } = treeOf();
    const entries = parseTree(tree);
    const byLabel = new Map(entries.filter((e) => e.isDir).map((e) => [e.label, e]));
    assert.ok(byLabel.size > 0, 'the fixture must render some directories');

    // pack-a keeps some children and loses the rest; pack-b loses every one.
    // Both are partially or fully elided, so both must say so on their own line.
    for (const label of ['pack-a/', 'pack-b/']) {
      const e = byLabel.get(label);
      assert.ok(e, `${label} missing from:\n${tree.slice(0, 400)}`);
      assert.ok(e.elided, `${label} rendered with no marker, so it reads as empty:\n${e.line}`);
      assert.ok(e.elided.n > 0, `${label} marker claims a count of 0`);
      assert.equal(e.elided.floor, false, 'the scan cap did not fire, so the count is exact');
    }

    // The exact number the marker claims is the number of children that are
    // really missing from disk. Not a plausible-looking guess.
    for (const label of ['pack-a/', 'pack-b/']) {
      const e = byLabel.get(label);
      const onDisk = fs.readdirSync(path.join(fixture, label.slice(0, -1))).length;
      const shown = childrenOf(entries, entries.indexOf(e)).length;
      assert.equal(onDisk - shown, e.elided.n, `${label} marker count disagrees with disk`);
    }
  });

  test('1b. no rendered directory is ever childless-and-unmarked when it is not empty', () => {
    // The general invariant, checked against the filesystem rather than against
    // the fixture's own plan: every rendered non-empty directory that shows no
    // children must be marked.
    const { tree } = treeOf();
    const entries = parseTree(tree);
    const offenders = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e.isDir || e.elided) continue;
      if (childrenOf(entries, i).length > 0) continue;
      const onDisk = fs.readdirSync(path.join(fixture, e.label.slice(0, -1)));
      if (onDisk.length > 0) offenders.push(`${e.label} (${onDisk.length} entries on disk)`);
    }
    assert.deepEqual(offenders, [], 'childless unmarked directories that are not empty');
  });

  test('2. a genuinely empty directory does NOT carry the marker', () => {
    const { tree } = treeOf();
    assert.deepEqual(fs.readdirSync(path.join(fixture, 'empty')), [], 'the fixture dir must be empty');
    const entries = parseTree(tree);
    const empty = entries.find((e) => e.label === 'empty/');
    assert.ok(empty, 'empty/ must be rendered');
    assert.equal(empty.elided, null, `a genuinely empty directory must render bare, got: ${empty.line}`);
    // "(+?)" is the scan-cap safety valve for a count nobody collected; the
    // scan cap did not fire here, so it must not appear anywhere in this tree.
    // Neither may a "(+0)" -- a marker that claims nothing was elided is the
    // exact lie this marker exists to prevent.
    assert.equal(/\(\+\?\)/.test(tree), false, 'no unknown-count marker without a scan cut');
    assert.equal(/\(\+0\)/.test(tree), false, 'no zero-count marker anywhere');
    assert.equal(/\(\+0\+\)/.test(tree), false, 'no zero-count floor marker anywhere');
  });

  test('3. a fully-retained directory does NOT carry the marker', () => {
    const { tree } = treeOf();
    const entries = parseTree(tree);
    const keep = entries.find((e) => e.label === 'keep/');
    assert.ok(keep, 'keep/ must be rendered');
    const kids = childrenOf(entries, entries.indexOf(keep));
    assert.equal(kids.length, 2, 'both of keep/\'s files must survive');
    assert.equal(
      keep.elided,
      null,
      `a directory that lost nothing must render bare, got: ${keep.line}`
    );
    for (const k of kids) assert.equal(k.elided, null, 'files never carry the marker');
  });

  test('4. the global marker still appears when anything is elided', () => {
    const { tree } = treeOf();
    const m = tree.match(/^\.\.\. (\d+)([+]?) more entries \(use list_dir or glob to explore\)$/m);
    assert.ok(m, `global elision marker missing from:\n${tree.slice(-300)}`);
    assert.ok(Number(m[1]) > 0, 'the global marker reports nothing dropped');
    // Per-directory markers ADD to the global line, they do not replace it.
    assert.ok(parseTree(tree).some((e) => e.elided), 'and this tree also elides per-directory');
    // The global line is the LAST line, so it can never be lost to a cut.
    assert.match(tree.split('\n').at(-1), /^\.\.\. \d+\+? more entries \(use list_dir or glob to explore\)$/);
  });

  test('7. the rendered tree is still well-formed and parses', () => {
    const { tree } = treeOf();
    const lines = tree.split('\n');
    assert.ok(lines.length > 5);
    // Exactly one root label, then every line is either a tree line or the
    // trailing global marker. No stray text, no trailing whitespace.
    assert.match(lines[0], /^[^\s].*\/$/);
    for (const line of lines.slice(1, -1)) {
      assert.ok(line.match(LINE_RE), `unparseable tree line: ${JSON.stringify(line)}`);
      assert.equal(/[ \t]+$/.test(line), false, `trailing whitespace: ${JSON.stringify(line)}`);
    }
    const entries = parseTree(tree);
    // Indentation is a well-formed path: never deeper than the previous entry
    // plus one, never shallower than zero.
    let prev = -1;
    for (const e of entries) {
      assert.ok(Number.isInteger(e.depth), `depth is not an integer: ${e.line}`);
      assert.ok(e.depth <= prev + 1, `depth jumped from ${prev} to ${e.depth}: ${e.line}`);
      assert.ok(e.depth >= 0, `negative depth: ${e.line}`);
      prev = e.depth;
    }
    // The ancestor-closure guard still holds: no file appears without the path
    // that locates it.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.isDir) continue;
      // Skip siblings, then descend: the nearest preceding entry shallower
      // than the file is its parent, and so on up to the root label.
      let a = i - 1;
      for (let d = e.depth - 1; d >= 0; d--) {
        while (a >= 0 && entries[a].depth >= e.depth) a--;
        assert.ok(a >= 0, `file ${e.label} has nothing at depth ${d} above it`);
        const p = entries[a];
        assert.equal(p.depth, d, `file ${e.label} has no directory at depth ${d} above it`);
        assert.ok(p.isDir, `${p.label} is not a directory but stands above ${e.label}`);
        a--;
      }
    }
    // The markers are charged against the same budget as the entries: the
    // rendered tree, markers and global line included, still fits its share.
    const ctx = treeOf();
    const treeTok = estimateTokens(ctx.tree);
    assert.ok(
      treeTok <= treeBudgetTokens(8000, ctx.memoryFiles),
      `tree ${treeTok} tok exceeds its ${treeBudgetTokens(8000, ctx.memoryFiles)} tok share`
    );
    assert.equal(ctx.tokenCount, estimateTokens(ctx.memoryFiles + '\n' + ctx.tree));
  });

  test('a generous budget renders byte-identically to the pre-fix shape', () => {
    // Nothing is elided, so nothing is marked: the cap only ever removes.
    const small = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-elision-small-'));
    try {
      fs.writeFileSync(path.join(small, 'package.json'), '{}\n');
      fs.mkdirSync(path.join(small, 'src'));
      fs.writeFileSync(path.join(small, 'src', 'index.js'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(small, 'README.md'), '# hi\n');
      const expected = [
        `${path.basename(small)}/`,
        '\u251c\u2500\u2500 src/',
        '\u2502   \u2514\u2500\u2500 index.js',
        '\u251c\u2500\u2500 package.json',
        '\u2514\u2500\u2500 README.md',
      ].join('\n');
      assert.equal(buildContext({ cwd: small }).tree, expected);
      assert.equal(buildContext({ cwd: small, budgetTokens: 1_000_000 }).tree, expected);
    } finally {
      fs.rmSync(small, { recursive: true, force: true });
    }
  });
});

// ---- defect 2: WEB_KEYWORDS ---------------------------------------------------

describe('WEB_KEYWORDS: everyday web intent', () => {
  const OFFER = listToolSchemas({});
  const keptFor = (message) => narrowToolSchemas(OFFER, { message }).map((s) => s.name);

  test('5. "what is the weather" now keeps web_fetch and web_search', () => {
    const names = keptFor('what is the weather');
    assert.ok(names.includes('web_fetch'), `web_fetch dropped: ${names.join(',')}`);
    assert.ok(names.includes('web_search'), `web_search dropped: ${names.join(',')}`);
    // The offering path is genuinely narrowed, not just short-circuited: the
    // offer must be past the threshold or the test proves nothing.
    assert.ok(OFFER.length > 12, `fixture must be past the narrowing threshold, got ${OFFER.length}`);
    // And the tools it keeps are real schemas, not stubs.
    assert.deepEqual(OFFER.find((s) => s.name === 'web_search').input_schema.required, ['query']);
  });

  test('5b. the other everyday gaps are closed too', () => {
    for (const message of [
      'what is the weather',
      "what's the forecast for tomorrow",
      'what is the temperature right now',
      'give me a recipe for lentil soup',
      'translate this paragraph to Japanese',
      'tell me about Ada Lovelace wikipedia',
      'what are the directions to the office',
    ]) {
      const names = keptFor(message);
      assert.ok(names.includes('web_fetch'), `"${message}" lost web_fetch: ${names.join(',')}`);
    }
  });

  test('6. a prompt with no web intent still does NOT keep them', () => {
    // The over-widening guard. Each of these is a coding or housekeeping turn
    // that must not ship two more schemas; if a new keyword were too broad,
    // one of these would start carrying web_fetch.
    for (const message of [
      'rename the local variable in this function',
      'fix the failing test',
      'why is the build failing',
      'find where this function is called',
      'convert the typescript file',
      'write me a python script that sorts a list',
      'the tree budget is computed from the total budget minus the instructions',
      'run the linter and fix what it reports',
    ]) {
      const names = keptFor(message);
      assert.equal(names.includes('web_fetch'), false, `"${message}" wrongly kept web_fetch`);
      assert.equal(names.includes('web_search'), false, `"${message}" wrongly kept web_search`);
    }
  });

  test('the list grew by a handful of words, not by a re-write', () => {
    // 46 before, 53 after. The cost of a wider list is paid per turn on any
    // prompt that fires it, so the delta is pinned rather than left open.
    assert.equal(WEB_KEYWORDS.length, 53);
    for (const k of ['weather', 'forecast', 'temperature', 'recipe', 'translate', 'wikipedia', 'directions']) {
      assert.ok(WEB_KEYWORDS.includes(k), `${k} missing from WEB_KEYWORDS`);
    }
    assert.equal(new Set(WEB_KEYWORDS).size, WEB_KEYWORDS.length, 'no duplicate keyword');
    for (const k of WEB_KEYWORDS) assert.match(k, /^[a-z]+$/, `${k} is not a plain lowercase word`);
    // The words deliberately NOT added: each collides with this agent's own
    // working vocabulary, so it would fire on coding turns instead of web ones.
    for (const k of ['score', 'stock', 'definition', 'price']) {
      assert.equal(WEB_KEYWORDS.includes(k), false, `${k} must stay out of the web signal`);
    }
  });

  test('the token cost of firing the web group on "what is the weather"', () => {
    // Schemas, not names: the cost being measured is what rides the wire.
    const weather = narrowToolSchemas(OFFER, { message: 'what is the weather' });
    const coding = narrowToolSchemas(OFFER, { message: 'rename the local variable in this function' });
    const webSchemas = OFFER.filter((s) => ['web_fetch', 'web_search'].includes(s.name));
    // The whole cost of the fix, stated exactly: a matching offer is the web
    // group plus core and nothing else.
    const expected = [...webSchemas, ...OFFER.filter((s) => NARROW_CORE_TOOLS.includes(s.name))];
    assert.deepEqual(weather.map((s) => s.name), expected.map((s) => s.name));
    // Bytes are the exact charge: same schemas, same objects, only the web pair
    // added. The two group schemas are not byte-identical to their share of the
    // array (separator commas land differently), so the charge is measured
    // against the whole offer rather than against the group slice.
    const bytes = JSON.stringify(weather).length - JSON.stringify(coding).length;
    const cost = estimateTokens(JSON.stringify(webSchemas));
    const delta = estimateTokens(JSON.stringify(weather)) - estimateTokens(JSON.stringify(coding));
    // Tokens are ceil(chars/4) applied per offer, so the delta can sit one token
    // either side of the group cost. Pin the rounding rather than pretend the
    // two estimators commute.
    assert.ok(Math.abs(delta - cost) <= 1, `token delta ${delta} vs group cost ${cost}`);
    assert.ok(bytes > 2000 && cost > 500, `expected a real per-turn cost, got ${bytes} bytes`);

    for (const s of webSchemas) assert.equal(NARROW_CORE_TOOLS.includes(s.name), false);
    // Nothing new ships on a coding turn, so the everyday fix costs nothing
    // everywhere else.
    const coreOffered = OFFER.filter((s) => NARROW_CORE_TOOLS.includes(s.name));
    assert.equal(coding.length, coreOffered.length, 'a coding turn is core-only and unaffected');
    assert.deepEqual(coding.map((s) => s.name), coreOffered.map((s) => s.name));
    assert.ok(
      coding.every((s) => !['web_fetch', 'web_search'].includes(s.name)),
      'and it carries no web schema at all'
    );
  });
});
