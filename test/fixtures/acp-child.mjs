import { createAcpServer } from '../../src/acp.js';

void (async () => {
  // No pinned target unless the test asks for one: a hardcoded local bot made
  // "no reachable provider" pass or fail depending on whether Ollama was running.
  const server = createAcpServer({}, {
    target: process.env.OX_ACP_TARGET || null,
    cwd: process.cwd(),
    config: { defaultBot: process.env.OX_DEFAULT_BOT, mcpServers: {} },
  });
  await server.start();
})();
