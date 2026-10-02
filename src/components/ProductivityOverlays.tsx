"use client";

import dynamic from "next/dynamic";

// ProductivityOverlays.tsx — global hosts for the one-tip-per-session drawer
// and the post-update "What's new" modal. Rendered from the root layout so
// their window events fire on every page, and so the update check happens
// exactly once per app boot.

const TipsDrawer = dynamic(() => import("./TipsDrawer"), { ssr: false });
const WhatIsNew = dynamic(() => import("./WhatIsNew"), { ssr: false });
const RecoverSessionPrompt = dynamic(() => import("./RecoverSessionPrompt"), { ssr: false });
const OfflineBanner = dynamic(() => import("./OfflineBanner"), { ssr: false });

export default function ProductivityOverlays() {
  return (
    <>
      <OfflineBanner />
      <TipsDrawer />
      <WhatIsNew />
      <RecoverSessionPrompt />
    </>
  );
}
