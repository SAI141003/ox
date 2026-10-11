import { turn, countExecuted } from '../harness.mjs';
import fs from 'node:fs';

// Subagent round-trip. The main model delegates a focused task to the `subagent`
// tool; ox spawns a nested agent loop (its own provider request stream) that
// runs, calls report_result, and propagates the structured result back to the
// main run, which then echoes it in its final answer. Proves the W6b subagent
// delegation + report_result plumbing end-to-end.
//
// Detection: the main run's tool list includes `subagent`; the nested loop's
// tool list excludes `subagent` (no self-nesting) but includes `report_result`
// (injected as the completion signal).
export default {
  name: '20-subagent-round-trip',
  description: 'main run delegates to subagent tool; nested loop reports back a structured result',
  category: 'subagent',
  prompt: 'Delegate to a subagent: spawn a subagent with task "Compute the answer to 6 times 7 and report it." and report its exact result.',
  extraArgs: ['-y'],
  tokensPerTurn: { in: 1100, out: 140 },
  model: 'grok-4.6',

  async script(body, ws, state) {
    // Detection: the SUBAGENT turn has `report_result` in its tools (injected
    // by runSubagent), while the MAIN turn does NOT. Both may have `subagent`
    // because enableSubagents is inherited.
    // Provider sends tools in OpenAI format: [{type:'function', function:{name:'read_file',...}}, ...]
    const toolNames = Array.isArray(body.tools) 
      ? body.tools.map(t => t?.function?.name ?? t?.name).filter(Boolean)
      : [];
    const hasReportTool = toolNames.includes('report_result');
    const hasSubagentTool = toolNames.includes('subagent');

    // Debug: log tools for each request
    const rawTools = Array.isArray(body.tools) ? JSON.stringify(body.tools.slice(0,2)) : 'no-tools-key';
    fs.appendFileSync('/tmp/mock_debug.log', `[MOCK] req#${state.requests.length + 1} bodyKeys=[${Object.keys(body).join(',')}] rawTools=${rawTools} parsedTools=[${toolNames.join(',')}] hasReport=${hasReportTool} hasSubagent=${hasSubagentTool}\n`);

    if (hasReportTool) {
      // SUBAGENT turn: the nested loop has report_result available.
      state.flags.subagentRequests = (state.flags.subagentRequests ?? 0) + 1;
      if (!countExecuted(body, 'report_result')) {
        return turn({ calls: [{ id: 'call_rep1', name: 'report_result', args: { output: 'The answer is 42.' } }] });
      }
      return turn({ text: 'Subagent complete.' });
    }

    // MAIN turn: delegate to subagent.
    state.flags.mainRequests = (state.flags.mainRequests ?? 0) + 1;
    if (!countExecuted(body, 'subagent')) {
      return turn({ calls: [{ id: 'call_sa1', name: 'subagent', args: { task: 'Compute the answer to 6 times 7 and report it.' } }] });
    }
    const lastTool = body.messages.filter((m) => m.role === 'tool').pop();
    const toolContent = String(lastTool?.content ?? '');
    state.flags.mainSawSubagentResult = toolContent.includes('42');
    if (toolContent.includes('error') || toolContent.includes('Error') || toolContent.includes('failed')) {
      state.flags.subagentError = toolContent.slice(0, 400);
    }
    return turn({ text: `Delegation complete. The subagent reported: ${extractResult(toolContent)}` });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode} stderr=${r.stderr.slice(0, 200)}` };
    if ((r.flags.mainRequests ?? 0) < 1) return { pass: false, detail: 'main run never reached provider' };
    if ((r.flags.subagentRequests ?? 0) < 1) return { pass: false, detail: `nested subagent loop never reached provider (flags=${JSON.stringify(r.flags)}) stderr=${r.stderr.slice(0, 300)}` };

    const subagentStarts = r.events.filter((e) => e.t === 'tool-start' && e.name === 'subagent');
    if (!subagentStarts.length) return { pass: false, detail: 'main run never invoked subagent tool' };
    const subagentEnds = r.events.filter((e) => e.t === 'tool-end' && e.name === 'subagent');
    if (!subagentEnds.length) return { pass: false, detail: 'subagent tool never completed' };

    const final = [...r.events].reverse().find((e) => e.t === 'final');
    const text = String(final?.message?.content ?? '');
    if (!text.includes('42')) return { pass: false, detail: `final answer missing subagent result: "${text.slice(0, 160)}"` };
    if (!r.flags.mainSawSubagentResult) return { pass: false, detail: 'main run did not receive subagent result' };
    return { pass: true, detail: `delegated → subagent ran ${r.flags.subagentRequests} turn(s), reported 42; final echoed it` };
  },
};

function extractResult(content) {
  try {
    const c = typeof content === 'string' ? content : '';
    const m = c.match(/result:\s*([^\n]+)/);
    return m ? m[1].trim() : c.slice(0, 120);
  } catch {
    return '';
  }
}