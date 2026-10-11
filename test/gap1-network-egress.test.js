// Competitive gap #1: network egress control.
//
// Two pre-existing bugs are guarded here as regressions, because any policy
// layered on them would be corrupt:
//   Bug 1  compileSbpl dispatched on profile.name while loadCustomProfile
//          overwrites name -> every custom profile got strict's policy
//          ((deny network*) it never asked for, no workspace write roots) and
//          disagreed with the bwrap argv, which checked kind.
//   Bug 2  cacheKey hashed kind/name/cwd/restrict_network/deny/read_write but
//          not read_only (nor the new network_allow), so two policies shared
//          one compiled SBPL file.
// And the new network_allow field is pinned at every layer, including the two
// places it CANNOT be enforced (see the honesty assertions at the bottom).

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  resolveSandbox,
  compileSbpl,
  buildBwrapArgv,
  prepareSandbox,
  bwrapGaps,
  profileBaseName,
  networkPolicyFor,
  hostInAllowList,
  isHardRefusedHost,
  normalizeHost,
  seatbeltAllowsRemoteIp,
  setSeatbeltRemoteIpCapabilityForTest,
  resetSandboxCompileCacheForTest,
  SandboxConfigError,
} from '../src/sandbox.js';
import { networkEgressVerdict, webFetchTool } from '../src/tools/web.js';
import { evaluateToolPolicy } from '../src/guards.js';
import { makeApprover } from '../src/approval.js';
import { dispatchTool } from '../src/tools/index.js';
import { McpHub } from '../src/mcp.js';

