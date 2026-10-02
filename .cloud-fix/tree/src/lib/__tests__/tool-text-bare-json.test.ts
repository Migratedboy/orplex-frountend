// tool-text-bare-json.test.ts — Bare-JSON tool-call recovery: weak
// OpenAI-compatible models sometimes emit a tool-call JSON object without the
// requested <tool_call> XML wrapper (live-observed in a server-run smoke test:
// `{"name":"read_file","path":"README.md"}` became the run "summary" and the
// loop ended after one turn). parseBareJsonToolCalls must recover those calls
// while never misfiring on prose that merely contains JSON.
import { parseToolCalls, parseBareJsonToolCalls } from "../tool-text";

describe("parseBareJsonToolCalls", () => {
  it("recovers a raw bare tool-call object", () => {
    const text = '{"name":"read_file","path":"README.md"}';
    const calls = parseBareJsonToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
    expect(calls[0].path).toBe("README.md");
  });

  it("recovers a json-fenced tool call", () => {
    const text = 'Here is the call:\n```json\n{"name":"list_files","path":"src"}\n```\n';
    const calls = parseBareJsonToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("list_files");
  });

  it("recovers an array of tool calls", () => {
    const text = '[{"name":"read_file","path":"a.ts"},{"name":"list_files","path":"."}]';
    const calls = parseBareJsonToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.name)).toEqual(["read_file", "list_files"]);
  });

  it("allows one short lead-in line around the call", () => {
    const text = 'Reading the file first.\n{"name":"read_file","path":"README.md"}';
    expect(parseBareJsonToolCalls(text)).toHaveLength(1);
  });

  it("never fires on prose that merely contains JSON (long answer)", () => {
    const text = [
      "Here is the summary of the work I completed:",
      "",
      "I read the config and updated the schema. The run finished with these results:",
      "",
      '{"name":"read_file","path":"README.md"}',
      "",
      "Let me know if you would like anything else adjusted.",
    ].join("\n");
    expect(parseBareJsonToolCalls(text)).toHaveLength(0);
  });

  it("never fires on JSON without a name field", () => {
    expect(parseBareJsonToolCalls('{"path":"README.md"}')).toHaveLength(0);
    expect(parseBareJsonToolCalls('{"role":"assistant","content":"hi"}')).toHaveLength(0);
  });

  it("never fires on non-tool-shaped names or nested args", () => {
    expect(parseBareJsonToolCalls('{"name":"Not A Tool","path":"x"}')).toHaveLength(0);
    expect(parseBareJsonToolCalls('{"name":"read_file","opts":{"deep":true}}')).toHaveLength(0);
  });

  it("never fires on malformed JSON", () => {
    expect(parseBareJsonToolCalls('{"name":"read_file","path":')).toHaveLength(0);
  });

  it("returns [] for XML-wrapped input (XML parser owns that path)", () => {
    const text = '<tool_call>{"name":"read_file","path":"README.md"}</tool_call>';
    expect(parseToolCalls(text)).toHaveLength(1);
    // The wrapper hides the JSON from the bare parser by design — callers
    // only consult it when XML parsing found nothing.
    expect(parseBareJsonToolCalls(text)).toHaveLength(0);
  });
});
