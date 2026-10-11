import { turn, countExecuted } from '../harness.mjs';

export default {
  name: '10-mcp-end-to-end',
  description: 'stdio MCP fixture server: tools/list → tools/call echo → answer',
  category: 'integrations',
  prompt: 'Call the mcp__fixt__echo tool with {"msg":"BENCH-PING"} and report its exact output.',
  extraArgs: ['-y'],
  tokensPerTurn: { in: 950, out: 90 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    const fixturePath = `${sb.ws}/mcp-fixture.js`;
    writeWs(sb, 'mcp-fixture.js', [
      '// bench MCP fixture: legacy stdio handshake + echo tool',
      "import readline from 'node:readline';",
      'const rl = readline.createInterface({ input: process.stdin });',
      "rl.on('line', (line) => {",
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      "  if (msg.id == null) return; // notifications ignored",
      "  if (msg.method === 'initialize') {",
      '    respond(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixt", version: "0.0.1" } });',
      "  } else if (msg.method === 'ping') {",
      '    respond(msg.id, {});',
      "  } else if (msg.method === 'tools/list') {",
      "    respond(msg.id, { tools: [{ name: 'echo', description: 'Echo back the provided message.', inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }] });",
      "  } else if (msg.method === 'tools/call') {",
      '    respond(msg.id, { content: [{ type: "text", text: "ECHO[" + JSON.stringify(msg.params.arguments) + "]" }] });',
      '  } else {',
      '    respondErr(msg.id, -32601, "method not found: " + msg.method);',
      '  }',
      '});',
      'function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }',
      'function respondErr(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n"); }',
      '',
    ].join('\n'));
    writeWs(sb, '.mcp.json', JSON.stringify({ mcpServers: { fixt: { command: process.execPath, args: [fixturePath] } } }, null, 2));
  },

  async script(body, ws, state) {
    if (!countExecuted(body, 'mcp__fixt__echo')) {
      return turn({ calls: [{ id: 'call_mcp1', name: 'mcp__fixt__echo', args: { msg: 'BENCH-PING' } }] });
    }
    const lastTool = body.messages.filter((m) => m.role === 'tool').pop();
    state.flags.echoResult = String(lastTool?.content ?? '');
    return turn({ text: `The tool returned: ${state.flags.echoResult}` });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode} stderr=${r.stderr.slice(0, 240)}` };
    const starts = r.events.filter((e) => e.t === 'tool-start' && e.name === 'mcp__fixt__echo').length;
    const end = r.events.find((e) => e.t === 'tool-end' && e.name === 'mcp__fixt__echo');
    if (starts !== 1) return { pass: false, detail: `mcp__fixt__echo called ${starts}x` };
    if (!end || !end.ok) return { pass: false, detail: `MCP call failed: ${JSON.stringify(end)}` };
    const echoed = r.flags.echoResult ?? '';
    if (!echoed.includes('ECHO[') || !echoed.includes('BENCH-PING')) {
      return { pass: false, detail: `echo payload wrong: ${echoed.slice(0, 160)}` };
    }
    const final = r.events.find((e) => e.t === 'final');
    if (!String(final?.message?.content ?? '').includes('BENCH-PING')) return { pass: false, detail: 'payload did not reach final answer' };
    return { pass: true, detail: 'end-to-end MCP round-trip verified' };
  },
};