const homes = [];
function tempHome(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ox-gap1-${tag}-`));
  homes.push(dir);
  return dir;
}
function projectWith(home, doc, tag = 'p') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `ox-gap1-${tag}-`));
  fs.writeFileSync(path.join(cwd, '.ox-sandbox.json'), JSON.stringify(doc));
  return { home, cwd };
}
after(() => {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});
// The Seatbelt capability probe is a process-wide cache and several tests pin
// both of its branches; never let one test's forced value leak into the next.
afterEach(() => setSeatbeltRemoteIpCapabilityForTest(null));

const hasSandboxExec = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

// ---------- Bug 1: custom-profile dispatch, and SBPL/bwrap agreement --------

test('BUG 1: a custom profile inherits its BASE preset policy in both backends', (t) => {
  const home = tempHome('b1');
  // Each preset, extended by a custom profile, must compile and bind the same
  // writable set. Before the fix every one of these took strict's branch.
  const cases = [
    { extends: 'workspace', writable: (p) => p.cwd },
    { extends: 'read-only', writable: (p) => p.oxDir },
    { extends: 'strict', writable: null },
  ];
  for (const [i, { extends: ext, writable }] of cases.entries()) {
    const { cwd } = projectWith(home, { extends: ext }, `b1-${i}`);
    const custom = resolveSandbox({ flag: 'mine', home, cwd });
    assert.equal(custom.kind, 'custom');
    assert.equal(custom.name, 'mine', 'the user-facing name is the custom one');
    assert.equal(custom.extends, ext);
    assert.equal(profileBaseName(custom), ext, 'policy keys off extends, not name');

    const sbpl = compileSbpl(custom);
    if (writable) {
      assert.ok(
        sbpl.includes(`(subpath "${writable(custom)}")`),
        `custom extending ${ext} must get the ${ext} write root:\n${sbpl}`
      );
    } else {
      assert.ok(!sbpl.includes(`(subpath "${custom.cwd}")`), 'strict does not open the workspace');
    }

    // The two backends must agree about the oxDir bind too.
    const argv = buildBwrapArgv(custom, 'echo hi');
    const sbplBindsOxDir = sbpl.includes(`(subpath "${custom.oxDir}")`);
    const bwrapBindsOxDir = argv.includes(custom.oxDir);
    assert.equal(sbplBindsOxDir, bwrapBindsOxDir, `SBPL and bwrap disagree on ~/.ox for extends=${ext}`);
    assert.equal(sbplBindsOxDir, ext !== 'strict');
  }
});

test('BUG 1: a custom profile extending workspace is NOT silently network-denied', (t) => {
  const home = tempHome('b1net');
  const { cwd } = projectWith(home, { extends: 'workspace' });
  const sbpl = compileSbpl(resolveSandbox({ flag: 'mine', home, cwd }));
  assert.equal(sbpl.split('(deny network*)').length - 1, 0, `workspace must not be network-denied:\n${sbpl}`);
  assert.ok(sbpl.includes('(deny file-write*)'));
  assert.ok(sbpl.includes(`(subpath "${cwd}")`), 'and it must get the WORKSPACE write root');
});

// ---------- Bug 2: the compile cache key ------------------------------------

test('BUG 2: profiles differing only in read_only or only in network_allow do not share a compiled profile', (t) => {
  const home = tempHome('b2');
  resetSandboxCompileCacheForTest();
  const base = resolveSandbox({ flag: 'workspace', home, cwd: '/w' });

  // read_only
  const roA = { ...base, read_only: [] };
  const roB = { ...base, read_only: ['**/*.pem'] };
  assert.notEqual(compileSbpl(roA), compileSbpl(roB), 'read_only changes the compiled SBPL');
  const pRoA = prepareSandbox(roA);
  const pRoB = prepareSandbox(roB);
  if (pRoA.backend !== 'none' && pRoB.backend !== 'none') {
    assert.notEqual(
      pRoA.argvPrefix[pRoA.argvPrefix.length - 1],
      pRoB.argvPrefix[pRoB.argvPrefix.length - 1],
      'a read_only-only difference must not reuse the cached SBPL file'
    );
  }

  // network_allow
  const naA = { ...base, restrict_network: true, network_allow: [] };
  const naB = { ...base, restrict_network: true, network_allow: ['api.example.com'] };
  assert.notEqual(compileSbpl(naA), compileSbpl(naB));
  const pNaA = prepareSandbox(naA);
  const pNaB = prepareSandbox(naB);
  if (pNaA.backend !== 'none' && pNaB.backend !== 'none') {
    assert.notEqual(
      pNaA.argvPrefix[pNaA.argvPrefix.length - 1],
      pNaB.argvPrefix[pNaB.argvPrefix.length - 1],
      'a network_allow-only difference must not reuse the cached SBPL file'
    );
  }
  resetSandboxCompileCacheForTest();
});

// ---------- the profile field ----------------------------------------------

test('every preset carries network_allow, including the bare "off" object', () => {
  const home = tempHome('field');
  for (const name of ['off', 'workspace', 'read-only', 'strict']) {
    const p = resolveSandbox({ flag: name, home });
    assert.deepEqual(p.network_allow, [], `${name} must have network_allow: []`);
  }
  assert.equal(resolveSandbox({ flag: 'strict', home }).restrict_network, true);
  assert.equal(resolveSandbox({ flag: 'workspace', home }).restrict_network, false);
});

test('a custom profile accepts an array, normalises entries, and records a non-array', () => {
  const home = tempHome('custom');
  const a = projectWith(home, {
    extends: 'workspace',
    restrict_network: true,
    network_allow: ['API.Example.COM:443.', '*.Corp.Example.NET', '10.0.0.0/8', '[2606:4700::1111]'],
  });
  const p = resolveSandbox({ flag: 'n1', ...a });
  assert.deepEqual(p.network_allow, ['api.example.com', '*.corp.example.net', '10.0.0.0/8', '[2606:4700::1111]']);
  assert.deepEqual(p.warnings, [], 'a well-formed allow-list warns about nothing');

  // Non-array: ignore it, degrade to a blanket deny, and SAY so.
  const b = projectWith(home, { extends: 'workspace', restrict_network: true, network_allow: 'api.example.com' });
  const q = resolveSandbox({ flag: 'n2', ...b });
  assert.deepEqual(q.network_allow, []);
  assert.equal(q.warnings.length, 1);
  assert.match(q.warnings[0], /network_allow.*must be an array/);
  assert.equal(q.restrict_network, true, 'and it stays fail-closed (blanket deny), not fail-open');

  // An unsupported glob metacharacter still refuses startup, naming the file.
  const c = projectWith(home, { extends: 'workspace', network_allow: ['{a,b}.com'] });
  assert.throws(() => resolveSandbox({ flag: 'n3', ...c }), (e) => {
    assert.ok(e instanceof SandboxConfigError);
    assert.match(e.message, /network_allow glob/);
    return true;
  });
});

// ---------- SBPL: deny, then allow where the kernel can express it ---------

test('SBPL: restrict_network + EMPTY allow-list is a single blanket deny, no allow rule', () => {
  const home = tempHome('sbpl1');
  const sbpl = compileSbpl(resolveSandbox({ flag: 'strict', home }));
  assert.equal(sbpl.split('(deny network*)').length - 1, 1, 'exactly one deny (the old double-deny is gone)');
  assert.ok(!sbpl.includes('network-outbound'), 'no allow rule for a blanket deny');
  assert.ok(!sbpl.includes(';'), 'and nothing to disclaim');
});

test('SBPL: restrict_network + IP entries compiles deny AND the per-host allow rule', (t) => {
  const home = tempHome('sbpl2');
  const p = { ...resolveSandbox({ flag: 'workspace', home, cwd: '/w' }), restrict_network: true, network_allow: ['203.0.113.7', '198.51.100.4:8443'] };
  // Pin BOTH branches of the capability gate: the rule is emitted only on a
  // sandbox-exec that accepts it, and never on one that does not.
  t.after(() => setSeatbeltRemoteIpCapabilityForTest(null));
  setSeatbeltRemoteIpCapabilityForTest(true);
  const capable = compileSbpl(p);
  assert.ok(capable.includes('(deny network*)'), 'deny first');
  assert.ok(capable.includes('(allow network-outbound (remote ip "203.0.113.7:*"))'), `no bare-IP rule:\n${capable}`);
  assert.ok(capable.includes('(allow network-outbound (remote ip "198.51.100.4:8443"))'), 'explicit port is kept');
  const denyAt = capable.indexOf('(deny network*)');
  assert.ok(denyAt < capable.indexOf('(allow network-outbound'), 'the allow must come after the blanket deny');

  setSeatbeltRemoteIpCapabilityForTest(false);
  const incapable = compileSbpl(p);
  assert.ok(incapable.includes('(deny network*)'), 'the deny still stands');
  assert.ok(!incapable.includes('network-outbound'), 'an uncompilable rule is never emitted');
  assert.match(incapable, /; ox:.*NOT kernel-enforced/, 'and the omission is documented in the profile');
});

test('SBPL: HOSTNAME entries are in-process only, never a kernel rule (documented in a comment)', (t) => {
  const home = tempHome('sbpl3');
  const p = { ...resolveSandbox({ flag: 'workspace', home, cwd: '/w' }), restrict_network: true, network_allow: ['api.example.com', '10.0.0.0/8'] };
  for (const capable of [true, false]) {
    t.diagnostic(`capability=${capable}`);
    setSeatbeltRemoteIpCapabilityForTest(capable);
    const sbpl = compileSbpl(p);
    assert.ok(sbpl.includes('(deny network*)'));
    assert.ok(
      !sbpl.includes('api.example.com"') || !/remote ip/.test(sbpl.split('\n').filter((l) => l.includes('api.example.com'))[0]),
      'a hostname is never translated into a remote ip rule'
    );
    assert.ok(!/allow network-outbound \(remote ip "api/.test(sbpl), 'no hostname kernel rule');
    assert.ok(!/allow network-outbound \(remote ip "10\.0\.0\.0/.test(sbpl), 'no CIDR kernel rule');
    const comment = sbpl.split('\n').find((l) => l.includes('api.example.com'));
    assert.ok(comment, 'the hostname is named in a comment');
    assert.match(comment, /^; ox: .*IN-PROCESS ONLY/);
    assert.match(comment, /cannot be resolved when a policy is compiled/);
    const cidrComment = sbpl.split('\n').find((l) => l.includes('10.0.0.0/8'));
    assert.match(cidrComment, /no CIDR form for the remote filter/);
  }
  setSeatbeltRemoteIpCapabilityForTest(null);
  // ...and the in-process layer is where the hostname is actually enforced.
  const q = { ...p, blocksTool: (n, a) => networkPolicyFor(p, n, a).blocked };
  assert.equal(networkEgressVerdict({ sandbox: q }, 'web_fetch', { url: 'https://api.example.com/v1' }).blocked, false);
  assert.equal(networkEgressVerdict({ sandbox: q }, 'web_fetch', { url: 'https://api.other.test/v1' }).blocked, true);
});

test('SBPL: restrict_network:false is unchanged (no deny, no rules, no comments)', () => {
  const home = tempHome('sbpl4');
  const sbpl = compileSbpl({ ...resolveSandbox({ flag: 'workspace', home, cwd: '/w' }), network_allow: ['api.example.com'] });
  assert.ok(!sbpl.includes('network'), 'an unrestricted profile says nothing about network');
  const p = resolveSandbox({ flag: 'workspace', home });
  assert.equal(networkEgressVerdict({ sandbox: p }, 'web_fetch', { url: 'https://anything.test/' }).blocked, false);
  assert.equal(p.blocksTool('web_fetch', { url: 'https://anything.test/' }), false);
});

// ---------- Linux: fail loud, never pretend -------------------------------

test('bwrap: --unshare-net on restrict_network, and an allow-list is reported as UNAPPLIED', () => {
  const home = tempHome('bwrap');
  const strict = resolveSandbox({ flag: 'strict', home, cwd: '/w' });
  assert.ok(buildBwrapArgv(strict, 'echo hi').includes('--unshare-net'));
  assert.deepEqual(bwrapGaps(strict).unapplied, [], 'a blanket deny is fully expressed by --unshare-net');

  const withAllow = {
    ...resolveSandbox({ flag: 'strict', home, cwd: '/w' }),
    network_allow: ['api.example.com', '1.2.3.4'],
    read_only: ['**/*.pem'],
  };
  const argv = buildBwrapArgv(withAllow, 'echo hi');
  assert.ok(argv.includes('--unshare-net'), 'the deny is still applied (fail-closed, never fail-open)');
  const gaps = bwrapGaps(withAllow);
  assert.deepEqual(gaps.unapplied.sort(), ['network_allow', 'read_only']);
  assert.match(gaps.notes.join(' '), /bwrap has no host or port allow-list/);
  assert.match(gaps.notes.join(' '), /cannot remove a path from the writable set/);
  // The prepared result carries the gap, so a caller can report it.
  const prepared = prepareSandbox(withAllow);
  assert.ok('gaps' in prepared, 'prepareSandbox always reports gaps');
});

// ---------- host matching --------------------------------------------------

test('normalisation: case, trailing dot, port, IPv6 brackets, CIDR', () => {
  assert.equal(normalizeHost('HTTPS://API.Example.COM./path?q=1'), 'api.example.com');
  assert.equal(normalizeHost('api.example.com:8443'), 'api.example.com');
  assert.equal(normalizeHost('[2606:4700::1111]:8443'), '2606:4700::1111');
  assert.equal(normalizeHost('2606:4700::1111'), '2606:4700::1111');
  assert.equal(normalizeHost('10.0.0.0/8'), '10.0.0.0/8');
  assert.equal(normalizeHost('not a url://'), '', 'unparseable input yields no host, so it can never match *');
  assert.equal(normalizeHost('user:pw@api.example.com:22'), 'api.example.com');
  assert.equal(normalizeHost(new URL('https://a.example.com:9/')), 'a.example.com');

  assert.equal(hostInAllowList('API.Example.com.', ['api.example.com']), true);
  assert.equal(hostInAllowList('a.corp.example.net', ['*.corp.example.net']), true);
  assert.equal(hostInAllowList('corp.example.net', ['*.corp.example.net']), false, 'the glob is anchored');
  assert.equal(hostInAllowList('evil-corp.example.net.attacker.test', ['*.corp.example.net']), false);
  assert.equal(hostInAllowList('10.4.5.6', ['10.0.0.0/8']), true);
  assert.equal(hostInAllowList('11.4.5.6', ['10.0.0.0/8']), false);
  assert.equal(hostInAllowList('1.2.3.4', ['1.2.3.4']), true);
  assert.equal(hostInAllowList('1.2.3.5', ['1.2.3.4']), false);
});

test('loopback, link-local and the metadata endpoint are hard-refused, allow-list or not', () => {
  for (const h of ['127.0.0.1', '127.9.9.9', 'localhost', 'LOCALHOST.', '::1', '[::1]:80', '169.254.169.254', '169.254.0.1', 'fe80::1', 'fd00::1', '0.0.0.0', 'metadata.google.internal', '::ffff:169.254.169.254']) {
    assert.equal(isHardRefusedHost(h), true, `${h} must be hard-refused`);
  }
  for (const h of ['example.com', '1.2.3.4', '2606:4700::1111', '10.0.0.1']) {
    assert.equal(isHardRefusedHost(h), false, `${h} is ordinary public space`);
  }
  const permissive = { kind: 'custom', name: 'p', restrict_network: true, network_allow: ['*'] };
  for (const h of ['127.0.0.1', 'localhost', '169.254.169.254', '[fe80::1]', '[::1]']) {
    assert.equal(networkPolicyFor(permissive, 'web_fetch', { url: `http://${h}/` }).reason, 'hard-refused', `${h} stays refused even under allow: *`);
  }
  // A destination we cannot even parse must not slip through a catch-all '*'.
  assert.equal(networkPolicyFor(permissive, 'web_fetch', { url: 'http://fe80::1/' }).blocked, true);
  assert.equal(networkPolicyFor(permissive, 'web_fetch', { url: 'not a url://x' }).blocked, true);
});

