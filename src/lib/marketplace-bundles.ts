// marketplace-bundles.ts — materialized plugin bundles from the marketplace.
//
// Server-only on purpose. Materializing a bundle turns definitions into text and
// pulls in filesystem code (the same module answers "is this bundle installed in
// this workspace?"), so it must never be in a client bundle. background-worker is
// client-reachable, which is exactly why the host registration lives here and not
// in sdk-host.ts.
//
// getMaterializedBundles() also registers the SDK's library-bundle provider: the
// hook gate runs deep inside dispatch with no caller to hand bundles to, so it
// asks the host. Importing this module from a server entry point is what makes
// installed bundle rules take effect; without it the gate sees no rules.
import { configureLibraryBundles } from "@orplex/sdk/lib/plugin-library-state";
import { materializeBundles, type LibraryBundle } from "@orplex/sdk/lib/plugin-library";
import type { BundleDef } from "@orplex/sdk/lib/plugin-library/types";
import { getPluginBundles } from "./marketplace-client";

let registered = false;
let memo: Promise<readonly LibraryBundle[]> | null = null;

function register(bundles: readonly LibraryBundle[]): readonly LibraryBundle[] {
  if (!registered) {
    registered = true;
    configureLibraryBundles(() => bundles);
  }
  return bundles;
}

/** Bundles as published (raw definitions). */
export async function getRawPluginBundles(): Promise<ReadonlyArray<BundleDef>> {
  return getPluginBundles();
}

/** Bundles ready to install: each carries its materialized skills + hooks. */
export function getMaterializedBundles(): Promise<readonly LibraryBundle[]> {
  memo ??= getPluginBundles()
    .then((defs) => register(materializeBundles(defs)))
    .catch(() => {
      // An unreachable marketplace must not wedge the hook gate; an empty list
      // means "no library rules", which is the fail-closed answer.
      memo = null;
      return register([]);
    });
  return memo;
}
