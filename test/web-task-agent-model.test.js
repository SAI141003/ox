import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { webTaskTool } from '../src/tools/web-task.js';

test('web_task fast backend uses the active agent decider and accepts a checked DONE', async () => {
  let observations = 0;
  const browser = {
    cdp: { calls: 0 },
    observe: async () => ({ url: 'https://example.test/', title: 'Example', text: 'Ready', actions: [], fingerprint: String(++observations) }),
    fresh: async () => true,
    close: async () => {},
  };
  const prompts = [];
  const result = await webTaskTool({ task: 'Confirm the page is ready', backend: 'fast' }, {
    yolo: true,
    fastBrowser: browser,
    fastBrowserDecide: async (prompt) => {
      prompts.push(prompt);
      return prompt.system.startsWith('You check whether a browser task is finished.')
        ? '{"met":true,"missing":null}'
        : '{"operation":"DONE"}';
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.meta.success, true);
  assert.match(result.content, /Done in .* decision\(s\)/);
  assert.equal(prompts.length, 2, 'one action decision and one independent DONE check');
});

test('legacy MCP browser backends fail clearly without the active agent planner', async () => {
  const result = await webTaskTool({ task: 'open the menu', backend: 'browser-harness' }, { yolo: true });
  assert.equal(result.isError, true);
  assert.match(result.content, /needs an active Ox agent model/);
});

test('runAgent uses its active model for browser planning and accounts nested usage', async (t) => {
  const previous = { OX_API_KEY: process.env.OX_API_KEY, OX_HOME: process.env.OX_HOME };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-web-agent-'));
  process.env.OX_HOME = home;
  process.env.OX_API_KEY = 'web-task-test-key';
  t.after(() => {
    if (previous.OX_API_KEY === undefined) delete process.env.OX_API_KEY;
    else process.env.OX_API_KEY = previous.OX_API_KEY;
    if (previous.OX_HOME === undefined) delete process.env.OX_HOME;
    else process.env.OX_HOME = previous.OX_HOME;
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });

  const sse = (data) => `data: ${JSON.stringify(data)}\n\n`;
  let mainRequests = 0;
  let nestedRequests = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    let response;
    if (hasTools && !payload.messages.some((m) => m.role === 'tool')) {
      mainRequests++;
      response = sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'web-task-1', type: 'function', function: { name: 'web_task', arguments: JSON.stringify({ task: 'Confirm the page is ready', backend: 'fast' }) } }] }, finish_reason: null }] })
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        + sse({ choices: [], usage: { prompt_tokens: 4000, completion_tokens: 10 } })
        + 'data: [DONE]\n\n';
    } else if (hasTools) {
      mainRequests++;
      response = sse({ choices: [{ index: 0, delta: { content: 'The page is ready.' }, finish_reason: null }] })
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        + sse({ choices: [], usage: { prompt_tokens: 4000, completion_tokens: 10 } })
        + 'data: [DONE]\n\n';
    } else {
      nestedRequests++;
      const system = payload.messages?.[0]?.content ?? '';
      const content = system.startsWith('You check whether a browser task is finished.')
        ? '{"met":true,"missing":null}'
        : '{"operation":"DONE"}';
      response = sse({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        + sse({ choices: [], usage: { prompt_tokens: 4000, completion_tokens: 5 } })
        + 'data: [DONE]\n\n';
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });

  let observations = 0;
  const browser = {
    cdp: { calls: 0 },
    observe: async () => ({ url: 'https://example.test/', title: 'Example', text: 'Ready', actions: [], fingerprint: String(++observations) }),
    fresh: async () => true,
    close: async () => {},
  };
  const { runAgent } = await import('../src/agent.js');
  const events = [];
  for await (const event of runAgent({
    target: { provider: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'web-test', keyEnv: 'OX_API_KEY' },
    messages: [{ role: 'user', content: 'Confirm the page is ready.' }],
    ctx: { cwd: home, yolo: true, fastBrowser: browser, noSkills: true },
    config: { modelOverrides: { 'web-test': { in: 2, out: 4 } } },
    maxIterations: 5,
  })) events.push(event);

  assert.equal(mainRequests, 2);
  assert.equal(nestedRequests, 2, 'active model must make the action and independent completion-check requests');
  const total = events.find((event) => event.type === 'usage-total');
  assert.equal(total.inputTokens, 16000, 'parent 8000 + browser planner 8000 input tokens');
  assert.equal(total.outputTokens, 30, 'parent 20 + browser planner 10 output tokens');
  assert.equal(total.costUsd, 0.03212, 'the parent price override includes both browser planner calls');
  assert.equal(events.filter((event) => event.type === 'usage').length, 4);
  assert.equal(events.find((event) => event.type === 'final')?.message?.content, 'The page is ready.');
});
