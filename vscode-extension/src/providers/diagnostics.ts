import * as vscode from "vscode";

/**
 * Manages VS Code diagnostics (Problems panel) from Orplex responses.
 * When the agent detects issues in code, it can push diagnostics so they
 * appear in the Problems panel with quick-fix navigation.
 */
export class OrplexDiagnosticsManager {
  private diagnosticCollection: vscode.DiagnosticCollection;

  constructor() {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("orplex");
  }

  /**
   * Push a diagnostic for a specific file/line.
   */
  pushDiagnostic(
    filePath: string,
    line: number,
    message: string,
    severity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Warning,
  ): void {
    const uri = vscode.Uri.file(filePath);
    const range = new vscode.Range(
      new vscode.Position(Math.max(0, line - 1), 0),
      new vscode.Position(Math.max(0, line - 1), Number.MAX_SAFE_INTEGER),
    );

    const diagnostic = new vscode.Diagnostic(
      range,
      message,
      severity,
    );
    diagnostic.source = "Orplex";

    const existing = this.diagnosticCollection.get(uri) || [];
    this.diagnosticCollection.set(uri, [...existing, diagnostic]);
  }

  /**
   * Clear all diagnostics for a file.
   */
  clearFile(filePath: string): void {
    this.diagnosticCollection.delete(vscode.Uri.file(filePath));
  }

  /**
   * Clear all Orplex diagnostics.
   */
  clearAll(): void {
    this.diagnosticCollection.clear();
  }

  dispose(): void {
    this.diagnosticCollection.dispose();
  }
}
