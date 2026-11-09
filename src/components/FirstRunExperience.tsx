"use client";

import { useSession } from "next-auth/react";

// FirstRunExperience.tsx — the empty-chat hero, Claude-style composition.
//
// Mascot + personal greeting ("Back at it, {name}") centred above the
// untouched prompt composer; the quick-action toolbar lives BELOW the
// composer (WelcomeActions, rendered by page.tsx). The old starter pills,
// Explore-advanced toggle and Take-the-tour button are gone from this
// surface (the tour still auto-runs once via AppLayout).

export default function FirstRunExperience() {
  const { data: session } = useSession();
  const firstName = session?.user?.name?.trim().split(" ")[0];
  const greeting = firstName ? `Back at it, ${firstName}` : "Back at it";

  return (
    <div className="empty-hero">
      <div className="empty-hero-center empty-hero-greeting">
        {/* eslint-disable-next-line @next/next/no-img-element -- SVG logo: next/image cannot optimize SVG without dangerouslyAllowSVG, which Next.js advises against */}
        <img src="/logo.svg" alt="" aria-hidden="true" className="empty-hero-logo" width={44} height={44} />
        <h1 className="empty-hero-title">{greeting}</h1>
      </div>
    </div>
  );
}