// ---------- networkEgressVerdict ------------------------------------------

test('egress verdict: allow-listed host passes, near-miss is named, wildcards do not leak', (t) => {
  const home = tempHome('egress');
  const { cwd } = projectWith(home, { extends: 'workspace', restrict_network: true, network_allow: ['*.example.com', '10.0.0.0/8'] });
  const sandbox = resolveSandbox({ flag: 'n', home, cwd });

  const ok = networkEgressVerdict({ sandbox }, 'web_fetch', { url: 'https://API.EXAMPLE.com./v1/models' });
  assert.equal(ok.blocked, false, JSON.stringify(ok));

  const miss = networkEgressVerdict({ sandbox }, 'web_fetch', { url: 'https://api.example.com.attacker.test/' });
  assert.equal(miss.blocked, true);
  assert.match(miss.why, /host "api\.example\.com\.attacker\.test" is not in network_allow/);
  assert.match(miss.why, /allow-list: \*\.example\.com, 10\.0\.0\.0\/8/);

  const miss2 = networkEgressVerdict({ sandbox }, 'web_fetch', { url: 'https://11.0.0.1/' });
  assert.equal(miss2.blocked, true);
  assert.match(miss2.why, /not in network_allow/);

  for (const h of ['http://localhost:9000/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://169.254.1.1/']) {
    const v = networkEgressVerdict({ sandbox }, 'web_fetch', { url: h });
    assert.equal(v.blocked, true, `${h} must be refused`);
    assert.match(v.why, /loopback, link-local or cloud-metadata/);
  }

  // web_search picks its backend at request time: fail closed, and say why.
  const search = networkEgressVerdict({ sandbox }, 'web_search', { query: 'x' });
  assert.equal(search.blocked, true);
  assert.match(search.why, /picks its destination host at request time/);

  // restrict_network + empty allow-list stays a hard deny.
  const strict = resolveSandbox({ flag: 'strict', home });
  const denied = networkEgressVerdict({ sandbox: strict }, 'web_fetch', { url: 'https://example.com/' });
  assert.equal(denied.blocked, true);
  assert.match(denied.why, /restrict_network:true with an EMPTY network_allow/);
  assert.match(denied.why, /userspace check/);
});

