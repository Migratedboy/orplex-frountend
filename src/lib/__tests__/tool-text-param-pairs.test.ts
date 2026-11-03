// tool-text-param-pairs.test.ts — native-template param_key/param_value
// tool calls: parsed instead of silently dropped, and never shown raw.
//
// Live-observed failure this guards: a model streamed
//   read<param_key>filePath</param_key><param_value>/workspace/terminal.js</param_value>
// three times in one turn. The JSON-only parser dropped every call, the run
// ended "Stopped", and the raw markup became the visible chat message while
// the prose claimed work had happened.
import { parseToolCalls, parseParamPairToolCalls, stripParamPairMarkup } from "../tool-text";
import { stripToolCallText, parseTurnCalls } from "../agent/loop-engine";

const TC_OPEN = "<" + "tool_call" + ">";
const TC_CLOSE = "<" + "/" + "tool_call" + ">";

describe("parseParamPairToolCalls", () => {
  it("parses a bare name+pairs run (the observed shape)", () => {
    const text = "read<param_key>filePath</param_key><param_value>/workspace/terminal.js</param_value>";
    const calls = parseParamPairToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read");
    expect(calls[0].filePath).toBe("/workspace/terminal.js");
  });

  it("parses multiple runs split by their name tokens", () => {
    const text =
      "read<param_key>filePath</param_key><param_value>a.js</param_value>" +
      "list<param_key>path</param_key><param_value>src</param_value>";
    const calls = parseParamPairToolCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["read", "list"]);
    expect(calls[0].filePath).toBe("a.js");
    expect(calls[1].path).toBe("src");
  });

  it("parses the name from a name tag", () => {
    const text = "<name>read_file</name><param_key>path</param_key><param_value>src/a.ts</param_value>";
    const calls = parseParamPairToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
    expect(calls[0].path).toBe("src/a.ts");
  });

  it("keeps multi-line values (file content)", () => {
    const text =
      "write_file<param_key>path</param_key><param_value>x.txt</param_value>" +
      "<param_key>content</param_key><param_value>line1\nline2</param_value>";
    const calls = parseParamPairToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].content).toBe("line1\nline2");
  });

  it("skips runs with no resolvable name instead of guessing", () => {
    expect(parseParamPairToolCalls("<param_key>path</param_key><param_value>x</param_value>")).toEqual([]);
  });
});

describe("parseToolCalls — param-pair bodies and bare runs", () => {
  it("parses a param-pair body inside the XML wrapper", () => {
    const body = "read<param_key>filePath</param_key><param_value>/workspace/terminal.js</param_value>";
    const calls = parseToolCalls(TC_OPEN + body + TC_CLOSE);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read");
    expect(calls[0].filePath).toBe("/workspace/terminal.js");
  });

  it("parses bare unwrapped runs in prose", () => {
    const text =
      "Reading the terminal files now.\n" +
      "read<param_key>filePath</param_key><param_value>/workspace/terminal.js</param_value>\n" +
      "read<param_key>filePath</param_key><param_value>/workspace/terminal.bat</param_value>";
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.name === "read")).toBe(true);
  });

  it("still parses JSON bodies (regression)", () => {
    const calls = parseToolCalls(TC_OPEN + '{"name":"read_file","path":"README.md"}' + TC_CLOSE);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
  });

  it("never double-parses pairs that live inside a wrapper", () => {
    const body = "read<param_key>filePath</param_key><param_value>a.js</param_value>";
    const calls = parseToolCalls("prose " + TC_OPEN + body + TC_CLOSE);
    expect(calls).toHaveLength(1);
  });
});

describe("stripToolCallText / stripParamPairMarkup — display never shows raw markup", () => {
  it("removes bare param-pair runs and keeps the prose", () => {
    const text =
      "I will check those files.\n" +
      "read<param_key>filePath</param_key><param_value>/workspace/terminal.js</param_value>";
    const out = stripToolCallText(text);
    expect(out).toBe("I will check those files.");
    expect(out).not.toContain("<param_key>");
  });

  it("removes an unclosed wrapper tail (subagent parity)", () => {
    const text = "Almost done\n" + TC_OPEN + '{"name":"read_file","p';
    const out = stripToolCallText(text);
    expect(out).toBe("Almost done");
  });

  it("removes closed wrapper blocks (unchanged behavior)", () => {
    const text = "prose here" + TC_OPEN + '{"name":"read_file","path":"a"}' + TC_CLOSE + " trailing";
    expect(stripToolCallText(text)).toBe("prose here trailing");
  });

  it("leaves plain prose untouched", () => {
    expect(stripToolCallText("just an answer")).toBe("just an answer");
  });

  it("stripParamPairMarkup cuts the name token with the pairs", () => {
    const text = "go read<param_key>filePath</param_key><param_value>x</param_value> done";
    expect(stripParamPairMarkup(text)).toBe("go  done");
  });
});

describe("parseTurnCalls — create_file truncation", () => {
  const opts = {
    parseXmlToolCalls: (t: string) =>
      parseToolCalls(t) as unknown as Array<Record<string, unknown> & { name: string }>,
  };

  it("flags a create_file call whose content was cut off", () => {
    const out = {
      content: "",
      toolCalls: [
        { name: "create_file", filename: "notes.md" },
      ] as Array<Record<string, unknown> & { name: string }>,
    };
    const parsed = parseTurnCalls(out, opts);
    expect(parsed.calls).toHaveLength(0);
    expect(parsed.truncated).toHaveLength(1);
    expect(parsed.truncated[0].name).toBe("create_file");
  });

  it("dispatches a complete create_file call", () => {
    const out = {
      content: "",
      toolCalls: [
        { name: "create_file", filename: "notes.md", content: "# hi" },
      ] as Array<Record<string, unknown> & { name: string }>,
    };
    const parsed = parseTurnCalls(out, opts);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.truncated).toHaveLength(0);
  });
});
