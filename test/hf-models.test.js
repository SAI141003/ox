// Hugging Face models: search, files with real sizes and fit, and the
// download through Ollama's /api/pull — against stand-in servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('search, files and a pull with progress', async (t) => {
  let pulled = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url.startsWith('/api/models?')) {
        const q = new URL(req.url, 'http://x').searchParams;
        assert.equal(q.get('filter'), 'gguf');
        res.end(JSON.stringify([{ id: 'acme/Tiny-GGUF', downloads: 10, likes: 2 }, { id: 'microsoft/bitnet-b1.58-2B-4T-gguf', downloads: 5 }]));
        return;
      }
      if (req.url === '/api/models/acme/Tiny-GGUF/tree/main') {
        res.end(JSON.stringify([{ type: 'file', path: 'tiny-q4_k_m.gguf', size: 100 * 1024 ** 2 }, { type: 'file', path: 'tiny-f16.gguf', size: 40 * 1024 ** 3 }, { type: 'file', path: 'README.md', size: 10 }]));
        return;
      }
      if (req.url === '/api/pull') {
        pulled = JSON.parse(body).model;
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        res.write(JSON.stringify({ status: 'pulling x', total: 100, completed: 50 }) + '\n');
        res.end(JSON.stringify({ status: 'success' }) + '\n');
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = { a: process.env.OX_HF_BASE, b: process.env.OX_OLLAMA_HOST };
  process.env.OX_HF_BASE = base; process.env.OX_OLLAMA_HOST = base;
  t.after(() => { for (const [k, v] of [['OX_HF_BASE', saved.a], ['OX_OLLAMA_HOST', saved.b]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const hf = await import('../src/hf-models.js');
  const found = await hf.searchModels('tiny');
  assert.equal(found[0].runtime, 'ollama');
  assert.equal(found[1].runtime, 'bitnet.cpp', 'BitNet needs its own runtime and is marked so');
  const files = await hf.modelFiles('acme/Tiny-GGUF', { ramGB: 16 });
  assert.deepEqual(files.map((f) => [f.quant, f.fits]), [['Q4_K_M', true], ['F16', false]]);
  const seen = [];
  const r = await hf.pullModel('acme/Tiny-GGUF', 'Q4_K_M', { onProgress: (p) => seen.push(p.status) });
  assert.equal(pulled, 'hf.co/acme/Tiny-GGUF:Q4_K_M');
  assert.equal(r.bot, 'ox-ollama:hf.co/acme/Tiny-GGUF:Q4_K_M');
  assert.deepEqual(seen, ['pulling manifest', 'pulling x', 'success']);
  await assert.rejects(() => hf.modelFiles('../etc'), /owner\/name/);
});