test('egress verdict: a host-supplied blocksTool still wins when it allows', () => {
  const v = networkEgressVerdict({ sandbox: { restrict_network: true, blocksTool: () => false } }, 'web_fetch', { url: 'https://x.test/' });
  assert.equal(v.blocked, false);
  const d = networkEgressVerdict({ sandbox: { restrict_network: true, blocksTool: () => true } }, 'web_fetch', {});
  assert.equal(d.blocked, true);
  assert.match(d.why, /blocks web_fetch/);
});

test('web_fetch honours the allow-list end to end (no socket is opened on a near-miss)', async () => {
  const home = tempHome('e2e');
  const { cwd } = projectWith(home, { extends: 'workspace', restrict_network: true, network_allow: ['example.com'] });
  const sandbox = resolveSandbox({ flag: 'n', home, cwd });
  const refused = await webFetchTool({ url: 'https://127.0.0.1:1/nope' }, { yolo: true, sandbox });
  assert.equal(refused.isError, true);
  assert.match(refused.content, /loopback, link-local or cloud-metadata/);
});

// ---------- blocksTool is real -------------------------------------------

test('resolveSandbox attaches a working blocksTool, and guards.js enforces it', () => {
  const home = tempHome('blockstool');
  const strict = resolveSandbox({ flag: 'strict', home });
  assert.equal(typeof strict.blocksTool, 'function', 'blocksTool exists on a resolved profile');
  assert.equal(strict.blocksTool('web_fetch', { url: 'https://example.com/' }), true);
  assert.equal(strict.blocksTool('web_search', { query: 'x' }), true);
  assert.equal(strict.blocksTool('open_url', { url: 'https://example.com/' }), true);
  assert.equal(strict.blocksTool('read_file', { path: '/etc/hosts' }), false, 'non-network tools are untouched');
  assert.equal(strict.blocksTool('bash', { command: 'ls' }), false);

  // A sandbox deny is monotonic: it beats yolo, and beats --strict-approvals.
  for (const ctx of [{ approval: 'yolo' }, { approval: 'yolo', strictApprovals: true }, { approval: 'default' }]) {
    const d = evaluateToolPolicy({ name: 'web_fetch', args: { url: 'https://example.com/' }, ctx: { ...ctx, sandbox: strict } });
    assert.equal(d.decision, 'deny', `expected deny under ${JSON.stringify(ctx)}`);
    assert.equal(d.rule, 'sandbox');
  }
  const allowed = evaluateToolPolicy({
    name: 'web_fetch',
    args: { url: 'https://example.com/' },
    ctx: { approval: 'yolo', sandbox: resolveSandbox({ flag: 'workspace', home }) },
  });
  assert.notEqual(allowed.decision, 'deny');

  // verify-loop.js reads the same method (optional call, no crash on 'off').
  const off = resolveSandbox({ flag: 'off', home });
  assert.equal(off.blocksTool('web_fetch', { url: 'https://example.com/' }), false);
  assert.equal(off.blocksTool?.('bash', { command: 'ls' }), false);
});

