import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const TASKS_DIR = path.join(os.homedir(), '.ox', 'tasks');

function ensureTasksDir() {
  if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }
}

function taskPath(id) {
  return path.join(TASKS_DIR, `${id}.json`);
}

function listTasks() {
  ensureTasksDir();
  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function getTask(id) {
  const p = taskPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function addTask(task) {
  ensureTasksDir();
  const id = task.id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const full = {
    id,
    title: task.title || 'Untitled',
    description: task.description || '',
    status: task.status || 'pending',
    createdAt: now,
    updatedAt: now,
    cron: task.cron || null,
    tags: task.tags || [],
  };
  fs.writeFileSync(taskPath(id), JSON.stringify(full, null, 2));
  return full;
}

function updateTask(id, updates) {
  const existing = getTask(id);
  if (!existing) return null;
  const updated = {
    ...existing,
    ...updates,
    id,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(taskPath(id), JSON.stringify(updated, null, 2));
  return updated;
}

function deleteTask(id) {
  const p = taskPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

function runTask(id) {
  const task = getTask(id);
  if (!task) return { success: false, error: 'Task not found' };

  updateTask(id, { status: 'running' });

  return new Promise((resolve) => {
    const args = ['-p', task.title, task.description].filter(Boolean);
    execFile('ox', args, { timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        updateTask(id, { status: 'failed', error: error.message });
        resolve({ success: false, error: error.message, stdout, stderr });
      } else {
        updateTask(id, { status: 'done' });
        resolve({ success: true, stdout, stderr });
      }
    });
  });
}

export {
  TASKS_DIR,
  ensureTasksDir,
  listTasks,
  getTask,
  addTask,
  updateTask,
  deleteTask,
  runTask,
};
