/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react";
import { useFileProcessor } from "@/hooks/useFileProcessor";

const ZIP = "data:application/zip;base64,UEsDBAo=";

describe("useFileProcessor lanes", () => {
  it("routes an attached .zip into a lane that reaches the send path", () => {
    const { result } = renderHook(() => useFileProcessor());
    act(() => {
      result.current.setAttachedFiles([
        { name: "app.zip", content: "", size: 1234, type: "archive", dataUrl: ZIP },
      ]);
    });
    // A zip is neither text nor image, so it must ride the text lane or the
    // send path never sees it and the attachment is silently dropped.
    expect(result.current.getTextFiles()).toHaveLength(1);
    expect(result.current.getImageFiles()).toHaveLength(0);
    expect(result.current.hasFiles).toBe(true);
    expect(result.current.fileCount).toBe(1);
  });

  it("still splits plain text and images correctly", () => {
    const { result } = renderHook(() => useFileProcessor());
    act(() => {
      result.current.setAttachedFiles([
        { name: "a.ts", content: "const a = 1;", size: 11, type: "text" },
        { name: "b.png", content: "", size: 22, type: "image", dataUrl: "data:image/png;base64,AA==" },
      ]);
    });
    expect(result.current.getTextFiles().map((f) => f.name)).toEqual(["a.ts"]);
    expect(result.current.getImageFiles().map((f) => f.name)).toEqual(["b.png"]);
  });

  it("does not treat an empty text file as a sendable file", () => {
    const { result } = renderHook(() => useFileProcessor());
    act(() => {
      result.current.setAttachedFiles([{ name: "empty.ts", content: "", size: 0, type: "text" }]);
    });
    expect(result.current.getTextFiles()).toHaveLength(0);
  });
});
