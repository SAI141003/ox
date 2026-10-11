#!/bin/bash
cat > .mcp.json << 'INNEREOF'
{
  "mcpServers": {
    "t": {
      "command": "node",
      "args": ["/path/to/mcp-server.js"]
    }
  }
}
INNEREOF

cat > .ox.json << 'INNEREOF'
{
  "mcpPolicy": {
    "allow": ["mcp__t__echo"]
  }
}
INNEREOF
