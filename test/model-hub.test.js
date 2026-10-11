import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseModelKey, detectHardware, estimateTokensPerSec, fitLabel, pickQuant, pullCommand, quantSizes } from '../src/model-hub.js';

const GB = 1024 ** 3;

test('quantSizes reads quant tags and sums split shards without double counting', () => {
  const sizes = quantSizes([
    { rfilename: 'm-q4_k_m.gguf', size: 4.7 * GB },
    { rfilename: 'm-q4_k_m-00001-of-00002.gguf', size: 4.0 * GB },
    { rfilename: 'm-q4_k_m-00002-of-00002.gguf', size: 0.7 * GB },
    { rfilename: 'm-q8_0-00001-of-00002.gguf', size: 4 * GB },
    { rfilename: 'm-q8_0-00002-of-00002.gguf', size: 4 * GB },
    { rfilename: 'mmproj-m-f16.gguf', size: 1 * GB },
    { rfilename: 'README.md', size: 100 },
  ]);
  assert.equal(sizes.Q4_K_M, 4.7 * GB, 'the single-file copy wins over its shards');
  assert.equal(sizes.Q8_0, 8 * GB, 'shards are summed when no single file exists');
  assert.equal(sizes.F16, undefined, 'vision projector files are not model weights');
});

test('pickQuant keeps context headroom first, then accepts the full budget', () => {
  const sizes = { Q8_0: 8 * GB, Q6_K: 6.0 * GB, Q4_K_M: 4.7 * GB, Q2_K: 3 * GB };
  assert.equal(pickQuant(sizes, 8.2).quant, 'Q6_K', '8 GB would leave no room for context');
  assert.equal(pickQuant(sizes, 20).quant, 'Q8_0');
  assert.equal(pickQuant(sizes, 4.8).quant, 'Q4_K_M', 'falls back to the whole budget');
  assert.equal(pickQuant({ Q2_K: 3 * GB }, 8), null, 'Q2 is never recommended');
});

test('Apple Silicon budget follows unified memory and the chip bandwidth', () => {
  const hw = detectHardware({ platform: 'darwin', arch: 'arm64', totalmem: 16 * GB, probe: () => 'Apple M3' });
  assert.equal(hw.kind, 'apple-unified');
  assert.equal(hw.budgetGB, 8.2);
  assert.equal(hw.bandwidthGBs, 100);
  const pro = detectHardware({ platform: 'darwin', arch: 'arm64', totalmem: 64 * GB, probe: () => 'Apple M4 Pro' });
  assert.equal(pro.bandwidthGBs, 273, 'M4 Pro is not matched as plain M4');
});

test('NVIDIA budget comes from VRAM, not system RAM', () => {
  const hw = detectHardware({
    platform: 'linux', arch: 'x64', totalmem: 64 * GB,
    probe: (cmd) => (cmd === 'nvidia-smi' ? 'NVIDIA GeForce RTX 4090, 24564' : ''),
  });
  assert.equal(hw.kind, 'nvidia');
  assert.equal(hw.budgetGB, 22.5);
});

test('helpers: dedupe key, speed estimate, fit label, pull command', () => {
  assert.equal(baseModelKey('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF'), baseModelKey('Qwen/Qwen2.5-Coder-7B-Instruct-GGUF'));
  assert.equal(estimateTokensPerSec(5, { bandwidthGBs: 100 }), 11);
  assert.equal(fitLabel(3, 8), 'comfortable');
  assert.equal(fitLabel(8, 8), 'tight');
  assert.equal(pullCommand('a/b-GGUF', 'Q4_K_M'), 'ollama pull hf.co/a/b-GGUF:Q4_K_M');
});
