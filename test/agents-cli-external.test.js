import { test } from 'node:test';
import assert from 'node:assert/strict';

import { externalAgentSnapshot } from '../src/daemon-cmd.js';

test('the agents CLI snapshot uses the same live and installed-tool sources as the app', () => {
  let fresh = false;
  const out = externalAgentSnapshot({
    live: (opts) => {
      fresh = opts.fresh;
      return [{ id: 'cline:1', tool: 'Cline', state: 'thinking' }];
    },
    detected: () => [{ id: 'extension:cline', tool: 'Cline', source: 'VS Code extension', state: 'available', sessionSupport: 'native' }],
  });
  assert.equal(fresh, true, 'CLI requests a fresh snapshot rather than stale poll cache');
  assert.deepEqual(out.live.map((x) => x.tool), ['Cline']);
  assert.deepEqual(out.detected.map((x) => x.sessionSupport), ['native']);
});
