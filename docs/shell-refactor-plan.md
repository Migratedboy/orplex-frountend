# Shell refactor plan (from design/orplex-shell.html)

Recon done (2026-11-11). Source of truth: `design/orplex-shell.html` (104 KB, read end-to-end),
`UI-LAYOUT.md`, and the current sources.

## Files to ADD

```
src/components/shell/AppShell.tsx          // replaces AppLayout composition
src/components/shell/Strip.tsx             // lead + conversation tabs + right tabs + window controls
src/components/shell/Rail.tsx
src/components/shell/ToolsCluster.tsx
src/components/shell/NotificationsPopover.tsx
src/components/shell/UsagePopover.tsx
src/components/shell/WindowControls.tsx
src/components/shell/ShellContext.tsx      // sidebar collapse + surface mode + shell state
src/components/shell/RightPanelContext.tsx // lifted right-panel tab state (strip + panel body)
src/components/shell/shell.css             // ported from the shell <style> (namespaced under .ox-shell)
src/components/ui/Icon.tsx                 // shared SVG symbol set from the shell
src/lib/shortcuts.ts                       // single-source shortcut registry + dispatcher
src/app/integrations/page.tsx              // MCP connectors page
src/components/integrations/*              // page bodies (connected list, popular grid, custom dialog)
src/components/settings-new/*              // General/Account/Appearance/Usage/Skills/Shortcuts/Archived pages
```

## Files to CHANGE

- `src/app/globals.css` — port tokens (dark default + `[data-theme="light"]`), remap legacy
  semantic vars onto shell tokens at the boundary, body font 13.5px Segoe stack.
- `src/components/ThemeInit.tsx` / `ThemeProvider.tsx` — `light|dark|system` pref, data-theme + `.dark`.
- `src/components/AppLayout.tsx` — thin wrapper around AppShell (keeps overlay bridges).
- `src/app/layout.tsx` — unchanged chain.
- `src/components/right-panel/RightPanelShell.tsx` — consumes RightPanelContext; tab bar moves to strip.
- `src/app/settings/page.tsx` — new 11-page settings.
- `src/app/plugins/page.tsx` — redirect to `/integrations`.
- `src/components/ChatInput.tsx` — plug button opens small popover → Manage integrations link.
- `src/components/CommandPalette.tsx` — Plugins → Integrations entries + new commands.
- `src/components/tutorial/tutorial-steps.ts` — re-anchor moved top-bar items.
- `electron/main.ts` / `electron/preload.ts` — frameless window + window-control IPC.

## Files to DELETE

- `src/components/TopBar.tsx` (after re-homing every control).
- `src/components/ui/ShortcutsPanel` usage → Settings → Keyboard shortcuts page.

## Decisions applied

D1 dark default · D2 Code/Chat surface mode · D4 defaults = wired today · D5 server-side secrets ·
D6 /plugins redirect · D7 archived implemented · D8 window controls Electron-only ·
D9 sidebar 255 / right 420 · D10 monograms unless brand icon exists.

## Phases

2 tokens+theme → 3 shell skeleton → 4 strip behaviors → 5 Electron chrome → 6 settings →
7 integrations → 8 polish/a11y/mobile → 9 QA + report. Commit after each phase.
