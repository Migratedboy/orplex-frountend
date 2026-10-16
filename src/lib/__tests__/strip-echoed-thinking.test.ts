/**
 * Echo-stripping guards.
 *
 * `stripEchoedThinking` removes a provider's echo of its own reasoning from
 * the front of the answer. The dangerous case is when the "echo" is the WHOLE
 * content: the server safety-net (ai-providers.ts) re-emits the entire
 * thinking buffer as `{ content: thinkingText }` when a stream ends with
 * reasoning and no content. Treating that as an echo produced "" -> readStream
 * returned content: null -> the worker stamped the user's complete answer as
 * "No response from the model. Try again." + [FAILED].
 */
import { stripEchoedThinking } from "../stream-reader";

const REASONING =
  "The user asked me to analyse the repository. I will look at the files and then explain the architecture clearly.";

describe("stripEchoedThinking", () => {
  it("keeps the answer when content and thinking are identical", () => {
    expect(stripEchoedThinking(REASONING, REASONING)).toBe(REASONING);
  });

  it("keeps the answer when the echo is the whole content modulo punctuation", () => {
    const padded = `${REASONING}...`;
    expect(stripEchoedThinking(padded, REASONING)).toBe(padded);
  });

  it("strips a genuine echo and keeps the trailing answer", () => {
    expect(stripEchoedThinking(`${REASONING} The answer is 42.`, REASONING)).toBe("The answer is 42.");
  });

  it("strips an echo followed by whitespace then the answer", () => {
    expect(stripEchoedThinking(`${REASONING}   The answer is 42.`, REASONING)).toBe("The answer is 42.");
  });

  it("leaves unrelated content alone", () => {
    const answer = "Here is a completely different answer about cats and dogs.";
    expect(stripEchoedThinking(answer, REASONING)).toBe(answer);
  });

  it("leaves short content alone (below the echo floor)", () => {
    expect(stripEchoedThinking("Done.", "Done.")).toBe("Done.");
  });

  it("is a no-op when either side is empty", () => {
    expect(stripEchoedThinking("", REASONING)).toBe("");
    expect(stripEchoedThinking("answer", "")).toBe("answer");
  });
});
