import { getExt, isTextFile, isImageFile, formatFileSize, getFileIcon } from "../file-utils";

describe("getExt", () => {
  it("extracts file extension", () => {
    expect(getExt("file.ts")).toBe(".ts");
    expect(getExt("image.PNG")).toBe(".png");
    expect(getExt("noext")).toBe(".noext");
  });
});

describe("isTextFile", () => {
  it("identifies text files", () => {
    expect(isTextFile("app.ts")).toBe(true);
    expect(isTextFile("style.css")).toBe(true);
    expect(isTextFile("readme.md")).toBe(true);
    expect(isTextFile(".gitignore")).toBe(true);
  });

  it("rejects non-text files", () => {
    expect(isTextFile("image.png")).toBe(false);
    expect(isTextFile("video.mp4")).toBe(false);
  });
});

describe("isImageFile", () => {
  it("identifies image files", () => {
    expect(isImageFile("photo.jpg")).toBe(true);
    expect(isImageFile("icon.PNG")).toBe(true);
    expect(isImageFile("anim.gif")).toBe(true);
  });

  it("rejects non-image files", () => {
    expect(isImageFile("document.pdf")).toBe(false);
    expect(isImageFile("script.ts")).toBe(false);
  });
});

describe("formatFileSize", () => {
  it("formats bytes", () => {
    expect(formatFileSize(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatFileSize(2097152)).toBe("2.0 MB");
  });
});

describe("getFileIcon", () => {
  it("returns correct icons", () => {
    expect(getFileIcon("app.ts")).toBe("TS");
    expect(getFileIcon("style.css")).toBe("CSS");
    expect(getFileIcon("image.png")).toBe("IMG");
    expect(getFileIcon("unknown.xyz")).toBe("XYZ");
  });
});
