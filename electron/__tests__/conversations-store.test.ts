/**
 * conversations-store.test.ts — the on-device conversation store is plain
 * Node (no electron imports) precisely so the exact module the main process
 * runs can be exercised here: caps, atomic persistence, previews, import
 * semantics and the fork copy all get pinned down.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createConversationStore,
  cleanSnippet,
  type LocalConversationStore,
} from "../conversations-store";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orplex-conv-"));
  return path.join(dir, "conversations.json");
}

function makeUserMsg(content: string) {
  return { role: "user", content };
}

describe("conversations-store", () => {
  let file: string;
  let store: LocalConversationStore;

  beforeEach(() => {
    file = tmpFile();
    store = createConversationStore({ file, writeDelayMs: 5 });
  });

  afterEach(() => {
    store.flush();
  });

  it("creates a thread with a local-prefixed id and a title from the first user message", () => {
    const out = store.save({ messages: [makeUserMsg("Debug the login flow"), { role: "assistant", content: "Sure" }] });
    if (!("conversationId" in out)) throw new Error(JSON.stringify(out));
    expect(out.conversationId).toMatch(/^local-/);
    const conv = store.get(out.conversationId);
    expect(conv?.title).toBe("Debug the login flow");
    expect(conv?.messages).toHaveLength(2);
    expect(conv?.workspaceName).toBeNull();
    expect(conv?.id).toBe(out.conversationId);
  });

  it("appends to an existing thread and keeps its workspace tag unless a new one is passed", () => {
    const out = store.save({ workspaceName: "psd10", messages: [makeUserMsg("one")] });
    const id = "conversationId" in out ? out.conversationId : "";
    // Save with a path but WITH an id appended — the tag must stay.
    const out2 = store.save({ conversationId: id, messages: [{ role: "assistant", content: "two" }] });
    expect("error" in out2).toBe(false);
    expect(store.get(id)?.workspaceName).toBe("psd10");

    // Passing a different tag MOVES the thread (cloud semantics).
    store.save({ conversationId: id, workspaceName: "other", messages: [{ role: "user", content: "three" }] });
    expect(store.get(id)?.workspaceName).toBe("other");
    expect(store.get(id)?.messages).toHaveLength(3);

    // Passing vs omitting: omitting keeps "other" (no accidental wipe).
    store.save({ conversationId: id, messages: [{ role: "user", content: "four" }] });
    expect(store.get(id)?.workspaceName).toBe("other");
  });

  it("cuts messages at the 50k cap and rejects empty/too-many saves", () => {
    const out = store.save({ messages: [{ role: "user", content: "x".repeat(60_000) }] });
    if (!("conversationId" in out)) throw new Error(JSON.stringify(out));
    expect(store.get(out.conversationId)!.messages[0].content.length).toBe(50_000);

    expect(store.save({ messages: [] })).toEqual({ error: "Messages required" });
    const many = Array.from({ length: 201 }, () => makeUserMsg("m"));
    expect(store.save({ messages: many })).toEqual({ error: "Too many messages" });
    // Unknown id → same contract as the cloud 404.
    expect(store.save({ conversationId: "nope", messages: [makeUserMsg("m")] })).toEqual({
      error: "Conversation not found",
    });
  });

  it("lists newest-first with the latest message cleaned as preview", () => {
    const clock = { i: 0 };
    const store2 = createConversationStore({
      file: tmpFile(),
      now: () => new Date(2026, 0, 1, 12, 0, clock.i++),
    });
    const a = store2.save({ messages: [makeUserMsg("old thread")] });
    if (!("conversationId" in a)) throw new Error(JSON.stringify(a));
    const b = store2.save({ messages: [makeUserMsg("new thread")] });
    if (!("conversationId" in b)) throw new Error(JSON.stringify(b));
    store2.save({ conversationId: b.conversationId, messages: [{ role: "assistant", content: "[THINKING]secret thoughts[/THINKING] visible reply" }] });

    const list = store2.list();
    expect(list[0].id).toBe(b.conversationId); // newest first
    expect(list[0].messages[0].content).toBe("visible reply"); // thinking stripped
    expect(list.some((c) => c.id === a.conversationId)).toBe(true);
    // Aliases must not leak: list rows carry no live message array.
    expect(Object.keys(list[0])).not.toContain("messagesLength");
  });

  it("rename + remove update the store", () => {
    const out = store.save({ messages: [makeUserMsg("t")] });
    const id = "conversationId" in out ? out.conversationId : "";
    expect(store.rename(id, "renamed title")).toBe(true);
    expect(store.get(id)?.title).toBe("renamed title");
    expect(store.rename(id, "")).toBe(false); // empty title refused
    expect(store.remove(id)).toBe(true);
    expect(store.get(id)).toBeNull();
    expect(store.remove(id)).toBe(false);
  });

  it("get returns a deep copy — renderer mutation cannot corrupt the store", () => {
    const out = store.save({ messages: [makeUserMsg("t")] });
    const id = "conversationId" in out ? out.conversationId : "";
    const copy = store.get(id)!;
    copy.messages.push({ role: "assistant", content: "injected", createdAt: "now" });
    copy.title = "hacked";
    expect(store.get(id)!.messages).toHaveLength(1);
    expect(store.get(id)!.title).toBe("t");
  });

  it("importAll is additive and skips duplicates/malformed rows", () => {
    const out = store.save({ messages: [makeUserMsg("existing")] });
    const existingId = "conversationId" in out ? out.conversationId : "";
    const res = store.importAll([
      { id: existingId, title: "newer cloud version", messages: [] }, // dup → skip
      { id: "c1", title: "cloud one", workspaceName: "psd10", messages: [{ role: "user", content: "hello" }] },
      { title: "no id" }, // malformed → skip
      { messages: null }, // malformed → skip
      { id: "c2", title: "cloud two", messages: "not-an-array" }, // tolerated as empty
    ] as unknown as Parameters<LocalConversationStore["importAll"]>[0]);
    expect(res).toEqual({ imported: 2, skipped: 3 });
    expect(store.get(existingId)?.title).toBe("existing"); // original untouched
    expect(store.get("c1")?.workspaceName).toBe("psd10");
    expect(store.get("c2")?.messages).toHaveLength(0);
    // Re-import is a no-op (idempotent across app restarts/multi-device).
    expect(store.importAll([{ id: "c1", title: "x", messages: [] }])).toEqual({ imported: 0, skipped: 1 });
  });

  it("fork deep-copies a thread under a new local id with the (fork) suffix", () => {
    const out = store.save({ workspaceName: "psd10", messages: [makeUserMsg("Very long original title that goes on and on")] });
    const id = "conversationId" in out ? out.conversationId : "";
    store.save({ conversationId: id, messages: [{ role: "assistant", content: "and the reply" }] });

    const copy = store.fork(id)!;
    expect(copy.id).toMatch(/^local-/);
    expect(copy.id).not.toBe(id);
    expect(copy.title.endsWith(" (fork)")).toBe(true);
    expect(copy.messages).toHaveLength(2);
    expect(copy.messages.map((m) => m.content)).toEqual(
      store.get(id)!.messages.map((m) => m.content)
    );
    expect(copy.workspaceName).toBe("psd10");
    expect(store.fork("missing")).toBeNull();
    // The store now lists both originals.
    expect(store.list().map((c) => c.id)).toContain(copy.id);

    // Fork of a fork keeps a single "(fork)" suffix.
    const copy2 = store.fork(copy.id)!;
    expect(copy2.title).toBe(copy.title);
  });

  it("persists atomically and survives a fresh store instance from the same file", async () => {
    const out = store.save({ messages: [makeUserMsg("persist me")] });
    const id = "conversationId" in out ? out.conversationId : "";
    store.flush();
    // The atomic swap leaves no temp files behind.
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    const reloaded = createConversationStore({ file });
    expect(reloaded.get(id)?.messages[0].content).toBe("persist me");
  });

  it("quarantines a corrupt store file instead of crashing", () => {
    fs.writeFileSync(file, "{ not: valid json");
    const store2 = createConversationStore({ file });
    expect(store2.list()).toEqual([]);
    // The bad file was renamed aside, not deleted.
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes("corrupt"));
    expect(leftovers.length).toBe(1);
  });

  it("cleanSnippet matches the backend's preview rules", () => {
    expect(cleanSnippet('[THINKING] inner math [/THINKING]The answer is 4.')).toBe("The answer is 4.");
    // Status-line-only input strips to empty -> the fallback (1:1 backend
    // cleanSnippet parity) returns the flattened original, not a blank.
    expect(cleanSnippet("[OK] Ran tests\n[FAIL] flaky test")).toBe(
      "[OK] Ran tests [FAIL] flaky test"
    );
    expect(cleanSnippet("<tool_call>x</tool_call>real text")).toBe("real text");
    // Same fallback quirk: the inner text survives (backend 1:1).
    expect(cleanSnippet("[THINKING]only thinking[/THINKING]")).toBe("only thinking");
  });
});
