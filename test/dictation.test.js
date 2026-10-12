// OX Buddy dictation: cleanup and project-name correction (src/dictation.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, correctVocabulary } from '../src/dictation.js';

const cases = [
  ['um so uh can you fix the the login bug', 'So can you fix the login bug?'],
  ['why is this test red', 'Why is this test red?'],
  ['run the tests comma then commit', 'Run the tests, then commit.'],
  ['first line new line second line', 'First line.\nSecond line.'],
  ['hello   world ,how are you', 'Hello world, how are you.'],
  ['i think i i should rename it', 'I think I should rename it.'],
  ['add a button. then style it', 'Add a button. Then style it.'],
  ['', ''],
];

for (const [raw, want] of cases) {
  test(`clean: ${JSON.stringify(raw)}`, () => assert.equal(cleanTranscript(raw), want));
}

const vocab = ['package.json', 'README.md', 'useState', 'island.js', 'src/cli.js', 'runHeadless', 'config_loader'];

test('spoken file and code names become the real names', () => {
  assert.equal(correctVocabulary('Open package dot json.', vocab), 'Open package.json.');
  assert.equal(correctVocabulary('Update the read me.', vocab), 'Update the README.md.');
  assert.equal(correctVocabulary('Why does use state rerender?', vocab), 'Why does useState rerender?');
  assert.equal(correctVocabulary('Look at run headless first.', vocab), 'Look at runHeadless first.');
  assert.equal(correctVocabulary('Check config loader.', vocab), 'Check config_loader.');
  assert.equal(correctVocabulary('Edit the notes dot txt file.', vocab), 'Edit the notes.txt file.', 'unknown files still join');
});

test('ordinary words are left alone', () => {
  assert.equal(correctVocabulary('We should use state machines here.', vocab), 'We should use state machines here.'.replace('use state', 'useState'),
    'a project identifier spelled out is corrected even mid-sentence');
  assert.equal(correctVocabulary('Read the island docs.', vocab), 'Read the island docs.');
  assert.equal(correctVocabulary('The package is ready.', vocab), 'The package is ready.');
});
