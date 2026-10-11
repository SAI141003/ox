import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const KANBAN_SCHEMA_VERSION = '1.0.0';

const STATUSES = ['backlog', 'todo', 'in-progress', 'review', 'done'];

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return { tasks: {}, runs: {} };
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return { tasks: {}, runs: {} }; }
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function createKanban(cwd) {
  const dataFile = path.join(cwd, 'kanban.json');
  function load() { return readJSON(dataFile); }

  return {
    createTask(title, description, assignee = null, labels = [], dependencies = []) {
      const data = load();
      const id = randomUUID();
      const task = { id, title, description, status: 'backlog', assignee, labels, dependencies, createdAt: Date.now(), updatedAt: Date.now(), result: null, retries: 0 };
      data.tasks[id] = task;
      writeJSON(dataFile, data);
      return task;
    },
    listTasks(status = null) {
      const data = load();
      const tasks = Object.values(data.tasks);
      return status ? tasks.filter(t => t.status === status) : tasks;
    },
    getTask(id) { return load().tasks[id] || null; },
    updateTask(id, patch) {
      const data = load();
      const task = data.tasks[id];
      if (!task) throw new Error(`Task ${id} not found`);
      Object.assign(task, patch, { updatedAt: Date.now() });
      writeJSON(dataFile, data);
      return task;
    },
    claimTask(id, agent) {
      return this.updateTask(id, { status: 'in-progress', assignee: agent, updatedAt: Date.now() });
    },
    completeTask(id, result = null) {
      return this.updateTask(id, { status: 'done', result, updatedAt: Date.now() });
    },
    failTask(id, error = '') {
      const data = load();
      const task = data.tasks[id];
      if (!task) throw new Error(`Task ${id} not found`);
      task.retries++;
      task.updatedAt = Date.now();
      task.error = error;
      writeJSON(dataFile, data);
      return task;
    },
    swarm(config = {}) {
      const data = load();
      const root = config.rootTask || this.createTask(config.title || 'Swarm', config.description || '', config.assignee, config.labels, config.dependencies);
      root.status = 'in-progress';
      root.updatedAt = Date.now();
      data.tasks[root.id] = root;
      const workers = (config.workers || 3).toString();
      const subtasks = [];
      for (let i = 0; i < workers; i++) {
        const sub = this.createTask(`Subtask ${i + 1} of ${root.title}`, `Auto-decomposed from: ${root.title}`, config.assignee, ['swarm-worker'], [root.id]);
        subtasks.push(sub);
      }
      const verifier = this.createTask(`Verify: ${root.title}`, 'Verification subtask', config.assignee, ['swarm-verifier'], subtasks.map(s => s.id));
      verifier.status = 'todo';
      const synthesizer = this.createTask(`Synthesize: ${root.title}`, 'Synthesis subtask', config.assignee, ['swarm-synthesizer'], [verifier.id]);
      synthesizer.status = 'todo';
      data.tasks[root.id] = root;
      writeJSON(dataFile, data);
      return { root, subtasks, verifier, synthesizer };
    },
    getBoard() {
      const data = load();
      const board = {};
      for (const s of STATUSES) board[s] = [];
      for (const t of Object.values(data.tasks)) {
        if (board[t.status]) board[t.status].push(t);
      }
      return board;
    },
  };
}

export class KanbanSwarm {
  constructor(kanban, config = {}) {
    this.kanban = kanban;
    this.config = { modelOverrides: {}, worktreeBase: '/tmp/ox-swarm', claimTTL: 600000, retryFingerprint: true, ...config };
    this._graph = null;
  }
  decompose(task) {
    const subtasks = [];
    const steps = ['analyze', 'implement', 'test', 'document'];
    for (const step of steps) {
      const id = `sub-${step}-${Date.now().toString(36)}`;
      subtasks.push({ id, title: `${step}: ${task.title}`, parentId: task.id, status: 'backlog', assignee: task.assignee, labels: ['decomposed'], dependencies: [task.id], createdAt: Date.now(), updatedAt: Date.now(), result: null, retries: 0 });
    }
    this._graph = { parent: task, subtasks };
    return this._graph;
  }
  swarm(config) {
    const rootTask = this.kanban.createTask(config.title || 'Swarm Task', config.description || '', config.assignee, config.labels, config.dependencies);
    const workerCount = config.workers || 4;
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      const w = this.kanban.createTask(`Worker ${i + 1}`, `Parallel worker`, config.assignee, ['worker'], [rootTask.id]);
      workers.push(w);
    }
    const verifier = this.kanban.createTask('Verify', 'Gated verifier', config.assignee, ['verifier'], workers.map(w => w.id));
    verifier.status = 'todo';
    const synthesizer = this.kanban.createTask('Synthesize', 'Gated synthesizer', config.assignee, ['synthesizer'], [verifier.id]);
    synthesizer.status = 'todo';
    this._graph = { root: rootTask, workers, verifier, synthesizer, config: this.config };
    return this._graph;
  }
}
