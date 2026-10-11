import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const AGENT_DIR = '.agent';
const PROFILE_FILE = 'PROFILE.md';
const VOLATILE_FILE = 'VOLATILE.md';

function getPath(cwd, file) {
  return join(cwd, AGENT_DIR, file);
}

function ensureAgentDir(cwd) {
  const agentDir = join(cwd, AGENT_DIR);
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
  }
}

function exists(cwd, file) {
  return existsSync(getPath(cwd, file));
}

function readFile(cwd, file) {
  try {
    return readFileSync(getPath(cwd, file), 'utf-8');
  } catch {
    return null;
  }
}

function writeFile(cwd, file, content) {
  ensureAgentDir(cwd);
  writeFileSync(getPath(cwd, file), content, 'utf-8');
}

function parseProfile(content) {
  const habits = [];
  const preferences = [];
  const facts = [];
  let current = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## Habits')) current = habits;
    else if (trimmed.startsWith('## Preferences')) current = preferences;
    else if (trimmed.startsWith('## Facts')) current = facts;
    else if (trimmed.startsWith('- ') && current) {
      current.push(trimmed.slice(2));
    }
  }

  return { habits, preferences, facts };
}

function parseVolatile(content) {
  let project = '';
  let task = '';
  let state = '';
  let current = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## Project')) current = 'project';
    else if (trimmed.startsWith('## Task')) current = 'task';
    else if (trimmed.startsWith('## State')) current = 'state';
    else if (current && !trimmed.startsWith('#')) {
      if (current === 'project') project = trimmed;
      else if (current === 'task') task = trimmed;
      else if (current === 'state') state = trimmed;
      current = null;
    }
  }

  return { project, task, state };
}

export function loadProfile(cwd) {
  const content = readFile(cwd, PROFILE_FILE);
  if (!content) {
    return { habits: [], preferences: [], facts: [], loadedAt: null };
  }
  const data = parseProfile(content);
  return { ...data, loadedAt: new Date().toISOString() };
}

export function loadVolatile(cwd) {
  const content = readFile(cwd, VOLATILE_FILE);
  if (!content) {
    return { project: '', task: '', state: '', loadedAt: null };
  }
  const data = parseVolatile(content);
  return { ...data, loadedAt: new Date().toISOString() };
}

export function saveProfile(cwd, { habits, preferences, facts }) {
  const lines = ['# User Profile'];
  if (habits.length) {
    lines.push('## Habits', ...habits.map(h => `- ${h}`));
  }
  if (preferences.length) {
    lines.push('## Preferences', ...preferences.map(p => `- ${p}`));
  }
  if (facts.length) {
    lines.push('## Facts', ...facts.map(f => `- ${f}`));
  }
  writeFile(cwd, PROFILE_FILE, lines.join('\n') + '\n');
}

export function saveVolatile(cwd, { project, task, state }) {
  const lines = [
    '# Current Context',
    '## Project',
    project || '',
    '## Task',
    task || '',
    '## State',
    state || ''
  ];
  writeFile(cwd, VOLATILE_FILE, lines.join('\n') + '\n');
}

export function formatProfileBlock(profile, volatile) {
  const habits = profile.habits.join(', ');
  const preferences = profile.preferences.join(', ');
  const project = volatile.project || '';
  const task = volatile.task || '';
  const state = volatile.state || '';

  const parts = ['## User Profile'];
  if (habits) parts.push(`Habits: ${habits}`);
  if (preferences) parts.push(`Preferences: ${preferences}`);
  parts.push('', '## Current Context');
  if (project) parts.push(`Project: ${project}`);
  if (task) parts.push(`Task: ${task}`);
  if (state) parts.push(`State: ${state}`);

  return parts.join('\n');
}

export function recordPreference(cwd, preference) {
  const content = readFile(cwd, PROFILE_FILE);
  let preferences = [];

  if (content) {
    const parsed = parseProfile(content);
    preferences = parsed.preferences;
  }

  if (!preferences.includes(preference)) {
    preferences.push(preference);
  }

  const habits = content ? parseProfile(content).habits : [];
  const facts = content ? parseProfile(content).facts : [];
  saveProfile(cwd, { habits, preferences, facts });
}

export function recordTaskContext(cwd, { project, task, state }) {
  saveVolatile(cwd, { project, task, state });
}
