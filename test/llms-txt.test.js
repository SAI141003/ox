// @llms:<domain> pulls only the relevant parts of a library's agent docs.
// Offline: fetch is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandLlmsRefs, selectRelevant, LLMS_BUDGET } from '../src/llms-txt.js';
import { expandContextRefs } from '../src/context.js';

const DOC = [
  '# Componentry\n\n> Animated React components for marketing sites.',
  ...['Install', 'Liquid Glass Carousel', 'Particle Text', 'Scroll Reveal', 'Pricing Table'].map(
    (t) => `## ${t}\n\n${t} usage: import { ${t.replace(/ /g, '')} } from "componentry". ${'Props and examples. '.repeat(40)}`
  ),
].join('\n\n');

const fakeFetch = (calls) => async (url) => {
  calls.push(url);
  return { ok: true, status: 200, headers: new Map([['content-type', 'text/plain']]), text: async () => DOC };
};

test('only the sections that match the request are inserted, inside the budget', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-llms-'));
  const calls = [];
  const out = await expandLlmsRefs('add a liquid glass carousel with @llms:componentry.dev', { home, fetchImpl: fakeFetch(calls) });
  assert.deepEqual(calls, ['https://componentry.dev/llms.txt']);
  assert.match(out, /\[begin @llms:componentry\.dev \(agent docs; 1 of 5 sections/);
  assert.match(out, /## Liquid Glass Carousel/);
  assert.doesNotMatch(out, /## Pricing Table/);
  assert.ok(out.length < DOC.length, 'smaller than the whole file');
  // Cached: a second use within a day does not refetch.
  await expandLlmsRefs('@llms:componentry.dev particle text', { home, fetchImpl: fakeFetch(calls) });
  assert.equal(calls.length, 1);
});

test('no matching section: the overview and opening sections, still within budget', () => {
  const { body, kept } = selectRelevant(DOC, 'zzz unrelated words');
  assert.ok(kept >= 1);
  assert.ok(body.length <= LLMS_BUDGET);
  assert.match(body, /^# Componentry/);
});

test('a failed fetch leaves the token as text and says why', async () => {
  const notes = [];
  const out = await expandLlmsRefs('see @llms:nope.dev', {
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-llms-')),
    fetchImpl: async () => ({ ok: false, status: 404, headers: new Map(), text: async () => '' }),
    note: (s) => notes.push(s),
  });
  assert.equal(out, 'see @llms:nope.dev');
  assert.match(notes[0], /nope\.dev has no llms\.txt \(HTTP 404\)/);
});

test('the @file pass leaves @llms: alone', () => {
  assert.equal(expandContextRefs('use @llms:componentry.dev', os.tmpdir()), 'use @llms:componentry.dev');
});
