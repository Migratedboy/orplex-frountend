import * as vscode from "vscode";

/**
 * CodeLens provider — shows "Ask Orplex" links above functions, classes,
 * and exported symbols so users can one-click into a contextual chat.
 */
export class OrplexCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const functionPattern = /^(export\s+)?(async\s+)?(function\s+\w+|class\s+\w+|const\s+\w+\s*=\s*(async\s+)?\()/gm;

    let match;
    while ((match = functionPattern.exec(text))) {
      const line = document.lineAt(document.positionAt(match.index).line);
      const range = new vscode.Range(line.range.start, line.range.end);

      // "Ask Orplex" lens
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(comment-discussion) Ask Orplex",
          command: "orplex.explain",
          tooltip: "Explain this code with Orplex",
        }),
      );

      // "Fix with Orplex" lens (only for functions, not classes)
      if (match[0].includes("function") || match[0].includes("=>")) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(wrench) Fix",
            command: "orplex.fix",
            tooltip: "Fix issues in this code with Orplex",
          }),
        );

        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(sync) Refactor",
            command: "orplex.refactor",
            tooltip: "Refactor this code with Orplex",
          }),
        );
      }
    }

    return lenses;
  }
}
