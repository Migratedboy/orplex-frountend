/**
 * code-block-extraction.test.ts — pins the CODE BLOCK EXTRACTION fallback in
 * background-worker.ts.
 *
 * The failure it guards against (live report 2026-11-06): the user asked the
 * agent to "rate my project". The model's answer quoted project code in a few
 * fenced blocks to illustrate findings — and the extraction fallback yanked
 * those fences out of the answer, saved them as 3 generated files inside the
 * user's OPEN repo, and replaced the rating with
 * "[3 file(s) extracted from code blocks and saved to workspace]".
 *
 * Contract:
 *   • analysis/review prompts (no build verbs) → fences stay IN the answer,
 *     nothing is written to the workspace;
 *   • actual build prompts in plan/code mode → extraction still works and the
 *     file-creation guide appears.
 */

import { runInBackground, setFileSystemAccess } from "../background-worker";
import { getCurrentTask, abortCurrentTask } from "../background-chat";
import { waitFor } from "./helpers";

const textChunk = (text: string) => `data: ${JSON.stringify({ content: text })}\n\n`;
const doneChunk = () => "data: [DONE]\n\n";

function streamOnce(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** A rating-style answer: prose findings plus two fences quoting real code. */
const RATING_ANSWER = [
  "## Project rating: 7.5 / 10",
  "",
  "Your auth module is solid, but there are two weak points:",
  "",
  "```ts",
  "export async function login(email: string, pass: string) {",
  "  const user = await db.user.findFirst({ where: { email } });",
  "  if (!user) return reject('nope');",
  "  return accept(user);",
  "}",
  "```",
  "",
  "The session store never expires:",
  "",
  "```ts",
  "export const sessions = new Map<string, Session>();",
  "",
  "export function accept(user: User) { sessions.set(user.id, newSession(user)); }",
  "```",
  "",
  "Fix these two and the rating goes to 8.5.",
].join("\n");

describe("code block extraction — intent gate", () => {
  const originalFetch = global.fetch;
  const written: string[] = [];

  beforeEach(() => {
    written.length = 0;
    vexStubFetch();
  });

  function vexStubFetch() {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        return Promise.resolve(streamOnce([textChunk(RATING_ANSWER), doneChunk()]));
      }
      // exec / verify / everything else: generic success
      return Promise.resolve(
        new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), { status: 200 })
      );
    }) as typeof fetch;
    setFileSystemAccess(
      async () => "[Error: not found]",
      async (path, content) => {
        written.push(`${path}:${content.length}`);
        return true;
      },
      async () => false,
      [],
      {},
      "open-user-repo"
    );
  }

  afterEach(() => {
    global.fetch = originalFetch;
    try {
      if (getCurrentTask()) abortCurrentTask();
    } catch {}
  });

  it("an analysis prompt keeps its quoted code — nothing extracted, nothing written", async () => {
    const promise = runInBackground("rate my project", null, [], "code", [], undefined, undefined, {
      autoVerify: false,
    });
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const display = getCurrentTask()?.displayContent || "";
    // The answer survived verbatim — fenced code stays in the answer.
    expect(display).toContain("## Project rating: 7.5 / 10");
    expect(display).toContain("export async function login");
    expect(display).toContain("new Map<string, Session>()");
    // No extraction notice, no generated files in the user's open repo.
    expect(display).not.toContain("file(s) extracted");
    expect(written).toEqual([]);
  });

  it("a build prompt still gets its fences extracted into files", async () => {
    const promise = runInBackground("build a pomodoro timer web app", null, [], "code", [], undefined, undefined, {
      autoVerify: false,
    });
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const display = getCurrentTask()?.displayContent || "";
    expect(display).toContain("file(s) extracted");
    expect(written.length).toBeGreaterThan(0);
  });
});
