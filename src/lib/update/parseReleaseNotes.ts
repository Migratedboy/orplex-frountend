export interface ChangeItem {
  tag: "new" | "fix";
  text: string;
}

const NEW_RE = /\b(new|add|added|feat|feature|improv|improve|refresh|faster|update|enhance)\b/i;
const FIX_RE = /\b(fix|fixed|bug|resolve|resolved|patch|correct)\b/i;

export function parseReleaseNotes(notes?: string | null): ChangeItem[] {
  if (!notes || !notes.trim()) return [];
  const items: ChangeItem[] = [];
  const lines = notes.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Only bullet-like lines.
    if (!/^[-*+•]\s+|^\d+\.\s+/.test(trimmed)) continue;
    const clean = trimmed
      .replace(/^[-*+•]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/[#*_`]/g, "")
      .trim();
    if (!clean) continue;
    if (/^#+\s/.test(clean)) continue;
    let tag: "new" | "fix" = "new";
    if (FIX_RE.test(clean)) tag = "fix";
    else if (NEW_RE.test(clean)) tag = "new";
    else tag = "new";
    items.push({ tag, text: clean });
  }
  // De-dupe and cap.
  const seen = new Set<string>();
  const out: ChangeItem[] = [];
  for (const it of items) {
    if (seen.has(it.text)) continue;
    seen.add(it.text);
    out.push(it);
  }
  return out.slice(0, 12);
}