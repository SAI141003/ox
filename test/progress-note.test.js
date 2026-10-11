import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { runAgent } from '../src/agent.js';

before(() => {
  process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-progress-note-key';
});

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function textTurn(text = '') {
  return [
    text ? sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) : '',
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
    'data: [DONE]\n\n',
  ].join('');
}

function callTurn(id, name, args) {
  return [
    sse({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
          finish_reason: null,
        },
      ],
    }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
    'data: [DONE]\n\n',
  ].join('');
}

function callAndTextTurn(callId, callName, callArgs, text) {
  return [
    sse({
      choices: [
        {
          index: 0,
          delta: {
            content: text,
            tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: callName, arguments: JSON.stringify(callArgs) } }],
          },
          finish_reason: null,
        },
      ],
    }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
    'data: [DONE]\n\n',
  ].join('');
}

async function startServer(t, classify) {
  const http = await import('node:http');
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let messages = [];
      try {
        messages = JSON.parse(body)?.messages ?? [];
      } catch {}
      requests.push(messages);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(classify(messages, requests.length));
    });
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests }))
  );
}

async function collectEvents(opts) {
  const events = [];
  for await (const ev of runAgent(opts)) events.push(ev);
  return events;
}

function tmpDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('progress-note reply handling', () => {
  test('tool calls with assistant text yields progress-note event and turn continues', async (t) => {
    const cwd = tmpDir(t, 'ox-pn-');
    let round = 0;
    const { port } = await startServer(t, () => {
      round++;
      if (round === 1) return callAndTextTurn('call_1', 'bash', { command: 'echo hi' }, 'Let me run that command');
      return textTurn('done');
    });

    const events = await collectEvents({
      target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' },
      messages: [{ role: 'user', content: 'run a command' }],
      ctx: { cwd, yolo: true },
      auxTarget: null,
      verify: false,
    });

    const progressNotes = events.filter((e) => e.type === 'progress-note');
    assert.equal(progressNotes.length, 1, 'expected exactly one progress-note event');
    assert.equal(progressNotes[0].text, 'Let me run that command');

    const toolStarts = events.filter((e) => e.type === 'tool-start');
    assert.equal(toolStarts.length, 1, 'expected tool to execute after progress note');

    const finalEvents = events.filter((e) => e.type === 'final');
    assert.equal(finalEvents.length, 1, 'expected turn to complete with final event');

    const historyEvent = events.find((e) => e.type === 'history');
    assert.ok(historyEvent, 'history event must be emitted');
    const progressInHistory = historyEvent.messages.some(
      (m) => m.role === 'assistant' && m.content === 'Let me run that command' && m.progressNote === true
    );
    assert.ok(progressInHistory, 'progress-note text must be preserved in history with progressNote flag');
  });

  test('tool calls with NO text yields no progress-note event', async (t) => {
    const cwd = tmpDir(t, 'ox-pn-notext-');
    let round = 0;
    const { port } = await startServer(t, () => {
      round++;
      if (round === 1) return callTurn('call_1', 'bash', { command: 'echo hi' });
      return textTurn('done');
    });

    const events = await collectEvents({
      target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' },
      messages: [{ role: 'user', content: 'run a command' }],
      ctx: { cwd, yolo: true },
      auxTarget: null,
      verify: false,
    });

    const progressNotes = events.filter((e) => e.type === 'progress-note');
    assert.equal(progressNotes.length, 0, 'expected no progress-note event when no text');

    const toolStarts = events.filter((e) => e.type === 'tool-start');
    assert.equal(toolStarts.length, 1, 'expected tool to execute');

    const finalEvents = events.filter((e) => e.type === 'final');
    assert.equal(finalEvents.length, 1, 'expected turn to complete');
  });

  test('NO tool calls (sole reply) ends the turn - existing behavior preserved', async (t) => {
    const cwd = tmpDir(t, 'ox-pn-nocalls-');
    let round = 0;
    const { port } = await startServer(t, () => {
      round++;
      return textTurn('final answer');
    });

    const events = await collectEvents({
      target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' },
      messages: [{ role: 'user', content: 'just answer' }],
      ctx: { cwd, yolo: true },
      auxTarget: null,
      verify: false,
    });

    const progressNotes = events.filter((e) => e.type === 'progress-note');
    assert.equal(progressNotes.length, 0, 'expected no progress-note event for sole reply');

    const assistantTurns = events.filter((e) => e.type === 'assistant-turn');
    assert.equal(assistantTurns.length, 0, 'expected no assistant-turn event for sole reply');

    const finalEvents = events.filter((e) => e.type === 'final');
    assert.equal(finalEvents.length, 1, 'expected final event for sole reply');

    const historyEvent = events.find((e) => e.type === 'history');
    assert.ok(historyEvent, 'history event must be emitted');
    const finalInHistory = historyEvent.messages.find(
      (m) => m.role === 'assistant' && m.content === 'final answer' && !m.progressNote
    );
    assert.ok(finalInHistory, 'final reply must be in history without progressNote flag');
  });

  test('progress-note text is preserved in history with progressNote flag', async (t) => {
    const cwd = tmpDir(t, 'ox-pn-hist-');
    let round = 0;
    const { port } = await startServer(t, () => {
      round++;
      if (round === 1) return callAndTextTurn('call_1', 'bash', { command: 'echo hi' }, 'Running command now');
      return textTurn('completed');
    });

    const events = await collectEvents({
      target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' },
      messages: [{ role: 'user', content: 'run a command' }],
      ctx: { cwd, yolo: true },
      auxTarget: null,
      verify: false,
    });

    const historyEvent = events.find((e) => e.type === 'history');
    assert.ok(historyEvent, 'history event must be emitted');

    const progressMsg = historyEvent.messages.find(
      (m) => m.role === 'assistant' && m.content === 'Running command now' && m.progressNote === true
    );
    assert.ok(progressMsg, 'progress-note message must be in history with progressNote: true');

    // Also verify the assistant-turn with tool_calls is in history
    const assistantTurn = historyEvent.messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    );
    assert.ok(assistantTurn, 'assistant turn with tool_calls must be in history');
    assert.equal(assistantTurn.content, 'Running command now', 'assistant turn should have the text content');
  });
});