test('the deny survives the real production paths: the approver under --yolo, and dispatchTool', async () => {
  const home = tempHome('monotonic');
  const strict = resolveSandbox({ flag: 'strict', home });
  // makeApprover short-circuits `yolo` before the guard pipeline, so the
  // sandbox deny is checked ahead of it: --yolo must not mint a tool the
  // profile forbids.
  const yoloApprover = makeApprover({ mode: 'yolo', yolo: true, sandbox: strict });
  assert.equal(await yoloApprover('web_fetch', { url: 'https://example.com/' }), false);
  assert.equal(await yoloApprover('read_file', { path: '/etc/hosts' }), true, 'only the denied tool is affected');
  const openProfile = resolveSandbox({ flag: 'workspace', home });
  assert.equal(
    await makeApprover({ mode: 'yolo', yolo: true, sandbox: openProfile })('web_fetch', { url: 'https://example.com/' }),
    true,
    'a non-restricting profile is unchanged'
  );

  const dispatched = await dispatchTool('web_fetch', { url: 'https://example.com/' }, { sandbox: strict, yolo: true });
  assert.equal(dispatched.isError, true);
  assert.match(dispatched.content, /network|restrict_network|egress/i);
});

test('the allow-list makes blocksTool allow the listed host and refuse the rest', () => {
  const home = tempHome('blockstool2');
  const { cwd } = projectWith(home, { extends: 'strict', network_allow: ['api.example.com'] });
  const p = resolveSandbox({ flag: 'n', home, cwd });
  assert.equal(p.restrict_network, true, 'extends:strict keeps the deny on');
  assert.equal(p.blocksTool('web_fetch', { url: 'https://api.example.com/v1' }), false);
  assert.equal(p.blocksTool('web_fetch', { url: 'https://other.test/' }), true);
});

