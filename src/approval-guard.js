// Approvals that commit something you cannot take back (send, pay, delete, push,
// destructive commands) need Touch ID, or your Mac password, not only a click:
// a script that can reach ox's server, or a page that fakes a click, cannot
// approve them. The prompt is shown by ox's signed helper (ox-keys confirm).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { keychainUsable } from './keychain-ok.js';

const RISKY_TOOLS = new Set(['whatsapp_send', 'mail_send', 'send_email', 'messages_send', 'imessage_send', 'delete_file', 'git_push']);
const RISKY_WORDS = /\b(send|pay|purchase|buy|checkout|transfer|delete|remove account|unsubscribe|rm -rf|rm -r|git push|--force|drop table|sudo)\b/i;

export function needsFingerprint(tool, detail = '') {
  return RISKY_TOOLS.has(String(tool)) || RISKY_WORDS.test(`${tool} ${detail}`);
}

const HELPER = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'bin', 'ox-keys');

/** true when you confirmed. Off a Mac (or without the helper) there is no fingerprint to ask: the click stands. */
export function confirmWithFingerprint(reason, { helper = HELPER(), platform = process.platform } = {}) {
  if (platform !== 'darwin' || process.env.NODE_TEST_CONTEXT || !fs.existsSync(helper) || !keychainUsable()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const p = spawn(helper, ['confirm', String(reason).slice(0, 150)], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}
