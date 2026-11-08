// A picture in the chat, in a terminal that can draw one: iTerm2, WezTerm and VS Code's terminal
// (the iTerm protocol), kitty and Ghostty (the kitty protocol). Anywhere else, nothing is printed.
import fs from 'node:fs';

const MAX_BYTES = 8 * 1024 * 1024;

export function imageProtocol(env = process.env) {
  if (env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR || /kitty|ghostty/i.test(env.TERM ?? '')) return 'kitty';
  if (/iTerm|WezTerm|vscode/i.test(env.TERM_PROGRAM ?? '') || env.LC_TERMINAL === 'iTerm2') return 'iterm';
  return null;
}

/** The escape codes that draw this image, or '' if this terminal cannot. Pure apart from the read. */
export function imageEscape(file, { env = process.env, width = '60%' } = {}) {
  const proto = imageProtocol(env);
  if (!proto) return '';
  let buf;
  try { if (fs.statSync(file).size > MAX_BYTES) return ''; buf = fs.readFileSync(file); } catch { return ''; }
  const b64 = buf.toString('base64');
  if (proto === 'iterm') return `\x1b]1337;File=inline=1;width=${width};preserveAspectRatio=1;size=${buf.length}:${b64}\x07\n`;
  // Kitty takes PNG directly, in chunks of at most 4096 bytes.
  if (buf.subarray(1, 4).toString() !== 'PNG') return '';
  let out = '';
  for (let i = 0; i < b64.length; i += 4096) {
    const part = b64.slice(i, i + 4096);
    const more = i + 4096 < b64.length ? 1 : 0;
    out += i === 0 ? `\x1b_Gf=100,a=T,m=${more};${part}\x1b\\` : `\x1b_Gm=${more};${part}\x1b\\`;
  }
  return `${out}\n`;
}

const FILE_IN_TEXT = /(?:Screenshot|saved|Saved):?\s+(\/\S+\.(?:png|jpe?g|gif|webp))/;

/** Draws the image a tool's answer names, when the output is a terminal that can show it. */
export function showToolImage(content, { env = process.env, out = process.stdout } = {}) {
  if (!out.isTTY && !env.OX_TEST_IMAGE_OUT) return false;
  const file = FILE_IN_TEXT.exec(String(content ?? ''))?.[1];
  if (!file) return false;
  const esc = imageEscape(file, { env });
  if (!esc) return false;
  out.write(esc);
  return true;
}
