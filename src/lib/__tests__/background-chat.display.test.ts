import {
  cancelTask,
  flushDisplayContent,
  startTask,
  subscribeBackgroundChat,
} from "../background-chat";

describe("background chat display flushing", () => {
  afterEach(() => {
    cancelTask();
  });

  it("notifies subscribers immediately for a discrete tool-status update", () => {
    startTask(null, "run a tool", [], "code");
    const updates: Array<string | null> = [];
    const unsubscribe = subscribeBackgroundChat((task) => {
      updates.push(task?.displayContent ?? null);
    });

    flushDisplayContent("running [read_file]\n");

    expect(updates.at(-1)).toBe("running [read_file]\n");
    expect(updates).toHaveLength(2);
    unsubscribe();
  });
});
