import { describe, it } from 'node:test';
import assert from 'node:assert';
import { listModels, listProviders, listLocalEndpoints } from '../src/models.js';

describe('models api', () => {
  it('lists every bot with pricing + availability', () => {
    const { models, withheld } = listModels({ env: {} });
    assert.ok(models.length >= 15, `expected 15+ models, got ${models.length}`);
    for (const m of models) {
      assert.ok(m.id && m.provider && m.model, JSON.stringify(m));
      assert.equal(typeof m.available, 'boolean');
      assert.equal(typeof m.hasKey, 'boolean');
    }
    // ox-openrouter has no default model → withheld, not dropped
    assert.ok(withheld.some((w) => w.id === 'ox-openrouter'));
  });

  it('marks keyless providers available with no env', () => {
    const { models } = listModels({ env: {} });
    const ollama = models.find((m) => m.provider === 'ollama');
    assert.ok(ollama, 'no ollama model listed');
    assert.equal(ollama.available, true);
    assert.equal(ollama.keyless, true);
  });

  it('marks keyed providers available when the key is present', () => {
    const { models } = listModels({ env: { XAI_API_KEY: 'x' } });
    const grok = models.find((m) => m.id === 'ox-grok');
    assert.ok(grok);
    assert.equal(grok.available, true);
    assert.deepEqual(grok.pricing, { in: 2, out: 6, window: 500_000 });
  });

  it('lists providers with key status', () => {
    const providers = listProviders({ env: {} });
    assert.ok(providers.length >= 9);
    const ollama = providers.find((p) => p.provider === 'ollama');
    assert.equal(ollama.keyless, true);
    assert.equal(ollama.hasKey, true);
  });

  it('local scan never throws and reports origins', async () => {
    const res = await listLocalEndpoints({ deadlineMs: 300, timeoutMs: 200 });
    assert.ok(Array.isArray(res.found));
    assert.ok(Array.isArray(res.origins));
    assert.ok(res.origins.includes('http://localhost:11434'));
  });
});
