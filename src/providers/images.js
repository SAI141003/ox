// Image input for every provider. A user message may carry
//   { role: 'user', content: 'what is this button?', images: [{ mediaType, data }] }
// with `data` base64. `content` stays a plain string so sessions, compaction
// and token estimates keep working unchanged; each provider maps `images` to
// its own wire shape.
//
// Token rule: only the NEWEST user message that has images sends them. Older
// screenshots are replaced by a one-line note, so a long voice session with the
// screen attached every turn pays for one image, not for all of them.

import fs from 'node:fs';
import path from 'node:path';

const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Read an image file into `{ mediaType, data }`, or throw a message a user can act on. */
export function loadImage(file) {
  const ext = path.extname(String(file)).toLowerCase();
  const mediaType = MEDIA[ext];
  if (!mediaType) throw new Error(`${file}: not an image ox can send (use png, jpg, gif or webp)`);
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`${file}: ${(buf.length / 1048576).toFixed(1)} MB is over the 5 MB image limit`);
  return { mediaType, data: buf.toString('base64') };
}

/** Index of the last user message that carries images, or -1. */
export function lastImageIndex(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && Array.isArray(m.images) && m.images.length) return i;
  }
  return -1;
}

/** The images message `i` should send (empty for all but the newest), plus the note for dropped ones. */
export function imagesAt(messages, i, last = lastImageIndex(messages)) {
  const m = messages[i];
  const imgs = Array.isArray(m?.images) ? m.images.filter((x) => x && x.data && x.mediaType) : [];
  if (!imgs.length) return { images: [], note: '' };
  if (i === last) return { images: imgs, note: '' };
  return { images: [], note: `[${imgs.length} earlier screenshot(s) omitted]` };
}

export const withNote = (text, note) => (note ? (text ? `${note}\n${text}` : note) : text);
