---
sidebar_position: 3
---

# Building Plugins

## Plugin Structure

```
my-plugin/
  src/
    index.ts      — Plugin entry point
    hooks.ts      — Lifecycle hooks
  package.json
  README.md
```

## Plugin API

```typescript
import { Plugin } from "orplex-plugin-sdk";

export default class MyPlugin implements Plugin {
  name = "my-plugin";
  version = "1.0.0";

  async onActivate() {
    console.log("Plugin activated!");
  }

  async beforeToolCall(name: string, args: any) {
    // Modify or block tool calls
    return args;
  }

  async onFileWrite(path: string, content: string) {
    // React to file writes
  }
}
```

## Available Hooks

| Hook | When | Purpose |
|------|------|---------|
| `onActivate` | Plugin loaded | Initialize resources |
| `beforeToolCall` | Before tool executes | Modify/block tool calls |
| `afterToolCall` | After tool executes | Log/transform results |
| `onFileWrite` | File written | Lint, format, notify |
| `onTaskStart` | Task begins | Setup resources |
| `onTaskComplete` | Task ends | Cleanup, report |

## Publishing

```bash
orplex plugin publish ./my-plugin
```
