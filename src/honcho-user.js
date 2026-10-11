import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HONCHO_SCHEMA_VERSION = '1.0.0';
const LIST_FIELDS = ['preferences', 'habits', 'facts', 'projects', 'expertise', 'goals'];

function profileFile() {
  return join(homedir(), '.ox', 'honcho', 'profile.json');
}

function cleanProfile(profile = {}) {
  const result = {
    preferences: [],
    habits: [],
    facts: [],
    projects: [],
    communicationStyle: {},
    expertise: [],
    goals: [],
  };
  for (const field of LIST_FIELDS) {
    const values = Array.isArray(profile[field]) ? profile[field] : [];
    result[field] = [...new Set(values.map(String).filter(Boolean))];
  }
  if (profile.communicationStyle && typeof profile.communicationStyle === 'object') {
    result.communicationStyle = { ...profile.communicationStyle };
  }
  return result;
}

function merge(target, values) {
  const additions = Array.isArray(values) ? values : values ? [values] : [];
  for (const value of additions.map(String).filter(Boolean)) {
    if (!target.includes(value)) target.push(value);
  }
}

function inferObservation(observation) {
  const inferred = {
    preferences: [],
    habits: [],
    facts: [],
    projects: [],
    expertise: [],
    goals: [],
  };
  const task = String(observation.task || observation.name || '').toLowerCase();
  if (observation.preference) merge(inferred.preferences, observation.preference);
  if (observation.habit) merge(inferred.habits, observation.habit);
  if (observation.fact) merge(inferred.facts, observation.fact);
  if (observation.project) merge(inferred.projects, observation.project);
  if (observation.expertise) merge(inferred.expertise, observation.expertise);
  if (observation.goal) merge(inferred.goals, observation.goal);
  if (task && observation.outcome === 'success') merge(inferred.expertise, task.slice(0, 80));
  if (observation.communicationStyle && typeof observation.communicationStyle === 'object') {
    inferred.communicationStyle = observation.communicationStyle;
  }
  return inferred;
}

export function createUserModel(cwd = process.cwd()) {
  const file = profileFile();
  const model = {
    cwd,
    file,
    state: cleanProfile(),
    observations: [],
    observe(interaction = {}) {
      const observation = interaction.observation && typeof interaction.observation === 'object'
        ? { ...interaction.observation }
        : { ...interaction };
      updateProfile(model, observation);
      model.observations.push({
        id: randomUUID(),
        timestamp: Date.now(),
        task: observation.task ?? observation.name ?? null,
        outcome: observation.outcome ?? null,
      });
      model.observations = model.observations.slice(-500);
      model.save();
      return model.profile();
    },
    dialectic() {
      return dialectic(model);
    },
    profile() {
      return JSON.parse(JSON.stringify(model.state));
    },
    save() {
      mkdirSync(join(homedir(), '.ox', 'honcho'), { recursive: true });
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ schemaVersion: HONCHO_SCHEMA_VERSION, profile: model.state }, null, 2)}\n`);
      renameSync(temp, file);
    },
    load() {
      if (!existsSync(file)) return false;
      try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        model.state = cleanProfile(value.profile || value);
        return true;
      } catch {
        return false;
      }
    },
  };
  model.load();
  return model;
}

export function dialectic(model) {
  const goals = model.state.goals.slice(0, 3);
  const preferences = model.state.preferences.slice(0, 3);
  const risks = [...model.state.facts.slice(0, 2), ...model.state.habits.slice(0, 2)].slice(0, 3);
  const thesis = goals.length ? `Prioritize ${goals.join(', ')}.` : 'Continue making steady progress on current projects.';
  const antithesis = preferences.length || risks.length
    ? `Challenge that direction against ${[...preferences, ...risks].join(', ')}.`
    : 'Question whether the proposed direction is unnecessarily complex.';
  const synthesis = goals.length
    ? `Advance ${goals[0]} while respecting ${[...preferences, ...risks].slice(0, 2).join(', ') || 'known constraints'}.`
    : 'Proceed incrementally, test assumptions, and retain what proves useful.';
  return { thesis, antithesis, synthesis };
}

export function updateProfile(model, observation = {}) {
  const inferred = inferObservation(observation);
  for (const field of LIST_FIELDS) merge(model.state[field], inferred[field] ?? observation[field]);
  if (inferred.communicationStyle) {
    model.state.communicationStyle = {
      ...model.state.communicationStyle,
      ...inferred.communicationStyle,
    };
  }
  const action = String(observation.action || observation.task || observation.type || '').toLowerCase().replace(/\s+/g, ' ');
  if (action) {
    const count = model.observations.filter((item) => String(item.task || '').toLowerCase() === action).length + 1;
    if (count >= 2) merge(model.state.habits, `repeatedly ${action}`);
  }
  return model.profile();
}

export function exportProfile(model) {
  const lines = LIST_FIELDS.map((field) => `${field}: ${model.state[field].join(', ') || 'none'}`);
  lines.push(`communicationStyle: ${JSON.stringify(model.state.communicationStyle)}`);
  return lines.filter((line) => !line.endsWith(': ')).join('\n');
}
