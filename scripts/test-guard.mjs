// Explicit, expensive repository-mutation sweep. This is deliberately not
// part of the normal npm test path: the guard launches every other test file
// and therefore makes the suite run twice by design.
process.env.OX_SKIP_REPO_GUARD = '0';
process.argv = [process.argv[0], process.argv[1], 'test/repo-mutation-guard.test.js'];
await import('./test.mjs');
