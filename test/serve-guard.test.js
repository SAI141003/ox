// A page on another website cannot drive the local ox server: forged
// cross-site requests and DNS-rebinding hosts are refused; ox's own page,
// curl and SDKs (no Origin) still work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestGuard } from '../src/serve.js';

const req = (method, headers) => ({ method, headers });

test('a request from another site, or to another host name, is refused', () => {
  assert.equal(requestGuard(req('POST', { host: '127.0.0.1:47800', origin: 'https://evil.example' })), 'requests from other sites are refused');
  assert.equal(requestGuard(req('GET', { host: 'evil.example:47800' })), 'this server answers only to its own address');
  assert.equal(requestGuard(req('POST', { host: 'rebind.attacker.test:47800', origin: 'http://rebind.attacker.test:47800' })), 'this server answers only to its own address');
});

test('ox\'s own page, curl and SDKs are let through', () => {
  assert.equal(requestGuard(req('POST', { host: '127.0.0.1:47800', origin: 'http://127.0.0.1:47800' })), null, 'the chat page itself');
  assert.equal(requestGuard(req('POST', { host: 'localhost:8080' })), null, 'no Origin: curl, an SDK');
  assert.equal(requestGuard(req('GET', { host: '127.0.0.1:8080', origin: 'https://elsewhere.example' })), null, 'a read cannot change anything');
  assert.equal(requestGuard(req('POST', { host: 'my-box.lan:8080' }), '0.0.0.0'), null, 'bound to all interfaces on purpose (with --api-key)');
});
