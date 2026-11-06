import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('a model that just stalled is passed over as an automatic fallback for half an hour', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-stalls-'));
  const saved = process.env.OX_HOME;
  process.env.OX_HOME = home;
  try {
    const S = await import('../src/slow-models.js');
    assert.equal(S.stalledRecently('nvidia', 'deepseek-ai/deepseek-v4.1-flash'), false);
    S.noteStall('nvidia', 'deepseek-ai/deepseek-v4.1-flash', 1_000);
    assert.equal(S.stalledRecently('nvidia', 'deepseek-ai/deepseek-v4.1-flash', 1_000 + 60_000), true);
    assert.equal(S.stalledRecently('nvidia', 'minimaxai/minimax-m3.1-flash', 2_000), false, 'only that model');
    assert.equal(S.stalledRecently('nvidia', 'deepseek-ai/deepseek-v4.1-flash', 1_000 + S.STALL_QUIET_MS + 1), false, 'and only for a while');
  } finally { if (saved === undefined) delete process.env.OX_HOME; else process.env.OX_HOME = saved; }
});
