// `blocked` is the fourth state the persistent goal needs to report honestly
// (src/goal.js counts it separately). Additive: every status the tool accepted
// before still validates, so no existing caller or transcript changes shape.
const STATUSES = ['pending', 'in_progress', 'blocked', 'completed'];
const PRIORITIES = ['high', 'medium', 'low'];
const ICONS = { pending: '[ ]', in_progress: '[-]', blocked: '[!]', completed: '[x]' };

function err(message) {
  return { content: message, isError: true };
}

export function renderTodos(todos) {
  if (!Array.isArray(todos) || todos.length === 0) {
    return 'Todo list is empty.';
  }
  const counts = { pending: 0, in_progress: 0, completed: 0, blocked: 0 };
  for (const t of todos) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const lines = todos.map((t, i) => {
    const priority = t.priority ? ` (${t.priority})` : '';
    const blocked = t.status === 'blocked' && t.blockedReason ? ` (${t.blockedReason})` : '';
    return `${i + 1}. ${ICONS[t.status] ?? '[ ]'} ${t.content}${priority}${blocked}`;
  });
  const summary = `${todos.length} item(s): ${counts.completed} completed · ${counts.in_progress} in_progress · ${counts.blocked} blocked · ${counts.pending} pending`;
  return `${lines.join('\n')}\n${summary}`;
}

export async function todoWriteTool(args = {}, ctx = {}) {
  const todos = args.todos;
  if (!Array.isArray(todos)) {
    return err("todo_write: 'todos' must be an array of {content, status, priority?}.");
  }
  const clean = [];
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i];
    if (t == null || typeof t !== 'object' || Array.isArray(t)) {
      return err(`todo_write: todos[${i}] must be an object.`);
    }
    const content = typeof t.content === 'string' ? t.content.trim() : '';
    if (!content) {
      return err(`todo_write: todos[${i}].content must be a non-empty string.`);
    }
    if (!STATUSES.includes(t.status)) {
      return err(
        `todo_write: todos[${i}].status '${String(t.status)}' is invalid — expected one of: ${STATUSES.join(', ')}.`
      );
    }
    if (t.priority !== undefined && !PRIORITIES.includes(t.priority)) {
      return err(
        `todo_write: todos[${i}].priority '${String(t.priority)}' is invalid — expected one of: ${PRIORITIES.join(', ')}.`
      );
    }
    const entry = { content, status: t.status };
    if (t.priority !== undefined) entry.priority = t.priority;
    // A blocked item must say WHY, otherwise "blocked" is indistinguishable from
    // "gave up" and the goal report cannot tell the user what to unblock.
    if (t.status === 'blocked') {
      const why = typeof t.blockedReason === 'string' ? t.blockedReason.trim() : '';
      entry.blockedReason = why.slice(0, 200) || 'no reason given';
    }
    clean.push(entry);
  }
  if (ctx.sessionState == null || typeof ctx.sessionState !== 'object') {
    ctx.sessionState = {};
  }
  ctx.sessionState.todos = clean;
  // "Published" is what distinguishes a model that CLEARED its checklist by
  // calling this with `[]` from a run that has simply never called it. Without the
  // marker an untouched empty list is indistinguishable from a deliberate reset,
  // and a fresh process would wipe a checklist the transcript still holds.
  ctx.sessionState.todosPublished = true;
  return { content: renderTodos(clean) };
}
