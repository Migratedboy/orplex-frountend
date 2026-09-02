import * as vscode from "vscode";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  time: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "orplex.chatView";
  private _view?: vscode.WebviewView;
  private messages: ChatMessage[] = [];
  private apiUrl: string;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {
    const config = vscode.workspace.getConfiguration("orplex");
    this.apiUrl = config.get("apiUrl", "http://localhost:5000");
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._getHtml();
    webviewView.webview.onDidReceiveMessage(async (message: any) => {
      switch (message.type) {
        case "sendMessage":
          await this._handleUserMessage(message.text);
          break;
        case "clearChat":
          this.clearChat();
          break;
      }
    });
  }

  public clearChat(): void {
    this.messages = [];
    this._view?.webview.postMessage({ type: "clearMessages" });
  }

  public async sendCodeAction(prompt: string, code: string, language: string): Promise<void> {
    const fullPrompt = prompt + "\n\n```" + language + "\n" + code + "\n```";
    await this._handleUserMessage(fullPrompt);
  }

  private async _handleUserMessage(text: string): Promise<void> {
    const now = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    this.messages.push({ role: "user", content: text, time: now });
    this._view?.webview.postMessage({ type: "addMessage", role: "user", content: text, time: now });
    this._view?.webview.postMessage({ type: "setLoading", loading: true });

    try {
      const config = vscode.workspace.getConfiguration("orplex");
      const apiKey = config.get("apiKey", "");
      const mode = config.get("mode", "code");

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

      const res = await fetch(this.apiUrl + "/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({
          messages: this.messages.map((m) => ({ role: m.role, content: m.content })),
          conversationId: null,
          mode,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as Record<string, any>;
        throw new Error(errBody?.error?.message || "HTTP " + res.status);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let streamed = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                streamed += parsed.content;
                this._view?.webview.postMessage({ type: "streamChunk", content: streamed });
              }
            } catch {}
          }
        }
      }

      if (streamed) {
        const assistantTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        this.messages.push({ role: "assistant", content: streamed, time: assistantTime });
        this._view?.webview.postMessage({ type: "addMessage", role: "assistant", content: streamed, time: assistantTime });
      }
    } catch (err: unknown) {
      const errorTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const message = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: "addMessage", role: "assistant", content: "Error: " + message, time: errorTime });
    } finally {
      this._view?.webview.postMessage({ type: "setLoading", loading: false });
    }
  }

  private _getHtml(): string {
    const scriptContent = [
      "const vscode = acquireVsCodeApi();",
      "const messagesEl = document.getElementById('messages');",
      "const loadingEl = document.getElementById('loading');",
      "const inputEl = document.getElementById('input');",
      "const sendBtn = document.getElementById('send');",
      "",
      "function escapeHtml(text) {",
      "  const div = document.createElement('div');",
      "  div.textContent = text;",
      "  return div.innerHTML;",
      "}",
      "",
      "function addMessage(role, content, time) {",
      "  const div = document.createElement('div');",
      "  div.className = 'msg msg-' + role;",
      "  div.innerHTML = '<div class=\"msg-content\">' + escapeHtml(content) + '</div><div class=\"msg-time\">' + time + '</div>';",
      "  messagesEl.appendChild(div);",
      "  messagesEl.scrollTop = messagesEl.scrollHeight;",
      "}",
      "",
      "let streamingDiv = null;",
      "",
      "window.addEventListener('message', (event) => {",
      "  const msg = event.data;",
      "  switch (msg.type) {",
      "    case 'addMessage':",
      "      streamingDiv = null;",
      "      addMessage(msg.role, msg.content, msg.time);",
      "      break;",
      "    case 'streamChunk':",
      "      if (!streamingDiv) {",
      "        streamingDiv = document.createElement('div');",
      "        streamingDiv.className = 'msg msg-assistant';",
      "        messagesEl.appendChild(streamingDiv);",
      "      }",
      "      streamingDiv.innerHTML = '<div class=\"msg-content\">' + escapeHtml(msg.content) + '</div>';",
      "      messagesEl.scrollTop = messagesEl.scrollHeight;",
      "      break;",
      "    case 'clearMessages':",
      "      messagesEl.innerHTML = '';",
      "      streamingDiv = null;",
      "      break;",
      "    case 'setLoading':",
      "      loadingEl.className = msg.loading ? 'active' : '';",
      "      sendBtn.disabled = msg.loading;",
      "      break;",
      "  }",
      "});",
      "",
      "function sendMessage() {",
      "  const text = inputEl.value.trim();",
      "  if (!text) return;",
      "  vscode.postMessage({ type: 'sendMessage', text: text });",
      "  inputEl.value = '';",
      "  inputEl.style.height = 'auto';",
      "}",
      "",
      "sendBtn.addEventListener('click', sendMessage);",
      "inputEl.addEventListener('keydown', (e) => {",
      "  if (e.key === 'Enter' && !e.shiftKey) {",
      "    e.preventDefault();",
      "    sendMessage();",
      "  }",
      "});",
      "",
      "inputEl.addEventListener('input', () => {",
      "  inputEl.style.height = 'auto';",
      "  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';",
      "});",
    ].join("\n    ");

    return [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      "<style>",
      "  * { margin: 0; padding: 0; box-sizing: border-box; }",
      "  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); display: flex; flex-direction: column; height: 100vh; }",
      "  #messages { flex: 1; overflow-y: auto; padding: 12px; }",
      "  .msg { margin-bottom: 12px; padding: 8px 12px; border-radius: 8px; max-width: 95%; word-wrap: break-word; }",
      "  .msg-user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); margin-left: auto; text-align: right; }",
      "  .msg-assistant { background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); }",
      "  .msg-time { font-size: 10px; opacity: 0.5; margin-top: 4px; }",
      "  .msg-content { white-space: pre-wrap; font-size: 13px; line-height: 1.5; }",
      "  #loading { display: none; padding: 8px 12px; color: var(--vscode-descriptionForeground); font-style: italic; }",
      "  #loading.active { display: block; }",
      "  #input-area { padding: 8px 12px; border-top: 1px solid var(--vscode-widget-border); display: flex; gap: 8px; }",
      "  #input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px; font-family: inherit; font-size: 13px; resize: none; min-height: 36px; max-height: 120px; }",
      "  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 8px 12px; cursor: pointer; font-size: 13px; }",
      "  #send:hover { background: var(--vscode-button-hoverBackground); }",
      "  #send:disabled { opacity: 0.5; cursor: not-allowed; }",
      "</style>",
      "</head>",
      "<body>",
      '<div id="messages"></div>',
      '<div id="loading">Thinking...</div>',
      '<div id="input-area">',
      '  <textarea id="input" placeholder="Ask Orplex..." rows="1"></textarea>',
      '  <button id="send">Send</button>',
      "</div>",
      "<script>",
      "    " + scriptContent,
      "</script>",
      "</body>",
      "</html>",
    ].join("\n  ");
  }
}
