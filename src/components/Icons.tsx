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
export const IconChevronRight = (p: IconProps) => <Ms name="chevron_right" {...p} />;
export const IconCircle = (p: IconProps) => <Ms name="radio_button_unchecked" {...p} />;
export const IconLoader = (p: IconProps) => <Ms name="progress_activity" {...p} />;
export const IconMinus = (p: IconProps) => <Ms name="remove" {...p} />;
export const IconRefresh = (p: IconProps) => <Ms name="refresh" {...p} />;
