import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BUNDLE_SCHEMA_VERSION = '1.0.0';

function bundleFile() {
  return join(homedir(), '.ox', 'bundles', 'bundles.json');
}

function normalizeBundle(bundle = {}) {
  if (!String(bundle.name ?? '').trim()) throw new Error('Bundle name is required');
  const skillNames = bundle.skillNames ?? bundle.skills;
  if (!Array.isArray(skillNames)) throw new Error('skillNames must be an array');
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    name: String(bundle.name).trim(),
    skillNames: [...new Set(skillNames.map(String).filter(Boolean))],
    description: String(bundle.description || ''),
  };
}

export function createBundleManager(cwd = process.cwd()) {
  const file = bundleFile();
  const manager = {
    cwd,
    file,
    bundles: new Map(),
    define(name, skillNames, description = '') {
      const bundle = normalizeBundle(typeof name === 'object' ? name : { name, skillNames, description });
      manager.bundles.set(bundle.name, bundle);
      manager.save();
      return { ...bundle, skillNames: [...bundle.skillNames] };
    },
    load(name) {
      return expandBundle(manager, name);
    },
    list() {
      return listBundles(manager);
    },
    install(bundle) {
      return manager.define(bundle);
    },
    remove(name) {
      const removed = manager.bundles.delete(name);
      if (removed) manager.save();
      return removed;
    },
    save() {
      mkdirSync(join(homedir(), '.ox', 'bundles'), { recursive: true });
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify([...manager.bundles.values()], null, 2)}\n`);
      renameSync(temp, file);
    },
    loadPersisted() {
      manager.bundles.clear();
      if (!existsSync(file)) return 0;
      try {
        const values = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(values)) return 0;
        for (const value of values) {
          try {
            const bundle = normalizeBundle(value);
            manager.bundles.set(bundle.name, bundle);
          } catch {
            continue;
          }
        }
        return manager.bundles.size;
      } catch {
        return 0;
      }
    },
  };
  manager.loadPersisted();
  return manager;
}

export function expandBundle(manager, name) {
  const bundle = manager.bundles.get(name);
  return bundle ? [...bundle.skillNames] : [];
}

export function listBundles(manager) {
  return [...manager.bundles.values()]
    .map((bundle) => ({
      name: bundle.name,
      description: bundle.description,
      skillNames: [...bundle.skillNames],
      skillCount: bundle.skillNames.length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
