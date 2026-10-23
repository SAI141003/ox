// `task_board` - the agent's side of the task board (src/tasks.js).
//
// Offered only to an agent woken FOR a task (`ox task run` sets OX_TASK_ID),
// the way Paperclip hands an agent its ticket: it reads the brief, files
// subtasks for what it finds, leaves notes, and finishes (or hands over for
// review). It never claims other people's work: `next` only runs when the
// agent's own task is finished.

import {
  addTask, blockTask, commentTask, completeTask, getTask, heartbeatTask, linkTask,
  nextTask, taskBrief, unblockTask, updateTask,
} from '../tasks.js';

export const TASK_BOARD_TOOLS = ['task_board'];

export const TASK_BOARD_TOOL_SCHEMAS = [
  {
    name: 'task_board',
    description:
      'Your task on the ox task board. action "brief": your task, the goals above it and recent notes. ' +
      '"note": add a progress note. "add": file a follow-up task (title; it goes under your task). ' +
      '"done": finish your task with a summary note (it goes to review if review is required). ' +
      '"comment": leave an attributed handoff note, "heartbeat": report liveness, ' +
      '"block"/"unblock": pause or resume with a reason, "link": attach an http(s) artifact, ' +
      '"next": after done, take the next ready task.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['brief', 'note', 'add', 'done', 'comment', 'heartbeat', 'block', 'unblock', 'link', 'next'] },
        text: { type: 'string', description: 'The note, summary, block reason, or title for add.' },
        url: { type: 'string', description: 'http(s) artifact URL for action link.' },
        label: { type: 'string', description: 'Optional label for action link.' },
      },
      required: ['action'],
    },
  },
];

/** The task this agent was started for, if any. */
export function currentTaskId(ctx = {}) {
  return ctx.taskId ?? process.env.OX_TASK_ID ?? null;
}

export async function taskBoardTool(args = {}, ctx = {}) {
  const id = currentTaskId(ctx);
  const owner = ctx.agentName ?? process.env.OX_AGENT_NAME ?? 'ox-run';
  const opts = { owner, actor: owner, ...(ctx.taskDir ? { dir: ctx.taskDir } : {}) };
  const text = String(args.text ?? '').trim();
  const err = (m) => ({ content: `task_board: ${m}`, isError: true });
  if (!id) return err('this run was not started for a task (ox task run sets one).');
  const task = getTask(id, opts);
  if (!task) return err(`task ${id} is gone from the board.`);
  switch (args.action) {
    case 'brief':
      return { content: taskBrief(id, opts) };
    case 'note': {
      if (!text) return err('note needs text.');
      updateTask(id, { comments: [...task.comments, { by: owner, at: new Date().toISOString(), text: text.slice(0, 1000) }] }, opts);
      return { content: 'noted' };
    }
    case 'comment': {
      const r = commentTask(id, text, opts);
      return r.ok ? { content: 'commented' } : err(r.reason);
    }
    case 'heartbeat': {
      const r = heartbeatTask(id, opts);
      return r.ok ? { content: `heartbeat ${r.heartbeatAt}` } : err(r.reason);
    }
    case 'block': {
      const r = blockTask(id, text, opts);
      return r.ok ? { content: 'blocked; the task is available for an operator to unblock' } : err(r.reason);
    }
    case 'unblock': {
      const r = unblockTask(id, opts);
      return r.ok ? { content: 'unblocked; task returned to ready queue' } : err(r.reason);
    }
    case 'link': {
      const r = linkTask(id, { url: args.url ?? text, label: args.label }, opts);
      return r.ok ? { content: `linked ${r.link.url}` } : err(r.reason);
    }
    case 'add': {
      if (!text) return err('add needs a title in text.');
      const t = addTask({ title: text.slice(0, 200), parentId: id }, opts);
      return { content: `filed ${t.id}: ${t.title}` };
    }
    case 'done': {
      const r = completeTask(id, { ...opts, note: text || undefined, result: text || undefined });
      if (!r.ok) return err(r.reason);
      return { content: r.task.status === 'in_review' ? 'submitted for review' : 'done' };
    }
    case 'next': {
      if (!['done', 'in_review', 'failed', 'cancelled'].includes(task.status)) return err('finish your own task first (action "done").');
      const t = nextTask(opts);
      if (!t) return { content: 'nothing ready on the board' };
      if (ctx && typeof ctx === 'object') ctx.taskId = t.id;
      process.env.OX_TASK_ID = t.id;
      return { content: taskBrief(t.id, opts) };
    }
    default:
      return err('action must be brief, note, add, done, comment, heartbeat, block, unblock, link or next.');
  }
}
