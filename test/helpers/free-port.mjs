// A port number nobody else on this machine is using.
//
// Tests that need a TCP listener ask the OS for one instead of computing a
// number themselves. A computed port — `19000 + Math.floor(Math.random() * 500)`
// — is only correct if nothing else in that band is listening, and under
// `--test-concurrency` a sibling test file is starting a server at the same
// moment. Two files drawing from one narrow band collide, the loser's bind
// fails with EADDRINUSE, and the failure surfaces as a socket timeout in a test
// that has nothing to do with ports. A band 500 wide also collides with whatever
// unrelated service the developer happens to be running.
//
// Binding on port 0 hands the choice to the kernel, which picks from the
// ephemeral range and refuses ports already bound. We then close the probe and
// hand the number to whoever needs it.
//
// The one thing this cannot do is keep the port reserved. `ox serve --port N`
// binds in a child process, so a listener held here would be the very thing
// that broke the test. The release-then-rebind window is real but tiny, and
// crucially it is silent: a port stolen inside that window makes the child's
// bind fail loudly with EADDRINUSE, never a half-open connection. Tests that
// spawn a server should assert on that error instead of swallowing it.

import net from 'node:net';

// `ox serve` defaults to --host 127.0.0.1, so probe the same address the child
// will bind. Probing 127.0.0.1 is also the narrow question: it only tells us
// this port is free *on loopback*, which is precisely the claim we need.
const DEFAULT_HOST = '127.0.0.1';

const ATTEMPTS = 5;

// Bind port 0, read the port the kernel picked, release it, return the number.
export function freePort({ host = DEFAULT_HOST } = {}) {
  return new Promise((resolve, reject) => {
    // `server.listen({ port: 0, host }, cb)` keeps EADDRINUSE as an 'error'
    // event rather than a throw, so one code path handles both outcomes.
    const server = net.createServer();

    const fail = (err) => {
      server.removeAllListeners();
      try { server.close(); } catch { /* never bound */ }
      reject(err);
    };

    server.once('error', fail);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        fail(new Error('free-port: server bound a pipe instead of a TCP port'));
        return;
      }
      const { port } = address;
      // Await the close: returning the number while the probe still holds it
      // would hand the caller a port we are about to release, and the child's
      // bind would race our own teardown.
      server.close((err) => {
        server.removeAllListeners();
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

// A port that was free a moment ago, redrawn a few times if the draw is stolen.
// This covers the one case freePort cannot rule out alone: the kernel hands us a
// port and another process grabs it in the microseconds before we close the
// probe, which resurfaces as EADDRINUSE on the next bind. It is a re-draw, not
// a delay — no sleeping, no fixed backoff.
export async function reserveFreePort({ host = DEFAULT_HOST, attempts = ATTEMPTS } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await freePort({ host });
    } catch (err) {
      if (err?.code !== 'EADDRINUSE') throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('free-port: no free port after ' + attempts + ' attempts');
}
