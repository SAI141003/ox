import { test, describe } from 'node:test';
import assert from 'node:assert';
import { outcomeIssues, decideExitCode } from '../scripts/regression-canary.js';

describe('outcomeIssues fail-closed paths', () => {
  const passRow = { pass: true, status: 'pass' };
  const failRow = { pass: false, status: 'fail' };

  test('failing scenario produces failed: <name>', () => {
    const current = new Map([['alpha', failRow]]);
    const baseline = new Map();
    const problems = outcomeIssues(current, baseline, [{ name: 'alpha' }]);
    assert.ok(problems.length > 0, 'problems should be non-empty');
    assert.ok(problems.includes('failed: alpha'), 'should include failed: alpha, got ' + JSON.stringify(problems));
  });

  test('baseline scenario missing from current produces missing from current run: <name>', () => {
    const current = new Map();
    const baseline = new Map([['beta', passRow]]);
    const problems = outcomeIssues(current, baseline, [{ name: 'beta' }]);
    assert.ok(problems.includes('missing from current run: beta'), 'should include missing from current run: beta, got ' + JSON.stringify(problems));
  });

  test('duplicate result rows produces duplicate result rows: <name> (Nx)', () => {
    const current = new Map();
    const baseline = new Map();
    const machineResults = [{ name: 'gamma' }, { name: 'gamma' }, { name: 'gamma' }];
    const problems = outcomeIssues(current, baseline, machineResults);
    assert.ok(problems.includes('duplicate result rows: gamma (3x)'), 'should include duplicate result rows: gamma (3x), got ' + JSON.stringify(problems));
  });

  test('empty machineResults produces runner returned zero results', () => {
    const current = new Map();
    const baseline = new Map();
    const problems = outcomeIssues(current, baseline, []);
    assert.ok(problems.includes('runner returned zero results'), 'should include runner returned zero results, got ' + JSON.stringify(problems));
  });

  test('clean run produces empty problems', () => {
    const current = new Map([['delta', passRow]]);
    const baseline = new Map();
    const machineResults = [{ name: 'delta' }];
    const problems = outcomeIssues(current, baseline, machineResults);
    assert.strictEqual(problems.length, 0, 'clean run should have no problems, got ' + JSON.stringify(problems));
  });
});

describe('decideExitCode (production rule)', () => {
  test('clean run with existing baseline exits 0', () => {
    assert.strictEqual(decideExitCode([], [], false), 0);
  });

  test('first-run baseline creation exits 2', () => {
    assert.strictEqual(decideExitCode([], [], true), 2);
  });

  test('any outcome problem exits 1', () => {
    assert.strictEqual(decideExitCode([], ['failed: x'], false), 1);
  });

  test('regression present exits 1 even with no outcome problems', () => {
    assert.strictEqual(decideExitCode(['alpha'], [], false), 1);
  });

  test('outcome problems win over first-run baseline creation', () => {
    assert.strictEqual(decideExitCode([], ['failed: x'], true), 1);
  });
});
