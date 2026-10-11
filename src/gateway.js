import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const GATEWAY_SCHEMA_VERSION = '1.0.0';

const PLATFORM_DEFS = [
  'telegram', 'discord', 'slack', 'whatsapp', 'signal', 'matrix', 'mattermost',
  'email', 'sms', 'dingtalk', 'feishu', 'wecom', 'weixin', 'qq', 'yuanbao',
  'bluebubbles', 'home-assistant', 'teams', 'google-chat', 'irc', 'zulip',
];

export class GatewayPlatform extends EventEmitter {
  constructor(config = {}) {
    super();
    this.name = config.name ?? 'unnamed';
    this.enabled = config.enabled ?? false;
    this.token = config.token ?? '';
    this.webhook = config.webhook ?? '';
    this.handlers = config.handlers ?? {};
    this._running = false;
    this._server = null;
  }
  async start() { this._running = true; this.emit('started', this.name); }
  async stop() {
    this._running = false;
    if (this._server) { await new Promise((r) => this._server.close(r)); this._server = null; }
    this.emit('stopped', this.name);
  }
  async send(target, message) {
    const handler = this.handlers.send;
    if (handler) return handler(target, message);
    this.emit('sent', { target, message });
    return { ok: true, platform: this.name };
  }
  async receive(raw) { this.emit('received', { raw }); return raw; }
}

export class WebhookPlatform extends GatewayPlatform {
  async start() {
    await super.start();
    if (!this.webhook) return;
    const url = new URL(this.webhook);
    this._server = http.createServer(async (req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          await this.receive(parsed);
          const handler = this.handlers.onMessage;
          if (handler) await handler(parsed);
          res.writeHead(200); res.end('ok');
        } catch { res.writeHead(400); res.end('bad'); }
      });
    });
    await new Promise((r) => this._server.listen(Number(url.port) || 8080, r));
  }
}

export class CliPlatform extends GatewayPlatform {
  async start() {
    await super.start();
    this._stdin = process.stdin;
    this._stdin.setEncoding('utf8');
    this._onData = (data) => { this.receive({ platform: this.name, text: data.trim(), from: 'cli' }); };
    this._stdin.on('data', this._onData);
  }
  async stop() {
    if (this._stdin && this._onData) this._stdin.removeListener('data', this._onData);
    await super.stop();
  }
}

const PLATFORM_ADAPTERS = new Map();

function getAdapter(platform, config) {
  if (PLATFORM_ADAPTERS.has(platform)) return PLATFORM_ADAPTERS.get(platform)(config);
  const isWebhook = !!config.webhook;
  return new (isWebhook ? WebhookPlatform : CliPlatform)(config);
}

export function createGateway(cwd) {
  const platforms = new Map();
  const statuses = new Map();

  async function start(platformConfigs) {
    for (const cfg of Array.isArray(platformConfigs) ? platformConfigs : []) {
      const name = String(cfg.name ?? '');
      if (!name || !cfg.enabled) continue;
      const adapter = getAdapter(name, cfg);
      platforms.set(name, adapter);
      statuses.set(name, 'starting');
      try { await adapter.start(); statuses.set(name, 'active'); }
      catch { statuses.set(name, 'error'); }
    }
  }

  async function stop() {
    for (const [, adapter] of platforms) {
      try { await adapter.stop(); } catch { /* continue */ }
    }
    platforms.clear(); statuses.clear();
  }

  async function sendMessage(platform, target, message) {
    const adapter = platforms.get(platform);
    if (!adapter) throw new Error(`Platform not loaded: ${platform}`);
    return adapter.send(target, message);
  }

  async function receiveMessage(platform, message) {
    const adapter = platforms.get(platform);
    if (!adapter) throw new Error(`Platform not loaded: ${platform}`);
    return adapter.receive(message);
  }

  function listPlatforms() { return [...PLATFORM_DEFS]; }

  function getStatus() {
    const out = {};
    for (const [name, adapter] of platforms) {
      out[name] = { enabled: adapter.enabled, status: statuses.get(name) ?? 'unknown', type: adapter.constructor.name };
    }
    return out;
  }

  return { start, stop, sendMessage, receiveMessage, listPlatforms, getStatus };
}
