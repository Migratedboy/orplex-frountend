---
sidebar_position: 2
---

# Tool API

## Available Tools

Orplex provides these tools to the AI agent:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create or overwrite a file |
| `edit_file` | Edit specific text in a file |
| `batch_edit` | Edit multiple files at once |
| `list_files` | List directory contents |
| `search_code` | Search for text patterns |
| `run_command` | Execute shell commands |
| `run_in_sandbox` | Execute in sandboxed environment |
| `web_search` | Search the web |
| `take_screenshot` | Capture browser screenshot |
| `undo_last_change` | Revert last file change |
| `todo_list` | Manage task lists |
| `ask_question` | Ask user a question |

## Tool Call Format

```xml
<tool_call>{"name":"read_file","path":"src/index.ts"}</tool_call>
```

## Native Tool Calls

M3 uses native function calling:

```json
{
  "tool_calls": [{
    "function": {
      "name": "write_file",
      "arguments": "{\"path\":\"out.txt\",\"content\":\"hello\"}"
    }
  }]
}
```
