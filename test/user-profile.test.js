import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadProfile,
  loadVolatile,
  saveProfile,
  saveVolatile,
  formatProfileBlock,
  recordPreference,
  recordTaskContext
} from '../src/user-profile.js';

function createTempDir() {
  return mkdtempSync(join(tmpdir(), 'user-profile-test-'));
}

function cleanupTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function createAgentDir(tempDir) {
  const agentDir = join(tempDir, '.agent');
  mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

describe('loadProfile', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('returns empty profile when no file exists', () => {
    const profile = loadProfile(tempDir);
    assert.deepStrictEqual(profile.habits, []);
    assert.deepStrictEqual(profile.preferences, []);
    assert.deepStrictEqual(profile.facts, []);
    assert.strictEqual(profile.loadedAt, null);
  });

  it('loads profile with data from file', () => {
    const content = `# User Profile
## Habits
- Habit 1
- Habit 2
## Preferences
- Pref 1
## Facts
- Fact 1`;
    
    const agentDir = createAgentDir(tempDir);
    writeFileSync(join(agentDir, 'PROFILE.md'), content, 'utf-8');
    
    const profile = loadProfile(tempDir);
    assert.deepStrictEqual(profile.habits, ['Habit 1', 'Habit 2']);
    assert.deepStrictEqual(profile.preferences, ['Pref 1']);
    assert.deepStrictEqual(profile.facts, ['Fact 1']);
    assert.ok(profile.loadedAt !== null);
  });
});

describe('loadVolatile', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('returns empty volatile when no file exists', () => {
    const volatile = loadVolatile(tempDir);
    assert.strictEqual(volatile.project, '');
    assert.strictEqual(volatile.task, '');
    assert.strictEqual(volatile.state, '');
    assert.strictEqual(volatile.loadedAt, null);
  });

  it('loads volatile with data from file', () => {
    const content = `# Current Context
## Project
My Project
## Task
My Task
## State
In Progress`;
    
    const agentDir = createAgentDir(tempDir);
    writeFileSync(join(agentDir, 'VOLATILE.md'), content, 'utf-8');
    
    const volatile = loadVolatile(tempDir);
    assert.strictEqual(volatile.project, 'My Project');
    assert.strictEqual(volatile.task, 'My Task');
    assert.strictEqual(volatile.state, 'In Progress');
    assert.ok(volatile.loadedAt !== null);
  });
});

describe('saveProfile', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('creates profile file with habits, preferences, facts', () => {
    saveProfile(tempDir, {
      habits: ['Habit 1', 'Habit 2'],
      preferences: ['Pref 1'],
      facts: ['Fact 1', 'Fact 2']
    });

    const filePath = join(tempDir, '.agent', 'PROFILE.md');
    assert.ok(existsSync(filePath));
    
    const content = readFileSync(filePath, 'utf-8');
    assert.ok(content.includes('# User Profile'));
    assert.ok(content.includes('## Habits'));
    assert.ok(content.includes('- Habit 1'));
    assert.ok(content.includes('- Habit 2'));
    assert.ok(content.includes('## Preferences'));
    assert.ok(content.includes('- Pref 1'));
    assert.ok(content.includes('## Facts'));
    assert.ok(content.includes('- Fact 1'));
    assert.ok(content.includes('- Fact 2'));
  });

  it('omits empty sections', () => {
    saveProfile(tempDir, {
      habits: ['Only Habit'],
      preferences: [],
      facts: []
    });

    const content = readFileSync(join(tempDir, '.agent', 'PROFILE.md'), 'utf-8');
    assert.ok(content.includes('## Habits'));
    assert.ok(content.includes('- Only Habit'));
    assert.ok(!content.includes('## Preferences'));
    assert.ok(!content.includes('## Facts'));
  });
});

describe('saveVolatile', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('creates volatile file with project, task, state', () => {
    saveVolatile(tempDir, {
      project: 'Test Project',
      task: 'Test Task',
      state: 'Active'
    });

    const filePath = join(tempDir, '.agent', 'VOLATILE.md');
    assert.ok(existsSync(filePath));
    
    const content = readFileSync(filePath, 'utf-8');
    assert.ok(content.includes('# Current Context'));
    assert.ok(content.includes('## Project'));
    assert.ok(content.includes('Test Project'));
    assert.ok(content.includes('## Task'));
    assert.ok(content.includes('Test Task'));
    assert.ok(content.includes('## State'));
    assert.ok(content.includes('Active'));
  });

  it('handles empty values', () => {
    saveVolatile(tempDir, {
      project: '',
      task: '',
      state: ''
    });

    const content = readFileSync(join(tempDir, '.agent', 'VOLATILE.md'), 'utf-8');
    assert.ok(content.includes('## Project\n\n'));
    assert.ok(content.includes('## Task\n\n'));
    assert.ok(content.includes('## State\n\n'));
  });
});

