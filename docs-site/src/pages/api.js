import React from "react";
import { Redirect } from "@docusaurus/router";

// The navbar "API Reference" item points at /api; route it to the
// auto-generated API Reference category landing page so
// onBrokenLinks: throw stays satisfied.
export default function Api() {
  return <Redirect to="/docs/category/api" />;
}