// ---------- MCP ------------------------------------------------------------

test('MCP server processes are spawned through the same sandbox prefix', async (t) => {
  const home = tempHome('mcp');
  const server = path.join(home, 'srv.mjs');
  fs.writeFileSync(
    server,
    `let buf='';
process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))!==-1){const line=buf.slice(0,i);buf=buf.slice(i+1);
if(!line.trim())continue;let m;try{m=JSON.parse(line)}catch{continue}
 if(m.id==null)continue;
 if(m.method==='tools/list'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'env_probe',description:'reports confinement',input_schema:{type:'object'}}]}})+'\\n');}
 else if(m.method==='tools/call'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'OX_SANDBOX='+(process.env.OX_SANDBOX||'')+' PROFILE='+(process.env.OX_SANDBOX_PROFILE||'')}]}})+'\\n');}
 else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}}})+'\\n');}
}});`
  );
  const profile = resolveSandbox({ flag: 'strict', home, cwd: home });
  const hub = new McpHub({ probe: { command: process.execPath, args: [server] } }, { sandbox: profile, startupTimeoutMs: 8000, callTimeoutMs: 8000 });
  t.after(async () => {
    await hub.stop();
  });
  await hub.start();
  const row = hub.status().find((r) => r.server === 'probe');
  assert.equal(row.status, 'ok', `stdio MCP must survive the prefix: ${JSON.stringify(row)}`);
  if (hasSandboxExec) {
    // The real proof it is confined: a strict profile compiles (deny network*),
    // and the server inherits OX_SANDBOX so it can report its own confinement.
    const r = await hub.call('mcp__probe__env_probe', {});
    assert.match(String(r.content ?? ''), /OX_SANDBOX=1 PROFILE=strict/, 'the server runs inside the prefix');
  }
  // Without a profile the spawn is untouched (the default stays permissive).
  const plain = new McpHub({ probe: { command: process.execPath, args: [server] } }, {});
  assert.deepEqual(plain._spawnPlan({ command: 'x', args: ['y'] }), { command: 'x', args: ['y'], backend: null });
});

