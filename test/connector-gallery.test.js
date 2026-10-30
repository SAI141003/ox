import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { galleryView, galleryEntry, GALLERY } from '../src/connector-gallery.js';

const has = () => true;

test('gallery: every entry has a logo id, name and a state', () => {
  const v = galleryView({ has, env: {} });
  assert.equal(v.length, GALLERY.length);
  for (const c of v) assert.ok(['added', 'connected', 'local', 'connect', 'needs'].includes(c.state), c.id);
});

test('gallery: a template is "connect" until added, then "added" (never "connected")', () => {
  assert.equal(galleryView({ has, env: {} }).find((c) => c.id === 'gmail').state, 'connect');
  const v = galleryView({ has, env: {}, servers: { gsuite: { command: 'uvx' } } });
  for (const id of ['gdrive', 'gmail', 'gcal', 'gdocs', 'gsheets']) assert.equal(v.find((c) => c.id === id).state, 'added');
});

test('gallery: a missing tool or token is said, not hidden', () => {
  const v = galleryView({ has: (c) => c !== 'docker', env: {} });
  assert.equal(v.find((c) => c.id === 'github').state, 'needs');
  assert.match(v.find((c) => c.id === 'github').why, /Docker/);
  assert.equal(v.find((c) => c.id === 'slack').state, 'needs');
});

test('gallery: apps on this Mac are found, and only a paired gateway is connected', () => {
  const v = galleryView({ has, env: {}, apps: { whatsapp: { installed: true, name: 'WhatsApp', version: '1' } }, channels: { telegram: { paired: true } } });
  assert.equal(v.find((c) => c.id === 'whatsapp').state, 'local');
  assert.equal(v.find((c) => c.id === 'telegram').state, 'connected');
  assert.equal(v.find((c) => c.id === 'outlook').state, 'needs');
});

test('gallery: Connect adds the template to config, Remove takes it out', () => {
  assert.equal(galleryEntry('gdrive').name, 'gsuite');
  assert.throws(() => galleryEntry('whatsapp'), /Messaging/);
  // In a child with its own HOME: never the owner's ~/.ox/config.json.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gal-'));
  try {
    const api = new URL('../src/app-api.js', import.meta.url).href;
    const cfg = new URL('../src/config.js', import.meta.url).href;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { addGalleryConnector } = await import(${JSON.stringify(api)});
      const { readConfigDoc } = await import(${JSON.stringify(cfg)});
      await addGalleryConnector({ id: 'notion' });
      const added = !!readConfigDoc().mcpServers?.notion;
      await addGalleryConnector({ id: 'notion', action: 'remove' });
      console.log(JSON.stringify({ added, after: readConfigDoc().mcpServers?.notion ?? null }));
    `], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.equal(r.added, true);
    assert.equal(r.after, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
