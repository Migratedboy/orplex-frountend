"use client";

/**
 * Rail.tsx — the 52px icon rail (spec §2.4): home / layout (sidebar toggle) /
 * extensions / settings, then theme + the account avatar at the bottom.
 * Hovering (or focusing) the avatar shows the daily-usage card; clicking it
 * opens Settings → Account. Active state follows the ROUTE (settings → gear,
 * /integrations → extensions, everything else → home).
 */
import { useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { Icon } from "@/components/ui/Icon";
import { useTheme } from "@/components/ThemeProvider";
import { useShell } from "./ShellContext";
import { UsagePopover } from "./UsagePopover";

export default function Rail() {
  const router = useRouter();
  const pathname = usePathname();
  const { sidebarCollapsed, toggleSidebar } = useShell();
  const { dark, toggle: toggleTheme } = useTheme();
  const { data: session } = useSession();

  const [usageVisible, setUsageVisible] = useState(false);
  const avatarRef = useRef<HTMLDivElement | null>(null);

  const onSettings = pathname.startsWith("/settings");
  const onIntegrations = pathname.startsWith("/integrations");

  const user = session?.user;
  const initial = (user?.name ?? user?.email ?? "U").trim().charAt(0).toUpperCase() || "U";

  const openAccount = () => {
    setUsageVisible(false);
    router.push("/settings?tab=account");
  };

  return (
    <nav className="ox-rail" data-tour-id="rail" aria-label="Primary">
      <button
        className={!onSettings && !onIntegrations ? "on" : ""}
        data-tour-id="rail-home"
        aria-label="Home"
        title="Home"
        onClick={() => router.push("/")}
      >
        <Icon name="home" size={19} />
      </button>
      <button
        id="ox-layoutbtn"
        data-tour-id="rail-layout"
        aria-label="Toggle sidebar"
        title="Toggle sidebar (Ctrl+\)"
        aria-pressed={!sidebarCollapsed}
        onClick={toggleSidebar}
      >
        <Icon name="layout" size={19} />
      </button>
      <button
        className={onIntegrations ? "on" : ""}
        data-tour-id="rail-apps"
        aria-label="Integrations"
        title="Integrations"
        onClick={() => router.push("/integrations")}
      >
        <Icon name="apps" size={19} />
      </button>
      <button
        className={onSettings ? "on" : ""}
        data-tour-id="rail-settings"
        aria-label="Settings"
        title="Settings"
        onClick={() => router.push("/settings")}
      >
        <Icon name="gear" size={19} />
      </button>
      <div className="ox-sp" />
      <button
        className="ox-themebtn"
        data-tour-id="rail-theme"
        aria-label="Toggle light / dark mode"
        title={dark ? "Switch to light mode" : "Switch to dark mode"}
        onClick={toggleTheme}
      >
        <Icon name={dark ? "moon" : "sun"} size={19} />
      </button>
      <div
        ref={avatarRef}
        className="ox-avatar"
        data-tour-id="rail-avatar"
        role="button"
        tabIndex={0}
        aria-label={`Account — ${user?.name ?? "profile"}`}
        aria-describedby="ox-usage-pop"
        onClick={openAccount}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAccount(); }
        }}
        onMouseEnter={() => setUsageVisible(true)}
        onMouseLeave={() => setUsageVisible(false)}
        onFocus={() => setUsageVisible(true)}
        onBlur={() => setUsageVisible(false)}
      >
        {initial}
      </div>
      <UsagePopover visible={usageVisible} anchor={avatarRef.current} />
    </nav>
  );
}
