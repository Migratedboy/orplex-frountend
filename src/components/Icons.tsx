// Icons.tsx — Material Symbols Outlined icon components.
// Backed by the vendored icon font (assets/fonts/material-symbols/, ligature
// names). Every export keeps the name + props of the old stroke-SVG set, so
// call sites are unchanged. The Orplex logo is NOT here — logo.png stays.
//
// Size prop maps to font-size (default 16px ≙ old SVG px size). Icons
// inherit currentColor like the old strokes did.

interface IconProps {
  size?: number;
  className?: string;
}

function Ms({ name, size = 16, className, fill }: { name: string } & IconProps & { fill?: boolean }) {
  return (
    <span
      className={`ms${fill ? " ms-fill" : ""}${className ? ` ${className}` : ""}`}
      style={{ fontSize: size }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

// === Navigation ===

/** Right-panel toggle. Mirrored (scaleX(-1)) by the caller when closed. */
export const IconPanel = (p: IconProps) => <Ms name="right_panel_open" {...p} />;
export const IconChat = (p: IconProps) => <Ms name="chat_bubble" {...p} />;
export const IconHistory = (p: IconProps) => <Ms name="history" {...p} />;
export const IconPlugins = (p: IconProps) => <Ms name="deployed_code" {...p} />;
export const IconSettings = (p: IconProps) => <Ms name="settings" {...p} />;

// === Actions ===

export const IconSearch = (p: IconProps) => <Ms name="search" {...p} />;
export const IconBug = (p: IconProps) => <Ms name="bug_report" {...p} />;
export const IconSun = (p: IconProps) => <Ms name="light_mode" {...p} />;
export const IconMoon = (p: IconProps) => <Ms name="dark_mode" {...p} />;
export const IconBell = (p: IconProps) => <Ms name="notifications" {...p} />;
export const IconEdit = (p: IconProps) => <Ms name="edit" {...p} />;
export const IconTrash = (p: IconProps) => <Ms name="delete" {...p} />;
/** Sign out — used by the sidebar footer's icon-only control. */
export const IconLogout = (p: IconProps) => <Ms name="logout" {...p} />;

/** MCP connectors: the user-supplied plug SVG (rounded servers under a
 *  two-prong plug). Drawn inline — not part of the Material Symbols font. */
export const IconMcp = ({ size = 16, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 200 200"
    className={className}
    aria-hidden="true"
    style={{ display: "block", flexShrink: 0 }}
  >
    {/* connection lines */}
    <line x1="100" y1="128" x2="56" y2="162" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
    <line x1="100" y1="128" x2="100" y2="172" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
    <line x1="100" y1="128" x2="144" y2="162" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
    {/* server nodes */}
    <rect x="43" y="149" width="26" height="26" rx="8" fill="currentColor" />
    <rect x="87" y="159" width="26" height="26" rx="8" fill="currentColor" />
    <rect x="131" y="149" width="26" height="26" rx="8" fill="currentColor" />
    {/* hub */}
    <circle cx="100" cy="128" r="12" fill="currentColor" />
    {/* cord */}
    <path d="M100 90 C100 104 100 108 100 122" stroke="currentColor" strokeWidth="18" strokeLinecap="round" fill="none" />
    {/* plug body */}
    <rect x="70" y="54" width="60" height="36" rx="14" fill="currentColor" />
    {/* plug prongs */}
    <rect x="82" y="30" width="12" height="28" rx="5" fill="currentColor" />
    <rect x="106" y="30" width="12" height="28" rx="5" fill="currentColor" />
  </svg>
);

// === File & Media ===

export const IconFolder = (p: IconProps) => <Ms name="folder" {...p} />;
export const IconFolderOpen = (p: IconProps) => <Ms name="folder_open" {...p} />;
export const IconPaperclip = (p: IconProps) => <Ms name="attach_file" {...p} />;
export const IconImage = (p: IconProps) => <Ms name="image" {...p} />;
export const IconDownload = (p: IconProps) => <Ms name="download" {...p} />;
export const IconCopy = (p: IconProps) => <Ms name="content_copy" {...p} />;

// === Chat ===

export const IconPlus = (p: IconProps) => <Ms name="add" {...p} />;
export const IconStop = (p: IconProps) => <Ms name="stop_circle" {...p} />;
export const IconSend = (p: IconProps) => <Ms name="send" {...p} />;
export const IconClose = (p: IconProps) => <Ms name="close" {...p} />;
export const IconX = (p: IconProps) => <Ms name="close" {...p} />;
export const IconCheck = (p: IconProps) => <Ms name="check" {...p} />;

// === Severity Indicators (bug report) — colored dots, not glyphs ===

export function IconSeverityHigh({ size = 12, className }: IconProps) {
  return <span className={`ms-severity ${className || ""}`} style={{ width: size, height: size, background: "#ef4444" }} />;
}
export function IconSeverityMedium({ size = 12, className }: IconProps) {
  return <span className={`ms-severity ${className || ""}`} style={{ width: size, height: size, background: "#eab308" }} />;
}
export function IconSeverityLow({ size = 12, className }: IconProps) {
  return <span className={`ms-severity ${className || ""}`} style={{ width: size, height: size, background: "#22c55e" }} />;
}

// === Package Icons ===

export const IconModule = (p: IconProps) => <Ms name="layers" {...p} />;
/** Agent Manager — multi-agent orchestration hub. */
export const IconAgentManager = (p: IconProps) => <Ms name="hub" {...p} />;
/** Runs Board — the kanban-style run board. */
export const IconRunsBoard = (p: IconProps) => <Ms name="view_kanban" {...p} />;
export const IconAgent = (p: IconProps) => <Ms name="smart_toy" {...p} />;

// === Misc ===

export const IconArrowRight = (p: IconProps) => <Ms name="arrow_forward" {...p} />;
export const IconMenu = (p: IconProps) => <Ms name="menu" {...p} />;
export const IconMessage = (p: IconProps) => <Ms name="chat" {...p} />;

// === Activity / Progress Icons ===

export const IconFile = (p: IconProps) => <Ms name="description" {...p} />;
export const IconFilePlus = (p: IconProps) => <Ms name="note_add" {...p} />;
export const IconTerminal = (p: IconProps) => <Ms name="terminal" {...p} />;
export const IconBrain = (p: IconProps) => <Ms name="neurology" {...p} />;
export const IconChevronDown = (p: IconProps) => <Ms name="keyboard_arrow_down" {...p} />;
/** Chevron up — paired with IconChevronDown for expand/collapse disclosure. */
export const IconChevronUp = (p: IconProps) => <Ms name="keyboard_arrow_up" {...p} />;
export const IconChevronRight = (p: IconProps) => <Ms name="chevron_right" {...p} />;
// Session insights popup (Outputs / Used in this session / learned patterns).
export const IconInsights = (p: IconProps) => <Ms name="query_stats" {...p} />;
// Vertical kebab (overflow menus).
export const IconMore = (p: IconProps) => <Ms name="more_vert" {...p} />;
export const IconCircle = (p: IconProps) => <Ms name="radio_button_unchecked" {...p} />;
export const IconLoader = (p: IconProps) => <Ms name="progress_activity" {...p} />;
export const IconMinus = (p: IconProps) => <Ms name="remove" {...p} />;
export const IconRefresh = (p: IconProps) => <Ms name="refresh" {...p} />;
/** Fork a conversation into a new on-device copy (History rows / TopBar). */
export const IconFork = (p: IconProps) => <Ms name="call_split" {...p} />;
