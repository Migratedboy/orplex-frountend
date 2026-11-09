"use client";

/* WelcomeActions.tsx — quick-action toolbar under the composer on the empty
   welcome screen. Every chip is a real action: Code/Write/Create/Map repo
   hand text to the composer (orplex:prefill-prompt); Open folder runs the
   real workspace picker. No dead buttons, nothing decorative. */

import { useFileSystemContext } from "./FileSystemProvider";

const ACTIONS = [
  { icon: "code", label: "Code", text: "Write code for " },
  { icon: "edit", label: "Write", text: "Write " },
  { icon: "auto_awesome", label: "Create", text: "Create " },
  { icon: "folder_open", label: "Open folder", action: "open-folder" as const },
  { icon: "map", label: "Map repo", text: "Map this repository: entry points, the main modules, and how data flows between them." },
];

export default function WelcomeActions() {
  const { openFolder } = useFileSystemContext();
  return (
    <div className="welcome-actions" role="toolbar" aria-label="Quick actions">
      {ACTIONS.map((a) => (
        <button
          key={a.label}
          type="button"
          className="welcome-action"
          onClick={() => {
            if (a.action === "open-folder") {
              void openFolder();
              return;
            }
            window.dispatchEvent(new CustomEvent("orplex:prefill-prompt", { detail: { text: a.text } }));
          }}
        >
          <span className="ms ms-sm" aria-hidden="true">{a.icon}</span>
          <span>{a.label}</span>
        </button>
      ))}
    </div>
  );
}