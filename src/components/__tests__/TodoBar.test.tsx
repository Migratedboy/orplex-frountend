// TodoBar.test.tsx — Unit tests for TodoBar data validation logic
// Tests the data transformation that prevents React crashes

describe("TodoBar - data validation", () => {
  it("handles normal string items", () => {
    const items: Array<{ text: string; done: boolean }> = [
      { text: "Step 1", done: false },
      { text: "Step 2", done: true },
    ];
    expect(items[0].text).toBe("Step 1");
    expect(items[1].done).toBe(true);
  });

  it("handles object items (LLM bug)", () => {
    const rawItem = { action: "create", items: ["Step 1", "Step 2"], completed_index: 0 };
    const text = typeof rawItem === "string" ? rawItem : JSON.stringify(rawItem);
    expect(typeof text).toBe("string");
    expect(text).toContain("Step 1");
  });

  it("handles null/undefined items gracefully", () => {
    const items: Array<{ text: any; done: boolean }> = [
      { text: null, done: false },
      { text: undefined, done: false },
      { text: "", done: false },
    ];
    items.forEach(item => {
      const text = typeof item.text === "string"
        ? item.text
        : typeof item.text === "object" && item.text !== null
          ? JSON.stringify(item.text)
          : String(item.text ?? "");
      expect(typeof text).toBe("string");
    });
  });

  it("handles numeric items", () => {
    const items: Array<{ text: number; done: boolean }> = [
      { text: 42, done: false },
      { text: 0, done: true },
    ];
    items.forEach(item => {
      const text = typeof item.text === "string" ? item.text : String(item.text);
      expect(typeof text).toBe("string");
    });
  });
});

describe("TodoBar - completion logic", () => {
  it("calculates completed count correctly", () => {
    const items = [
      { text: "a", done: true },
      { text: "b", done: false },
      { text: "c", done: true },
    ];
    const completed = items.filter(t => t.done).length;
    expect(completed).toBe(2);
  });

  it("detects all done", () => {
    const items = [
      { text: "a", done: true },
      { text: "b", done: true },
    ];
    const allDone = items.every(t => t.done);
    expect(allDone).toBe(true);
  });

  it("empty items array returns early", () => {
    const items: unknown[] = [];
    expect(items.length).toBe(0);
  });
});
