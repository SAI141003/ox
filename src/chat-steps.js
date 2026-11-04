// What a step in the app's chat says. A step is shown as words ("Ran npm test", "Read stats.js"),
// not as the tool's JSON, and "allow this for the whole chat" is only offered for a command that is
// plainly one command, so a yes to `npm test` can never carry `npm test && rm -rf x` along with it.

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const base = (a) => String(a.path ?? a.file_path ?? a.file ?? '');

/** The command without what does not change what it does: a leading cd, 2>&1, a trailing head or tail. */
export function plainCommand(command) {
  return String(command ?? '').trim()
    .replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/, '')
    .replace(/\s*\|\s*(?:head|tail)(?:\s+-n?\s*\d+|\s+-\d+)?\s*$/, '')
    .replace(/\s*2>&1\s*$/, '')
    .trim();
}

/** What to show for a tool call: { v: 'Ran', vi: 'Running', what, kind }. */
export function stepLabel(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'bash': return { v: 'Ran', vi: 'Running', what: clip(plainCommand(a.command) || a.command, 200), kind: 'run' };
    case 'read_file': return { v: 'Read', vi: 'Reading', what: clip(base(a), 200), kind: 'look' };
    case 'list_dir': return { v: 'Listed', vi: 'Listing', what: clip(base(a) || '.', 200), kind: 'look' };
    case 'grep': return { v: 'Searched for', vi: 'Searching for', what: clip(a.pattern ?? a.query, 120), kind: 'look' };
    case 'glob': return { v: 'Looked for', vi: 'Looking for', what: clip(a.pattern, 120), kind: 'look' };
    case 'code_graph': return { v: 'Looked up', vi: 'Looking up', what: clip(a.query ?? a.symbol ?? a.action, 120), kind: 'look' };
    case 'web_search': return { v: 'Searched the web for', vi: 'Searching the web for', what: clip(a.query, 120), kind: 'look' };
    case 'web_fetch': return { v: 'Opened', vi: 'Opening', what: clip(a.url, 120), kind: 'look' };
    case 'write_file': case 'create_file': return { v: 'Wrote', vi: 'Writing', what: clip(base(a), 200), kind: 'edit', diff: { added: clip(a.content, 1200) } };
    case 'edit_file': return { v: 'Edited', vi: 'Editing', what: clip(base(a), 200), kind: 'edit', diff: { removed: clip(a.old_string, 1200), added: clip(a.new_string, 1200) } };
    case 'multi_edit': case 'apply_patch': return { v: 'Edited', vi: 'Editing', what: clip(base(a), 200), kind: 'edit' };
    case 'delete_file': return { v: 'Deleted', vi: 'Deleting', what: clip(base(a), 200), kind: 'edit' };
    case 'subagent': return { v: 'Asked a helper to', vi: 'Asking a helper to', what: clip(a.description ?? a.task ?? a.prompt, 120), kind: 'run' };
    case 'ask_agent': return { v: 'Asked', vi: 'Asking', what: clip(a.agent, 60), kind: 'run' };
    default: return { v: String(name ?? 'tool').replace(/_/g, ' '), vi: String(name ?? 'tool').replace(/_/g, ' '), what: clip(base(a) || a.query || a.url || a.action || '', 120), kind: 'run' };
  }
}

/**
 * What a "yes for this chat" covers, or null when it cannot be offered. File edits go by tool.
 * A command must be one plain command: nothing chained, substituted or redirected.
 */
export function allowKey(tool, detail) {
  if (/^(edit_file|write_file|create_file|multi_edit|apply_patch)$/.test(String(tool))) return String(tool) === 'write_file' || String(tool) === 'create_file' ? 'write' : 'edit';
  if (String(tool) !== 'bash') return null;
  const cmd = plainCommand(detail);
  if (!cmd || /[;&|<>`\n]|\$\(/.test(cmd)) return null;
  return `bash:${cmd}`;
}

/** Words for the offer, from allowKey's answer. */
export function allowWords(key) {
  if (key === 'edit') return 'Allow edits in this chat';
  if (key === 'write') return 'Allow new files in this chat';
  return key?.startsWith('bash:') ? `Always allow ${clip(key.slice(5), 40)} in this chat` : '';
}

/** A step's output for the page: the start and the end, since a failure's cause is usually at the end. */
export function stepOutput(text, max = 2400) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const lines = t.slice(0, max * 0.3).split('\n').slice(0, -1).join('\n');
  return `${lines}\n… ${(t.length - max).toLocaleString('en-US')} characters left out …\n${t.slice(-max * 0.7)}`;
}
