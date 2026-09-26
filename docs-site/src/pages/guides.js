import React from "react";
import { Redirect } from "@docusaurus/router";

// The navbar "Guides" item points at /guides; route it to the auto-generated
// Guides category landing page so onBrokenLinks: throw stays satisfied.
export default function Guides() {
  return <Redirect to="/docs/category/guides" />;
}
