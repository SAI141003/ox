import { createAcpServer } from '/Users/saiyaganti/ox/src/acp.js';

void (async () => {
  const server = createAcpServer({}, {
    target: 'ox-ollama',
    cwd: process.cwd(),
    config: { defaultBot: process.env.OX_DEFAULT_BOT, mcpServers: {} },
  });
  await server.start();
})();
