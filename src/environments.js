// Honest runtime inventory for Settings.  It deliberately reports only engines
// that are usable *on this machine right now*; a provider name or a Docker
// client binary is not evidence that an isolated computer exists.

import { spawnSync } from 'node:child_process';
import { dockerProblem } from './docker-backend.js';

function has(bin) {
  try { return spawnSync('sh', ['-lc', `command -v ${bin} >/dev/null 2>&1`], { timeout: 3_000 }).status === 0; } catch { return false; }
}

export function environmentInventory(env = process.env) {
  const docker = dockerProblem(env);
  const cuaInstalled = has('cua');
  return {
    local: {
      state: 'available',
      title: 'This Mac',
      detail: 'Local runs use Ox permissions, explicit approvals, and the selected sandbox profile.',
    },
    docker: {
      state: docker ? 'unavailable' : 'available',
      title: 'Disposable Docker shell',
      detail: docker || 'Docker engine is reachable. A run still needs its selected image to start successfully; Ox reports image or container creation errors directly.',
      caveat: 'This is command isolation, not a persistent desktop computer.',
    },
    cua: {
      state: cuaInstalled ? 'needs-auth' : 'unavailable',
      title: 'Cua Space',
      detail: cuaInstalled
        ? 'Cua is installed. Sign in and configure a Cua-backed agent before a Space can be created.'
        : 'Cua is not installed on this Mac. Install and authenticate Cua before connecting an external Space.',
      caveat: 'Ox does not create or label a Cua Space until the authenticated Cua backend reports one.',
    },
  };
}
