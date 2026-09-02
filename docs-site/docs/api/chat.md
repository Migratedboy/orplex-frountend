---
sidebar_position: 1
---

# Chat API

## POST /api/chat

Send a message and receive a streaming response.

### Request

```json
{
  "messages": [
    { "role": "user", "content": "Fix this bug" }
  ],
  "conversationId": "conv_abc123",
  "mode": "code"
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messages` | Message[] | Yes | Array of chat messages |
| `conversationId` | string | No | Conversation ID (null for new) |
| `mode` | string | No | `ask`, `plan`, or `code` (default: `ask`) |
| `images` | string[] | No | Base64 image data URLs |

### Response

SSE stream with `text/event-stream` content type.

#### Events

| Event | Data | Description |
|-------|------|-------------|
| `data:` | `{"content": "..."}` | Text content chunk |
| `data:` | `{"thinking": "..."}` | Thinking/reasoning content |
| `data:` | `{"tool_calls": [...]}` | Tool calls to execute |
| `data:` | `[DONE]` | Stream complete |

### Example (cURL)

```bash
curl -X POST http://localhost:5000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"mode":"ask"}' \
  --no-buffer
```

### Example (JavaScript)

```javascript
const res = await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    messages: [{ role: "user", content: "Fix this bug" }],
    mode: "code",
  }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value, { stream: true });
  // Parse SSE events...
}
```
