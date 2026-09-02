import * as vscode from "vscode";
import { ChatViewProvider } from "../sidebar/ChatViewProvider";

function getSelectedCode(): { code: string; language: string } | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor — select some code first");
    return null;
  }
  const selection = editor.document.getText(editor.selection);
  if (!selection) {
    vscode.window.showWarningMessage("No code selected — highlight the code you want me to work on");
    return null;
  }
  return { code: selection, language: editor.document.languageId };
}

export async function fixCode(provider: ChatViewProvider): Promise<void> {
  const selected = getSelectedCode();
  if (!selected) return;
  const instruction = await vscode.window.showInputBox({
    prompt: "What's wrong with this code? (optional — leave blank for auto-fix)",
    placeHolder: "e.g. This function has a null pointer when the array is empty",
  });
  const prompt = instruction
    ? `Fix the following code. ${instruction}\n\nProvide the corrected code with a brief explanation of what was wrong.`
    : "Fix any bugs or issues in the following code. Explain what you changed and why.";
  await provider.sendCodeAction(prompt, selected.code, selected.language);
  vscode.commands.executeCommand("orplex.chatView.focus");
}

export async function explainCode(provider: ChatViewProvider): Promise<void> {
  const selected = getSelectedCode();
  if (!selected) return;
  const prompt = "Explain what the following code does, line by line if complex. Include:\n1. What the code does overall\n2. Key logic and control flow\n3. Any potential issues or edge cases";
  await provider.sendCodeAction(prompt, selected.code, selected.language);
  vscode.commands.executeCommand("orplex.chatView.focus");
}

export async function refactorCode(provider: ChatViewProvider): Promise<void> {
  const selected = getSelectedCode();
  if (!selected) return;
  const instruction = await vscode.window.showInputBox({
    prompt: "How should this code be refactored? (optional)",
    placeHolder: "e.g. Extract into a separate function, improve naming, add error handling",
  });
  const prompt = instruction
    ? `Refactor the following code: ${instruction}\n\nProvide the refactored code with explanations.`
    : "Refactor the following code to improve readability, performance, and maintainability. Show the improved version with explanations.";
  await provider.sendCodeAction(prompt, selected.code, selected.language);
  vscode.commands.executeCommand("orplex.chatView.focus");
}
