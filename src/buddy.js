// OX Buddy: ask about what is on your screen, by voice or by typing.
//
// Like heyclicky: the question arrives with a screenshot, the answer is short
// enough to be spoken, and the model can point at the thing it means with
// [POINT:x,y:label] in screenshot pixels. The island speaks the reply with the
// avatar lip-syncing and flies its pointer there; the terminal prints it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadImage } from './providers/images.js';

/** Width and height of a PNG from its IHDR, or null. */
export function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Capture the main display to a temp PNG (macOS `screencapture`, silent). */
export function captureScreen({ dir = os.tmpdir(), run = execFileSync } = {}) {
  if (process.platform !== 'darwin') throw new Error('screen capture needs macOS (or attach an image with --image)');
  const file = path.join(dir, `ox-screen-${Date.now()}.png`);
  run('screencapture', ['-x', '-m', '-t', 'png', file], { stdio: 'ignore', timeout: 10_000 });
  if (!fs.existsSync(file)) throw new Error('screen capture failed: grant Screen Recording to your terminal in System Settings > Privacy & Security');
  return file;
}

/** The per-turn guidance for a screen/voice question. */
export function buddyGuidance({ size = null, voice = false } = {}) {
  return [
    size
      ? `The user attached a screenshot of their screen (${size.width}x${size.height} px). Ground your answer in it.`
      : 'The user may have attached a screenshot. Ground your answer in it.',
    voice ? 'Your reply is spoken aloud by their avatar: 1-3 short sentences, plain words, no markdown, no lists, no code blocks.' : 'Keep it short.',
    'To point at one thing on screen, end with [POINT:x,y:label] in screenshot pixels (top-left is 0,0). Point only when it helps.',
    'When the user asks you to draw, mark, circle or show them, or says they learn visually, mark the screen while you explain: up to 6 of [CIRCLE:x,y,r:label], [ARROW:x1,y1,x2,y2:label], [BOX:x,y,w,h:label], all in screenshot pixels. Labels are 1-3 words (A, B, "push", "reaction"). The marks are drawn over their screen; your words say what they mean.',
  ].join('\n');
}

/** Build the turn for a buddy question: { text, images, guidance }. */
export function buddyTurn(text, { imagePaths = [], voice = false } = {}) {
  const images = [];
  let size = null;
  for (const p of imagePaths) {
    const img = loadImage(p);
    images.push(img);
    size ??= pngSize(Buffer.from(img.data, 'base64'));
  }
  return { text, images, guidance: buddyGuidance({ size, voice }) };
}

/** Split a reply into what to say and where to point. */
export function parsePoint(reply) {
  const m = /\[POINT:\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?::\s*([^\]]*))?\]/i.exec(String(reply ?? ''));
  const say = String(reply ?? '').replace(/\[POINT:[^\]]*\]/gi, '').replace(/\s+$/g, '').trim();
  if (!m) return { say, point: null };
  return { say, point: { x: Number(m[1]), y: Number(m[2]), label: (m[3] ?? '').trim() } };
}

const MARK = /\[(CIRCLE|ARROW|BOX):\s*([\d.\s,]+?)\s*(?::\s*([^\]]*))?\]/gi;

/**
 * Marks to draw over the screen while the reply is spoken (Pixie's circles and
 * arrows over a video): [{ kind: 'circle'|'arrow'|'box', n: [numbers], label }].
 * Malformed marks (wrong count of numbers) are dropped. At most 6.
 */
export function parseMarks(reply) {
  const want = { circle: 3, arrow: 4, box: 4 };
  const marks = [];
  for (const m of String(reply ?? '').matchAll(MARK)) {
    const kind = m[1].toLowerCase();
    const n = m[2].split(',').map((x) => Number(x.trim()));
    if (n.length !== want[kind] || n.some((x) => !Number.isFinite(x) || x < 0)) continue;
    marks.push({ kind, n, label: (m[3] ?? '').trim().slice(0, 24) });
    if (marks.length >= 6) break;
  }
  const say = String(reply ?? '').replace(MARK, '').replace(/\[POINT:[^\]]*\]/gi, '').replace(/[ \t]+\n/g, '\n').replace(/\s{2,}/g, ' ').trim();
  return { say, marks };
}
