// Self-improvement loop: implements the Reflexion pattern from the playbook.
// After failures, generates a self-critique; after successes, extracts
// reusable patterns; periodically reflects to update procedural memory.
//
// The key insight: an agent that learns from its own execution is qualitatively
// different from one that doesn't. This module provides the hooks.
//
// Public API:
//   generateCritique({ failure, history, config, target, cwd })
//     → { critique, suggestedApproach } — what went wrong + what to try next
//
//   buildReflectionPrompt({ failure, history, attempts })
//     → string — a structured prompt the model can respond to
//
//   extractPatterns({ sessionEvents, config, target, cwd })
//     → [{ type, pattern, taskType }] — reusable rules from the session
//
//   reflect({ cwd, config, target, sessionSummary })
//     → { recorded: number } — how many patterns were added to procedural memory

import { recordPattern, recallPatterns } from './procedural-memory.js';
import { detectTaskType } from './procedural-memory.js';
import { runAgent } from './agent.js';

// Build a structured reflection prompt from a failure. This is a pure
// function — no model call. The caller can feed it to the model or use
// the heuristic fallback.
export function buildReflectionPrompt({ failure, history = [], attempts = 1 }) {
  const lines = [
    '[self-reflection]',
    `A tool call just failed. Analyze what went wrong and suggest a different approach.`,
    '',
    `Tool: ${failure?.tool || 'unknown'}`,
    `Args: ${failure?.args ? JSON.stringify(failure.args).slice(0, 200) : 'none'}`,
    `Error: ${failure?.error?.slice(0, 300) || 'unknown'}`,
    `Attempts: ${attempts}`,
    '',
    'Recent history:',
  ];
  for (const h of history.slice(-3)) {
    lines.push(`  - ${typeof h === 'string' ? h.slice(0, 150) : JSON.stringify(h).slice(0, 150)}`);
  }
  lines.push('');
  lines.push('Respond with:');
  lines.push('critique: <what went wrong in 1-2 sentences>');
  lines.push('approach: <what to try differently in 1-2 sentences>');
  return lines.join('\n');
}

// Heuristic critique (used when no model is available).
function heuristicCritique(failure, attempts) {
  const tool = failure?.tool || 'unknown';
  const err = String(failure?.error || '').slice(0, 100);
  if (attempts >= 3) {
    return {
      critique: `Tool '${tool}' has failed ${attempts} times. The current approach is not working.`,
      suggestedApproach: 'Stop retrying. Report the blocker to the user with a clear summary of what was tried and what failed. Consider using a different tool entirely.',
    };
  }
  if (/permission|denied|forbidden/i.test(err)) {
    return {
      critique: `Tool '${tool}' was denied, likely a permission issue.`,
      suggestedApproach: 'Check if approval is needed, or if the path/command is in a restricted area. Ask the user for guidance if the action is necessary.',
    };
  }
  if (/not found|no such|does not exist/i.test(err)) {
    return {
      critique: `Tool '${tool}' target not found.`,
      suggestedApproach: 'Verify the path/identifier exists with list_dir or glob. Check for typos in the argument.',
    };
  }
  if (/timeout|timed out/i.test(err)) {
    return {
      critique: `Tool '${tool}' timed out.`,
      suggestedApproach: 'Reduce the scope of the operation, or break it into smaller steps. If it is a long-running command, increase the timeout.',
    };
  }
  return {
    critique: `Tool '${tool}' failed: ${err}`,
    suggestedApproach: 'Vary the input slightly. Read the target first to understand the current state. If the same call failed before, try a fundamentally different approach.',
  };
}

// Generate a self-critique after a failure. Uses the model if available,
// otherwise falls back to a heuristic.
export async function generateCritique({ failure, history = [], attempts = 1, config = {}, target, cwd }) {
  // Try the model first
  if (target || config?.target) {
    try {
      const t = target || config.target;
      const prompt = buildReflectionPrompt({ failure, history, attempts });
      let text = '';
      for await (const ev of runAgent({
        target: t,
        messages: [{ role: 'user', content: prompt }],
        ctx: {
          cwd: cwd || process.cwd(),
          allTools: [],
          enableSubagents: false,
          depth: 0,
          maxDepth: 0,
        },
        config,
        maxIterations: 1,
        auxTarget: null,
      })) {
        if (ev.type === 'final') {
          text = ev?.message?.content || '';
        } else if (ev.type === 'text-delta' && ev.text) {
          text += ev.text;
        }
      }
      // Parse the response
      const critiqueMatch = text.match(/critique:\s*([^\n]+)/i);
      const approachMatch = text.match(/approach:\s*([^\n]+)/i);
      if (critiqueMatch || approachMatch) {
        return {
          critique: critiqueMatch ? critiqueMatch[1].trim() : '',
          suggestedApproach: approachMatch ? approachMatch[1].trim() : '',
          raw: text,
        };
      }
    } catch {
      // fall through to heuristic
    }
  }
  return heuristicCritique(failure, attempts);
}

