"use client";

/**
 * Icon.tsx — shared inline-SVG symbol set ported 1:1 from
 * design/orplex-shell.html (§1 non-negotiables: reuse the shell's symbol set).
 * The <symbol> defs render once (IconDefs, mounted by AppShell); every icon
 * is <svg><use href="#ox-NAME"/></svg>. Paths are stroke-based, currentColor.
 */
export type IconName =
  | "back" | "fwd" | "bell" | "laptop" | "trash" | "check" | "plus" | "x"
  | "min" | "max" | "restore" | "home" | "layout" | "apps" | "gear"
  | "search" | "panel" | "edit" | "folder" | "folderplus" | "hourglass"
  | "up" | "branch" | "invite" | "help" | "sun" | "moon" | "tasks" | "term"
  | "panelr" | "chat" | "spark" | "undo" | "plug" | "chev" | "globe" | "cloud";

const PATHS: Record<IconName, string> = {
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  fwd: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  bell: '<path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 20h20"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  min: '<path d="M5 12h14"/>',
  max: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  restore: '<rect x="5" y="5" width="14" height="14" rx="1.5"/><path d="M8 3h11a1 1 0 011 1v11" fill="none" stroke="none" opacity="0"/><path d="M9 5V4a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1h-1"/>',
  home: '<path d="M3 11l9-8 9 8v10h-6v-6H9v6H3z"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  folderplus: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M12 11v6M9 14h6"/>',
  hourglass: '<path d="M6 2h12M6 22h12M7 2v4l5 6-5 6v4M17 2v4l-5 6 5 6v4"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10v1a4 4 0 01-4 4H6"/>',
  invite: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 014-4h6a4 4 0 014 4v2M19 8v6M16 11h6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  tasks: '<path d="M4 6h16M4 12h16M4 18h9"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7.5 10l3 2.5-3 2.5M13 15h4"/>',
  panelr: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/>',
  chat: '<path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  undo: '<path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 01-4 4h-4a4 4 0 01-4-4V8z"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 100-9 6 6 0 00-11.7 1.6A3.5 3.5 0 006.5 19z"/>',
};

export function Icon({ name, size = 16, className = "", strokeWidth = 1.8 }: { name: IconName; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg
      className={`ox-i ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] ?? "" }}
    />
  );
}

/** Renders the symbol/defs once. Mounted by AppShell. */
export function IconDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        {Object.entries(PATHS).map(([id, d]) => (
          <symbol key={id} id={`ox-${id}`} viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: d }} />
        ))}
      </defs>
    </svg>
  );
}
