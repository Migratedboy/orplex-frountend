"use client";

/**
 * WindowControls.tsx — Min / Max / Close for the frameless Electron window
 * (spec §7). Rendered ONLY when the desktop bridge exposes `window` IPC and
 * the platform is not macOS (macOS uses native traffic lights). The web
 * build renders nothing.
 */
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";

interface DesktopWindowBridge {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => boolean;
  onMaximizeChange: (cb: (maximized: boolean) => void) => void;
  platform?: string;
}

function bridge(): DesktopWindowBridge | null {
  const d = (window as unknown as { orplexDesktop?: { window?: DesktopWindowBridge; platform?: string } }).orplexDesktop;
  return d?.window ?? null;
}

export function WindowControls() {
  const [available, setAvailable] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    const b = bridge();
    if (!b) return;
    setAvailable(true);
    setIsMac(/mac/i.test(navigator.platform) || b.platform === "darwin");
    let live = true;
    void Promise.resolve(b.isMaximized()).then((v) => { if (live) setMaximized(!!v); });
    try {
      b.onMaximizeChange((v) => { if (live) setMaximized(!!v); });
    } catch {}
    return () => { live = false; };
  }, []);

  if (!available || isMac) return null;
  const b = bridge()!;

  return (
    <div className="ox-win">
      <button aria-label="Minimize" title="Minimize" onClick={() => b.minimize()}>
        <Icon name="min" size={14} />
      </button>
      <button aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"} onClick={() => b.toggleMaximize()}>
        <Icon name={maximized ? "restore" : "max"} size={14} />
      </button>
      <button className="ox-close" aria-label="Close" title="Close" onClick={() => b.close()}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