// Heuristic pattern extraction from session events.
function extractHeuristicPatterns(events) {
  const patterns = [];
  const toolsUsed = new Set();
  const successSeq = [];
  let hasError = false;
  for (const ev of events || []) {
    if (ev?.t === 'tool-start' || ev?.type === 'tool-start') {
      toolsUsed.add(ev.name);
    }
    if (ev?.t === 'tool-end' || ev?.type === 'tool-end') {
      if (!ev.isError) {
        successSeq.push(ev.name);
      } else {
        hasError = true;
      }
    }
  }
  // Common success sequences
  if (successSeq.includes('read_file') && successSeq.includes('edit_file')) {
    patterns.push({
      type: 'success',
      pattern: 'Read the file before editing it — check current state before making changes',
      taskType: detectTaskType([...toolsUsed]),
    });
  }
  if (successSeq.includes('grep') && successSeq.includes('read_file')) {
    patterns.push({
      type: 'success',
      pattern: 'Use grep to locate relevant code before reading full files',
      taskType: 'research',
    });
  }
  if (successSeq.includes('write_file') && !hasError) {
    patterns.push({
      type: 'success',
      pattern: 'Use write_file for new files (skips approval gate for brand-new files)',
      taskType: 'code',
    });
  }
  if (successSeq.filter((n) => n === 'edit_file').length >= 3) {
    patterns.push({
      type: 'success',
      pattern: 'For multi-file changes, use edit_file iteratively rather than write_file',
      taskType: 'code',
    });
  }
  return patterns;
}

// Extract patterns from a successful session. Uses heuristics when no
// model is available; uses the model to summarize when available.
export async function extractPatterns({ sessionEvents = [], config = {}, target, cwd, sessionSummary }) {
  // Heuristic extraction (always runs)
  const patterns = extractHeuristicPatterns(sessionEvents);

  // If we have a model and a session summary, ask it to extract more
  if ((target || config?.target) && sessionSummary) {
    try {
      const t = target || config.target;
      const toolsUsed = [...new Set((sessionEvents || []).flatMap((e) => (e?.name ? [e.name] : [])))];
      const prompt = `Analyze this session and extract 1-3 reusable patterns (rules that would help future sessions).

Task: ${sessionSummary.task || 'unknown'}
Tools used: ${toolsUsed.join(', ')}
Outcome: ${sessionSummary.outcome || 'completed'}
${sessionSummary.errors ? `Errors: ${sessionSummary.errors}` : ''}

Respond with JSON: {"patterns": [{"type": "success|failure", "pattern": "rule text", "taskType": "code|refactor|test|research|doc|general"}]}`;
      let text = '';
      for await (const ev of runAgent({
        target: t,
        messages: [{ role: 'user', content: prompt }],
        ctx: { cwd: cwd || process.cwd(), allTools: [], enableSubagents: false, depth: 0, maxDepth: 0 },
        config,
        maxIterations: 1,
        auxTarget: null,
      })) {
        if (ev.type === 'final') text = ev?.message?.content || '';
        else if (ev.type === 'text-delta' && ev.text) text += ev.text;
      }
      const m = text.match(/\{[\s\S]*"patterns"[\s\S]*\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]);
          if (Array.isArray(parsed.patterns)) {
            for (const p of parsed.patterns) {
              if (p && typeof p.pattern === 'string' && p.pattern.trim()) {
                patterns.push({
                  type: p.type === 'failure' ? 'failure' : 'success',
                  pattern: p.pattern.trim(),
                  taskType: ['code', 'refactor', 'test', 'research', 'doc'].includes(p.taskType) ? p.taskType : 'general',
                });
              }
            }
          }
        } catch { /* ignore parse errors */ }
      }
    } catch { /* ignore model errors */ }
  }
  return patterns;
}

// Reflect on a session and update procedural memory.
export async function reflect({ cwd, config = {}, target, sessionSummary = {} }) {
  const patterns = await extractPatterns({
    sessionEvents: sessionSummary.events || [],
    config,
    target,
    cwd,
    sessionSummary,
  });
  let recorded = 0;
  for (const p of patterns) {
    const r = recordPattern({ cwd, taskType: p.taskType, pattern: p.pattern, success: p.type === 'success' });
    if (r.recorded) recorded++;
  }
  return { recorded, total: patterns.length, patterns };
}