describe('formatProfileBlock', () => {
  it('formats profile with all fields', () => {
    const profile = {
      habits: ['Habit 1', 'Habit 2'],
      preferences: ['Pref 1', 'Pref 2'],
      facts: ['Fact 1']
    };
    const volatile = {
      project: 'Project A',
      task: 'Task B',
      state: 'State C'
    };

    const result = formatProfileBlock(profile, volatile);
    
    assert.ok(result.includes('## User Profile'));
    assert.ok(result.includes('Habits: Habit 1, Habit 2'));
    assert.ok(result.includes('Preferences: Pref 1, Pref 2'));
    assert.ok(result.includes('## Current Context'));
    assert.ok(result.includes('Project: Project A'));
    assert.ok(result.includes('Task: Task B'));
    assert.ok(result.includes('State: State C'));
  });

  it('omits empty habits and preferences', () => {
    const profile = {
      habits: [],
      preferences: [],
      facts: ['Fact 1']
    };
    const volatile = {
      project: '',
      task: 'Only Task',
      state: ''
    };

    const result = formatProfileBlock(profile, volatile);
    
    assert.ok(!result.includes('Habits:'));
    assert.ok(!result.includes('Preferences:'));
    assert.ok(!result.includes('Project:'));
    assert.ok(!result.includes('State:'));
    assert.ok(result.includes('Task: Only Task'));
  });

  it('handles empty arrays and strings gracefully', () => {
    const profile = { habits: [], preferences: [], facts: [] };
    const volatile = { project: '', task: '', state: '' };

    const result = formatProfileBlock(profile, volatile);
    
    assert.ok(result.includes('## User Profile'));
    assert.ok(result.includes('## Current Context'));
    assert.ok(!result.includes('Habits:'));
    assert.ok(!result.includes('Preferences:'));
    assert.ok(!result.includes('Project:'));
    assert.ok(!result.includes('Task:'));
    assert.ok(!result.includes('State:'));
  });
});

describe('recordPreference', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('adds new preference to empty profile', () => {
    recordPreference(tempDir, 'New Preference');

    const content = readFileSync(join(tempDir, '.agent', 'PROFILE.md'), 'utf-8');
    assert.ok(content.includes('- New Preference'));
  });

  it('adds preference to existing profile without duplicates', () => {
    // First create a profile with a preference
    saveProfile(tempDir, {
      habits: [],
      preferences: ['Existing Pref'],
      facts: []
    });

    recordPreference(tempDir, 'New Pref');
    recordPreference(tempDir, 'Existing Pref'); // duplicate

    const content = readFileSync(join(tempDir, '.agent', 'PROFILE.md'), 'utf-8');
    const lines = content.split('\n').filter(l => l.startsWith('- '));
    assert.strictEqual(lines.length, 2);
    assert.ok(content.includes('- Existing Pref'));
    assert.ok(content.includes('- New Pref'));
  });

  it('preserves existing habits and facts', () => {
    saveProfile(tempDir, {
      habits: ['Habit 1'],
      preferences: ['Pref 1'],
      facts: ['Fact 1']
    });

    recordPreference(tempDir, 'New Pref');

    const content = readFileSync(join(tempDir, '.agent', 'PROFILE.md'), 'utf-8');
    assert.ok(content.includes('- Habit 1'));
    assert.ok(content.includes('- Pref 1'));
    assert.ok(content.includes('- New Pref'));
    assert.ok(content.includes('- Fact 1'));
  });
});

describe('recordTaskContext', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('saves project, task, state to volatile file', () => {
    recordTaskContext(tempDir, {
      project: 'Project X',
      task: 'Task Y',
      state: 'State Z'
    });

    const content = readFileSync(join(tempDir, '.agent', 'VOLATILE.md'), 'utf-8');
    assert.ok(content.includes('Project X'));
    assert.ok(content.includes('Task Y'));
    assert.ok(content.includes('State Z'));
  });

  it('overwrites previous volatile data', () => {
    saveVolatile(tempDir, { project: 'Old', task: 'Old', state: 'Old' });
    
    recordTaskContext(tempDir, {
      project: 'New',
      task: 'New',
      state: 'New'
    });

    const content = readFileSync(join(tempDir, '.agent', 'VOLATILE.md'), 'utf-8');
    assert.ok(content.includes('New'));
    assert.ok(!content.includes('Old'));
  });
});
