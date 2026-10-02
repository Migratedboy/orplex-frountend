import * as vscode from "vscode";
import { ChatViewProvider } from "./sidebar/ChatViewProvider";
import { fixCode, explainCode, refactorCode } from "./commands/codeActions";
import { OrplexCodeLensProvider } from "./providers/codeLens";
import { OrplexDiagnosticsManager } from "./providers/diagnostics";
import { InlineChatProvider } from "./providers/inlineChat";
import { pickProvider } from "./providers/providerSelector";

export function activate(context: vscode.ExtensionContext) {
  console.log("[Orplex] Extension activated");

  // ---- Chat webview provider ----
  const chatProvider = new ChatViewProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("orplex.chatView", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ---- Diagnostics manager ----
  const diagnostics = new OrplexDiagnosticsManager();
  context.subscriptions.push(diagnostics);

  // ---- Inline chat ----
  const inlineChat = new InlineChatProvider(
    (prompt, code, lang) => chatProvider.sendCodeAction(prompt, code, lang),
  );

  // ---- Register commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand("orplex.chat", () => {
      vscode.commands.executeCommand("orplex.chatView.focus");
    }),
    vscode.commands.registerCommand("orplex.fix", () => fixCode(chatProvider)),
    vscode.commands.registerCommand("orplex.explain", () => explainCode(chatProvider)),
    vscode.commands.registerCommand("orplex.refactor", () => refactorCode(chatProvider)),
    vscode.commands.registerCommand("orplex.clearChat", () => chatProvider.clearChat()),
    vscode.commands.registerCommand("orplex.inlineChat", () => inlineChat.startInlineChat()),
    vscode.commands.registerCommand("orplex.switchModel", async () => {
      const config = vscode.workspace.getConfiguration("orplex");
      const picked = await pickProvider(config);
      if (picked) {
        await config.update("model", picked.model, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Orplex model set to ${picked.model}`);
      }
    }),
    vscode.commands.registerCommand("orplex.clearDiagnostics", () => diagnostics.clearAll()),
  );

  // ---- CodeLens provider ----
  const codeLensProvider = new OrplexCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: "file" },
      codeLensProvider,
    ),
  );

  // ---- Status bar ----
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusItem.text = "$(rocket) Orplex";
  statusItem.tooltip = "Orplex Code — AI Coding Assistant";
  statusItem.command = "orplex.chat";
  statusItem.show();
  context.subscriptions.push(statusItem);
}

export function deactivate() {
  console.log("[Orplex] Extension deactivated");
}
