---
name: unity
description: Unity game development via MCP + skills. Use for AI-driven Unity Editor automation.
author: ox
version: 1.0.0
metadata:
  category: gamedev
  trigger: command
---

# Unity

AI-driven Unity Editor automation through the Unity MCP server. Enables
script generation, asset management, scene manipulation, and play-mode testing
from any MCP-capable agent (ox, Claude, Kilo).

## Installation

### Prerequisites

- Unity Hub + Unity Editor (2021.3 LTS or newer)
- Node.js >= 18
- ox agent with MCP support

### Step 1 — Install the Unity MCP server

```bash
# Via npm
npm install -g @ox-mcp/unity-mcp

# Or via npx (no global install needed)
# The server will be fetched on first run
```

### Step 2 — Enable Unity Editor integration

1. Open Unity Hub → Installs → select your Unity version
2. In Unity Editor, open the project you want to automate
3. Install the Unity MCP package:

```bash
# From your Unity project root
openupm add com.ox.mcp.unity
```

Or via Unity Package Manager → Add package from git URL:
```
https://github.com/ox-platform/unity-mcp.git
```

### Step 3 — Configure MCP in ox

Add to `~/.config/ox/mcp.json`:

```json
{
  "mcpServers": {
    "unity": {
      "command": "npx",
      "args": ["@ox-mcp/unity-mcp"],
      "env": {
        "UNITY_PROJECT_PATH": "/path/to/your/unity/project",
        "UNITY_EDITOR_PATH": "/Applications/Unity/Hub/Editor/2022.3.5f1/Unity.app/Contents/MacOS/Unity",
        "UNITY_MCP_PORT": "8090"
      }
    }
  }
}
```

### Step 4 — Connect the Unity Editor

In the Unity Editor, open the **MCP Bridge** window (Window → Analysis → MCP Bridge)
and click **Connect**. Or run from the Unity console:

```csharp
MCPBridge.Connect("localhost", 8090);
```

### Step 5 — Verify

```bash
ox mcp list
# unity — registered, connected to Editor
```

## Available Tools

| Tool | Description |
|---|---|
| `unity_create_script(name, className, template?)` | Create a C# MonoBehaviour script |
| `unity_edit_script(path, changes)` | Edit an existing script |
| `unity_list_scenes()` | List all scenes in the project |
| `unity_load_scene(name)` | Load a scene into the editor |
| `unity_create_object(type, name, parent?)` | Create a GameObject in the scene |
| `unity_find_objects(query)` | Find GameObjects by name, tag, or type |
| `unity_get_component(go, type)` | Read component properties |
| `unity_set_component(go, type, props)` | Modify component properties |
| `unity_build_player(outputPath, platform?)` | Build the project |
| `unity_play()` | Enter Play Mode |
| `unity_stop()` | Exit Play Mode |
| `unity_take_screenshot(path?)` | Screenshot the Game view |
| `unity_console()` | Read console logs |
| `unity_import_asset(path)` | Import an asset into the project |
| `unity_create_prefab(go, name)` | Convert GameObject to a prefab |

## Usage Examples

### Generate a Script

```js
const script = await tools.unity_create_script(
  "PlayerController", "PlayerController", "monobehaviour"
);

// Then edit it
await tools.unity_edit_script(script.path, {
  methods: [{
    name: "Update",
    body: `if (Input.GetKeyDown(KeyCode.Space)) {
  Jump();
}`
  }]
});
```

### Scene Setup

```js
// Load the main scene
await tools.unity_load_scene("MainMenu");

// Create a player character
const player = await tools.unity_create_object(
  "3D Object/Capsule", "Player"
);

// Add a Rigidbody component
await tools.unity_add_component(player, "Rigidbody");
await tools.unity_set_component(player, "Rigidbody", {
  useGravity: true,
  mass: 1.0
});

// Position the camera
const cam = await tools.unity_find_objects({ name: "Main Camera" });
await tools.unity_set_component(cam[0], "Transform", {
  position: [0, 5, -10],
  rotation: [30, 0, 0]
});
```

### Play Mode Testing

```js
await tools.unity_play();
await tools.unity_take_screenshot("test-run-1.png");

// Check logs for errors
const logs = await tools.unity_console();
if (logs.some(l => l.type === "Error")) {
  console.log("Errors found:", logs.filter(l => l.type === "Error"));
}

await tools.unity_stop();
```

### Build

```js
const build = await tools.unity_build_player(
  "./builds/game.exe", "Windows64"
);
console.log("Build output:", build.outputPath);
```

## Script Templates

The `unity_create_script` tool supports these templates:

| Template | Base Class | Purpose |
|---|---|---|
| `monobehaviour` | `MonoBehaviour` | Standard game logic |
| `editor` | `Editor` | Custom editor scripts |
| `scriptableobject` | `ScriptableObject` | Data containers |
| `mono singleton` | `MonoBehaviour` | Singleton pattern |
| `state machine` | `MonoBehaviour` | FSM implementation |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `UNITY_PROJECT_PATH` | — | Path to Unity project root (required) |
| `UNITY_EDITOR_PATH` | `auto` | Path to Unity Editor executable |
| `UNITY_MCP_PORT` | `8090` | Port for MCP bridge connection |
| `UNITY_HEADLESS` | `false` | Run Unity in batchmode (no GUI) |

## Troubleshooting

### Failed to connect to Unity Editor
- Ensure the MCP Bridge window is open and connected
- Check that `UNITY_EDITOR_PATH` points to the correct Unity version
- Try restarting both the Unity Editor and the MCP server

### Script compilation errors
- Verify the project's target .NET version (recommended: .NET 4.x)
- Check the Unity console for error details: `tools.unity_console()`

### Headless mode not working
- Install Unity's batchmode support: `Unity -batchmode -quit -executeMethod ...`
- Some GUI operations are not available in headless mode

## References

- [Unity MCP GitHub](https://github.com/ox-platform/unity-mcp)
- [Unity Scripting API](https://docs.unity3d.com/ScriptReference/)
- [MCP specification](https://spec.modelcontextprotocol.io/)
