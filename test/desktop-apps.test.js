// Messaging and mail apps found on the Mac, and the two paths that use them:
// WhatsApp for Mac (a typed-in chat the person sends) and an Outlook draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDesktopApps, whatsappDesktopLink, mailtoLink } from '../src/desktop-apps.js';
import { whatsapp_send } from '../src/tools/whatsapp.js';
import { mail_compose } from '../src/tools/mail.js';

const fakeRun = (installed) => (cmd, args) => {
  if (cmd.endsWith('mdfind')) return { status: 0, stdout: Object.values(installed).join('\n') };
  if (cmd.endsWith('defaults')) {
    const app = Object.entries(installed).find(([, p]) => args[1].startsWith(p));
    if (!app) return { status: 1, stdout: '' };
    return { status: 0, stdout: args[2] === 'CFBundleIdentifier' ? app[0] : '1.2.3' };
  }
  if (cmd.endsWith('pgrep')) return { status: args[1].includes('WhatsApp') ? 0 : 1, stdout: '' };
  return { status: 1, stdout: '' };
};

test('apps are found by bundle id, with version and whether they are open', () => {
  const apps = detectDesktopApps({ platform: 'darwin', run: fakeRun({ 'net.whatsapp.WhatsApp': '/Applications/WhatsApp.app', 'com.microsoft.Outlook': '/Applications/Microsoft Outlook.app' }), exists: () => false, fresh: true });
  assert.deepEqual([apps.whatsapp.installed, apps.whatsapp.version, apps.whatsapp.running], [true, '1.2.3', true]);
  assert.equal(apps.outlook.installed, true);
  assert.equal(apps.outlook.running, false);
  assert.equal(apps.mail.installed, false);
  assert.equal(detectDesktopApps({ platform: 'linux' }).whatsapp.installed, false);
});

test('links carry the message, encoded', () => {
  assert.equal(whatsappDesktopLink('+1 (604) 555-0100', 'hi & bye'), 'whatsapp://send?phone=16045550100&text=hi%20%26%20bye');
  assert.equal(mailtoLink({ to: ['a@b.co'], subject: 'Q3 & more', body: 'Hi' }), 'mailto:a%40b.co?subject=Q3%20%26%20more&body=Hi');
});

test('without the Cloud API, WhatsApp for Mac opens the chat after approval, never sends', async () => {
  const opened = [];
  const ctx = { env: {}, detectApps: () => ({ whatsapp: { installed: true, bundle: 'net.whatsapp.WhatsApp' } }), openLink: (u) => (opened.push(u), { status: 0 }), requestApproval: async () => true };
  const prev = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  try {
    const r = await whatsapp_send({ to: '+16045550100', body: 'on my way' }, ctx);
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /NOT sent yet: press Enter/);
    assert.deepEqual(opened, ['whatsapp://send?phone=16045550100&text=on%20my%20way']);
    const no = await whatsapp_send({ to: '+16045550100', body: 'x' }, { ...ctx, requestApproval: async () => false });
    assert.match(no.content, /declined/);
    assert.equal(opened.length, 1, 'declined opens nothing');
    const none = await whatsapp_send({ to: '+1', body: 'x' }, { ...ctx, detectApps: () => ({ whatsapp: { installed: false } }) });
    assert.equal(none.isError, true);
  } finally { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; }
});

test('Outlook: a draft opens there, attachments are refused, addresses checked', async () => {
  const opened = [];
  const ctx = { detectApps: () => ({ outlook: { installed: true, bundle: 'com.microsoft.Outlook' } }), openLink: (u) => (opened.push(u), { status: 0 }) };
  const prev = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  try {
    const r = await mail_compose({ app: 'outlook', to: ['sam@example.com'], subject: 'Hello', body: 'See you' }, ctx);
    assert.equal(r.isError, undefined, r.content);
    assert.match(r.content, /Draft open in Outlook, not sent/);
    assert.equal(opened[0], 'mailto:sam%40example.com?subject=Hello&body=See%20you');
    assert.equal((await mail_compose({ app: 'outlook', to: ['x'] }, ctx)).isError, true);
    assert.match((await mail_compose({ app: 'outlook', to: ['a@b.co'], attachments: ['f.pdf'] }, ctx)).content, /cannot carry attachments/);
    assert.equal(opened.length, 1);
  } finally { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; }
});
