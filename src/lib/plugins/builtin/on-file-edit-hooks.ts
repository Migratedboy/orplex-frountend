/**
 * Shared onFileEdit logic for plugins that need it
 */
export function getOnFileEditHooks() {
  return [
    "linter",      // Re-lint after edits
    "type-checker", // Re-check types after edits
    "build-watcher", // Notify after edits
    "db-migration",  // Check schema after edits
  ];
}
