// ox in VS Code and its forks. Thin on purpose: the agent, models, approvals and memory stay in
// ox. The chat is the app's own page; a selection or a file's problems go to an ox in the
// integrated terminal, where its usual approvals apply. No code from the editor leaves except
// what ox itself sends to the model you chose.
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The running app's port from ~/.ox/app.json or serve.json, if its process is alive. */
function appPort(home = os.homedir()) {
  for (const name of ['app.json', 'serve.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(process.env.OX_HOME || path.join(home, '.ox'), name), 'utf8'));
      process.kill(j.pid, 0);
      if (j.port) return Number(j.port);
    } catch {}
  }
  return null;
}

/** Text as one safely quoted shell word (POSIX, or PowerShell on Windows). */
function shellQuote(text, platform = process.platform) {
  const t = String(text);
  return platform === 'win32' ? `'${t.replace(/'/g, "''")}'` : `'${t.replace(/'/g, `'\\''`)}'`;
}

const command = () => vscode.workspace.getConfiguration('ox').get('command') || 'ox';
const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

function terminal() {
  const open = vscode.window.terminals.find((t) => t.name === 'ox');
  const t = open ?? vscode.window.createTerminal({ name: 'ox', cwd: folder() });
  t.show();
  return t;
}

function sendTask(prompt) {
  terminal().sendText(`${command()} ${shellQuote(prompt)}`);
}

let panel = null;
function chatHtml(port, nonce) {
  // The frame has to be allowed explicitly; asExternalUri maps the port for remote windows too.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:${port} http://localhost:${port}; style-src 'nonce-${nonce}'"><style nonce="${nonce}">html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;overflow:hidden}</style></head><body><iframe src="http://127.0.0.1:${port}/" allow="clipboard-write"></iframe></body></html>`;
}

async function openChat() {
  const port = appPort();
  if (!port) {
    const pick = await vscode.window.showErrorMessage('ox is not running. Open the OX app, or start it here.', 'Start it here');
    if (pick) terminal().sendText(`${command()} serve`);
    return;
  }
  if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
  panel = vscode.window.createWebviewPanel('ox.chat', 'ox', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  panel.onDidDispose(() => { panel = null; });
  panel.webview.html = chatHtml(port, require('node:crypto').randomBytes(16).toString('hex'));
}

function selectionPrompt(question, file, line, text) {
  return `${question}\n\nIn ${file}, from line ${line}:\n\`\`\`\n${text}\n\`\`\``;
}

async function askSelection() {
  const e = vscode.window.activeTextEditor;
  if (!e || e.selection.isEmpty) { vscode.window.showInformationMessage('Select some code first.'); return; }
  const q = await vscode.window.showInputBox({ prompt: 'What should ox do with the selection?', placeHolder: 'Explain this, make it faster, add a test…' });
  if (!q) return;
  sendTask(selectionPrompt(q, vscode.workspace.asRelativePath(e.document.uri), e.selection.start.line + 1, e.document.getText(e.selection)));
}

function problemsPrompt(file, diagnostics) {
  const lines = diagnostics.map((d) => `line ${d.line}: ${d.message}`);
  return `Fix these problems in ${file}, then check they are gone:\n${lines.join('\n')}`;
}

async function fixProblem() {
  const e = vscode.window.activeTextEditor;
  if (!e) return;
  const found = vscode.languages.getDiagnostics(e.document.uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);
  if (!found.length) { vscode.window.showInformationMessage('No problems in this file.'); return; }
  sendTask(problemsPrompt(vscode.workspace.asRelativePath(e.document.uri), found.slice(0, 30).map((d) => ({ line: d.range.start.line + 1, message: d.message }))));
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('ox.openChat', openChat),
    vscode.commands.registerCommand('ox.askSelection', askSelection),
    vscode.commands.registerCommand('ox.fixProblem', fixProblem),
    vscode.commands.registerCommand('ox.runInTerminal', () => terminal().sendText(command())),
  );
}

module.exports = { activate, deactivate() {}, appPort, shellQuote, selectionPrompt, problemsPrompt, chatHtml };
