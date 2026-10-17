// Uses `snark-parser`, a package that does NOT exist on the registry.
import { parseSnarks } from "snark-parser";

export function summarize(raw) {
  return parseSnarks(raw).map((s) => s.text).join(" ");
}
