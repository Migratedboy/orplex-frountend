import * as vscode from "vscode";

/**
 * Inline chat — allows the user to select code, press Ctrl+I, type an
 * instruction, and get a streaming replacement suggestion inline.
 *
 * This is a lightweight implementation that opens a quick-pick input,
 * sends the selection + instruction to the chat provider, and shows the
 * result as a proposed edit.
 */
export class InlineChatProvider {
  constructor(
    private sendToChat: (prompt: string, code: string, language: string) => Promise<void>,
  ) {}

  /**
   * Open inline chat for the current selection.
   */
  async startInlineChat(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active editor — select some code first");
      return;
    }

    const selection = editor.document.getText(editor.selection);
    if (!selection) {
      vscode.window.showWarningMessage("No code selected — highlight code to edit inline");
      return;
    }

    const instruction = await vscode.window.showInputBox({
      prompt: "How should this code be changed?",
      placeHolder: "e.g. Add error handling, extract into a function, fix the null check",
    });

    if (!instruction) return;

    const language = editor.document.languageId;
    const fullPrompt =
      `${instruction}\n\nApply the change to the following code and show the complete replacement.\n\n` +
      "```" + language + "\n" + selection + "\n```";

    // Send to chat panel for streaming response
    await this.sendToChat(fullPrompt, selection, language);
    vscode.commands.executeCommand("orplex.chatView.focus");

    vscode.window.showInformationMessage(
      "Orplex is generating a replacement — check the chat panel.",
    );
  }
}
