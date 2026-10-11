import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { turn, countExecuted, toolResultsIn, finalTextOf, parseNdjsonEvents } from '../harness.mjs';

// Shared MCP fixture: a local node:http JSON-RPC echo server (same shape the
// v3a tests use) hosted by the runner process on loopback. `calls` counts
// tools/call requests so checks can prove whether the fixture was reached.
function startFixture() {
  const state = { calls: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d.toString()));
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(raw || '{}'); } catch {}
      let result;
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: msg.params?.protocolVersion ?? '?',
          capabilities: { tools: {} },
          serverInfo: { name: 't', version: '1.0.0' },
        };
      } else if (msg.method === 'tools/list') {
        result = {
          tools: [
            {
              name: 'echo',
              description: 'Echo back the provided message.',
              inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
            },
          ],
        };
      } else if (msg.method === 'tools/call') {
        state.calls++;
        result = { content: [{ type: 'text', text: `ECHO[${JSON.stringify(msg.params?.arguments ?? {})}]` }] };
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: `no such method: ${msg.method}` } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/mcp` }));
  });
}

async function closeServer(srv) {
    if (!srv) return;
  // Raw node:http servers take a callback; harness mock wrappers return a
  // promise from close(). Handle both shapes without hanging.
  try {
    if (typeof srv.close === 'function' && srv.close.length > 0) {
      try { srv.closeAllConnections?.(); } catch {}
      await new Promise((r) => srv.close(() => r()));
    } else {
      await srv.close();
    }
  } catch {}
}

function scriptFor(marker) {
  return async (body) => {
    if (!countExecuted(body, 'mcp__t__echo')) {
      return turn({ calls: [{ id: `call_${marker}`, name: 'mcp__t__echo', args: { msg: marker } }] });
    }
    const toolMsgs = toolResultsIn(body, 'mcp__t__echo');
    const last = String(toolMsgs[toolMsgs.length - 1]?.content ?? '');
    const refused = toolMsgs.some(
      (m) => String(m.content).includes('declined') || String(m.content).includes('Blocked by policy')
    );
    return turn({
      text: refused
        ? `Stopped: the ${marker} echo call was refused (${last.slice(0, 80)})`
        : `The tool returned ${last}`,
    });
  };
}

export default {
  name: '19-mcp-policy',
  description: 'risk-gated MCP policy engine: default ask declines in non-TTY; .ox.json allow executes end-to-end',
  category: 'integrations',

  async run(h) {
    const fixture = await startFixture();
    fs.writeFileSync(
      path.join(h.sb.ws, '.mcp.json'),
      `${JSON.stringify({ mcpServers: { t: { type: 'http', url: fixture.url } } }, null, 2)}\n`
    );
    try {
      // PHASE A — default policy (ask): non-TTY headless must decline without
      // ever reaching the fixture; exit per the denial contract (2).
      const serverA = await h.startMock({ script: scriptFor('POLICY-A'), ws: h.sb.ws });
      const envA = h.deterministicEnv({ home: h.sb.home, baseUrl: serverA.url });
      const runA = await h.spawnOx({
        args: ['-p', 'Call the mcp__t__echo tool with {"msg":"POLICY-A"} and report its exact output.', '--json'],
        env: envA,
        cwd: h.sb.ws,
        timeoutMs: 25_000,
      });
      await closeServer(serverA);
      const fixtureCallsAfterA = fixture.state.calls;
      const eventsA = parseNdjsonEvents(runA.stdout);

      // PHASE B — project .ox.json allow-lists the same server: the identical
      // call executes against the shared fixture and the echo reaches the final.
      fs.writeFileSync(
        path.join(h.sb.ws, '.ox.json'),
        `${JSON.stringify({ mcpPolicy: { t: 'allow' } }, null, 2)}\n`
      );
      const serverB = await h.startMock({ script: scriptFor('POLICY-B'), ws: h.sb.ws });
      const envB = h.deterministicEnv({ home: h.sb.home, baseUrl: serverB.url });
      const runB = await h.spawnOx({
        args: ['-p', 'Call the mcp__t__echo tool with {"msg":"POLICY-B"} and report its exact output.', '--json'],
        env: envB,
        cwd: h.sb.ws,
        timeoutMs: 25_000,
      });
      await closeServer(serverB);
      const eventsB = parseNdjsonEvents(runB.stdout);

      return {
        events: eventsA,
        exitCode: runA.exitCode,
        stdout: runA.stdout,
        stderr: runA.stderr,
        fixtureCallsAfterA,
        eventsB,
        exitCodeB: runB.exitCode,
        stdoutB: runB.stdout,
        stderrB: runB.stderr,
        fixtureCallsTotal: fixture.state.calls,
      };
    } finally {
      await closeServer(fixture.server);
    }
  },

  async check(r) {
    if ((r.fixtureCallsAfterA ?? -1) !== 0) {
      return { pass: false, detail: `PART A: fixture saw ${r.fixtureCallsAfterA} tools/call — policy gate leaked` };
    }
    if (r.exitCode !== 2) {
      return { pass: false, detail: `PART A: expected exit 2 (denial contract), got ${r.exitCode}; stderr=${String(r.stderr ?? '').slice(0, 160)}` };
    }
    const declinedToModel =
      String(r.stdout ?? '').includes('"User declined this action') ||
      (r.events ?? []).some((e) => e.t === 'final' && String(e.message?.content ?? '').includes('refused'));
    if (!declinedToModel) return { pass: false, detail: 'PART A: decline never surfaced to the model/final' };

    if (!(r.eventsB ?? []).length) return { pass: false, detail: `PART B produced no events: stderr=${String(r.stderrB ?? '').slice(0, 160)}` };
    if (r.exitCodeB !== 0) return { pass: false, detail: `PART B: expected exit 0, got ${r.exitCodeB}; stdout=${String(r.stdoutB ?? '').slice(0, 240)}` };
    const endB = r.eventsB.find((e) => e.t === 'tool-end' && e.name === 'mcp__t__echo');
    if (!endB || !endB.ok) return { pass: false, detail: `PART B: echo did not execute ok (${JSON.stringify(endB)})` };
    const finalText = finalTextOf(r.eventsB);
    if (!finalText.includes('ECHO[') || !finalText.includes('POLICY-B')) {
      return { pass: false, detail: `PART B: echo payload missing from final answer: ${String(finalText).slice(0, 160)}` };
    }
    if ((r.fixtureCallsTotal ?? 0) < 1) return { pass: false, detail: 'PART B: fixture never received a tools/call' };
    return {
      pass: true,
      detail: 'PART A declined at the gate (fixture untouched, exit 2); PART B executed via .ox.json allow with echo in final',
    };
  },
};
