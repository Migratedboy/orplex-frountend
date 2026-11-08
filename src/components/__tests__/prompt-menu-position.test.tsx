import { positionPromptMenu } from "@/lib/prompt-menu-position";

function setRect(element: HTMLElement, rect: DOMRect) {
  jest.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
}

describe("prompt menu viewport positioning", () => {
  let anchor: HTMLButtonElement;
  let menu: HTMLDivElement;

  beforeEach(() => {
    anchor = document.createElement("button");
    menu = document.createElement("div");
    document.body.append(anchor, menu);
    Object.defineProperty(menu, "scrollHeight", { configurable: true, value: 160 });
    setRect(anchor, {
      x: 100, y: 300, top: 300, right: 140, bottom: 340, left: 100,
      width: 40, height: 40, toJSON: () => ({}),
    } as DOMRect);
    setRect(menu, {
      x: 0, y: 0, top: 0, right: 290, bottom: 160, left: 0,
      width: 290, height: 160, toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1024 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 768 });
  });

  afterEach(() => {
    anchor.remove();
    menu.remove();
    jest.restoreAllMocks();
  });

  it("opens upward when the complete menu fits and keeps the viewport gutter", () => {
    positionPromptMenu(anchor, menu);

    expect(menu.dataset.placement).toBe("above");
    expect(menu.style.top).toBe("132px");
    expect(menu.style.left).toBe("100px");
    expect(menu.style.maxHeight).toBe("284px");
    expect(menu.style.overflowY).toBe("auto");
  });

  it("opens toward the larger space and caps tall menus to that space", () => {
    setRect(anchor, {
      x: 100, y: 80, top: 80, right: 140, bottom: 120, left: 100,
      width: 40, height: 40, toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(menu, "scrollHeight", { configurable: true, value: 900 });

    positionPromptMenu(anchor, menu);

    expect(menu.dataset.placement).toBe("below");
    expect(menu.style.top).toBe("128px");
    expect(menu.style.maxHeight).toBe("632px");
    expect(menu.dataset.positioned).toBe("true");
  });

  it("keeps the opening direction and scroll offset stable while the list grows", () => {
    positionPromptMenu(anchor, menu);
    menu.scrollTop = 42;
    Object.defineProperty(menu, "scrollHeight", { configurable: true, value: 900 });

    positionPromptMenu(anchor, menu, "start", true);

    expect(menu.dataset.placement).toBe("above");
    expect(menu.style.top).toBe("8px");
    expect(menu.scrollTop).toBe(42);
  });

  it("aligns end-positioned menus without allowing them past the right edge", () => {
    setRect(anchor, {
      x: 950, y: 300, top: 300, right: 990, bottom: 340, left: 950,
      width: 40, height: 40, toJSON: () => ({}),
    } as DOMRect);

    positionPromptMenu(anchor, menu, "end");

    expect(menu.style.left).toBe("700px");
  });
});