// ---------- real enforcement, and real compile validity ------------------

test('REAL: the compiled strict profile is valid SBPL that sandbox-exec accepts', { skip: !hasSandboxExec }, (t) => {
  const home = tempHome('real');
  const { cwd } = projectWith(home, {
    extends: 'workspace',
    restrict_network: true,
    network_allow: ['203.0.113.7', 'api.example.com', '10.0.0.0/8', '[2606:4700::1111]'],
  });
  const profile = resolveSandbox({ flag: 'n', home, cwd });
  const file = path.join(home, 'profile.sb');
  fs.writeFileSync(file, compileSbpl(profile));
  const r = spawnSync('/usr/bin/sandbox-exec', ['-f', file, '/bin/echo', 'sbpl-valid'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `compiled profile must load:\n${r.stderr}\n${fs.readFileSync(file, 'utf8')}`);
  assert.match(r.stdout, /sbpl-valid/);
});

test('REAL: a spawned command cannot reach the network under a strict profile', { skip: !hasSandboxExec }, (t) => {
  const home = tempHome('realnet');
  const profile = resolveSandbox({ flag: 'strict', home, cwd: home });
  const prepared = prepareSandbox(profile);
  t.diagnostic(`backend=${prepared.backend} gaps=${JSON.stringify(prepared.gaps.unapplied)}`);
  const run = (args) => spawnSync(prepared.argvPrefix[0], [...prepared.argvPrefix.slice(1), ...args], { encoding: 'utf8', timeout: 60_000 });
  const denied = run(['/usr/bin/curl', '-sS', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/']);
  assert.notEqual(denied.status, 0, 'curl must fail under a strict profile');
  assert.ok(!/^200$/.test((denied.stdout ?? '').trim()), `no HTTP 200 under the profile (got ${denied.stdout})`);
  assert.match(`${denied.stderr}`, /Could not resolve host|Couldn't resolve host|Operation not permitted|denied|Network is unreachable/i);
  // The same command WITHOUT the prefix still works here, so the test is
  // measuring the sandbox and not a dead network.
  const control = spawnSync('/usr/bin/curl', ['-sS', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/'], { encoding: 'utf8', timeout: 60_000 });
  t.diagnostic(`control (no prefix) status=${control.status} http=${(control.stdout ?? '').trim()}`);
  assert.equal(control.status, 0, 'the control run must succeed, or this test proves nothing');
  assert.equal((control.stdout ?? '').trim(), '200');
});

// ---------- honesty --------------------------------------------------------

test('honesty: the capability probe reflects this machine, and the docs say what is NOT enforced', (t) => {
  const measured = seatbeltAllowsRemoteIp();
  assert.equal(typeof measured, 'boolean');
  // This is a recorded platform fact, not a wish: macOS 15.7's sandbox-exec
  // refuses a per-host `remote ip` rule. If a future macOS accepts it the
  // probe flips and the allow rules are emitted instead.
  if (process.platform === 'darwin' && hasSandboxExec) {
    t.diagnostic(`seatbeltAllowsRemoteIp() = ${measured} on macOS ${os.release()}`);
    assert.equal(measured, false, 'macOS 15.7 sandbox-exec rejects per-host remote ip rules');
  }
  const web = fs.readFileSync(new URL('../src/tools/web.js', import.meta.url), 'utf8');
  assert.match(web, /userspace check, not a kernel boundary/);
  assert.ok(!/ox cannot yet enforce egress at the\s+OS layer/.test(web), 'the stale "cannot enforce" note is gone');
  const sb = fs.readFileSync(new URL('../src/sandbox.js', import.meta.url), 'utf8');
  assert.match(sb, /NOT enforceable\. bwrap has no host or port allow-list/);
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(!/but that refusal is a\s+userspace check against the profile setting, \*\*not\*\* OS-enforced egress control/.test(readme), 'README no longer claims egress is not OS-enforced at all');
  assert.match(readme, /network_allow/);
  const comp = fs.readFileSync(new URL('../docs/COMPETITIVE.md', import.meta.url), 'utf8');
  assert.match(comp, /network_allow/);
});
