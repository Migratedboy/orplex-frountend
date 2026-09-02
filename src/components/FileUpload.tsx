"use client";

import { useRef, useEffect } from "react";
import { processFileList, readFileAsDataUrl, TEXT_EXTENSIONS, IMAGE_EXTENSIONS, MAX_IMAGE_SIZE } from "@/lib/file-adapter";
import { IconPaperclip, IconImage } from "./Icons";

interface FileUploadProps {
  onFilesSelected: (files: { name: string; content: string; size: number; type: string; dataUrl?: string }[]) => void;
}

/** Detect language from pasted code content */
function detectLanguage(text: string): string {
  if (text.includes("import React") || text.includes("from \"react\"") || /\btsx?\b/.test(text)) return "ts";
  if (text.includes("def ") || text.includes("import ") && text.includes(":")) return "py";
  if (text.includes("func ") || text.includes("package ")) return "go";
  if (text.includes("fn ") || text.includes("impl ")) return "rs";
  if (text.includes("class ") && text.includes("public static")) return "java";
  if (text.includes("<html") || text.includes("<!DOCTYPE")) return "html";
  if (text.includes("SELECT ") || text.includes("CREATE TABLE")) return "sql";
  if (text.includes("{") && text.includes("\"")) return "json";
  if (text.includes("#include") || text.includes("printf")) return "c";
  if (text.includes("console.log") || text.includes("const ") || text.includes("function ") || text.includes("=> ")) return "js";
  if (text.includes("#!/bin/bash") || text.includes("echo ") || text.includes("grep ")) return "sh";
  return "txt";
}

export default function FileUpload({ onFilesSelected }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      // First check for images
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file || file.size > MAX_IMAGE_SIZE) continue;
          try {
            const dataUrl = await readFileAsDataUrl(file);
            const ext = file.type.split("/")[1] || "png";
            onFilesSelected([{
              name: `pasted-image.${ext}`,
              content: "",
              size: file.size,
              type: "image",
              dataUrl,
            }]);
          } catch {}
          return;
        }
      }

      // Then check for text paste — convert long text / code to attachment chips
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;

      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const looksLikeCode = /[{}();]/.test(text) || text.includes("\n  ") || text.includes("import ") || text.includes("function ");
      const isLong = wordCount > 150;

      if (isLong || looksLikeCode) {
        e.preventDefault();
        const ext = looksLikeCode ? detectLanguage(text) : "txt";
        onFilesSelected([{
          name: `pasted-text.${ext}`,
          content: text,
          size: new Blob([text]).size,
          type: "text",
        }]);
      }
      // Short plain text — let it paste into the textarea normally
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [onFilesSelected]);

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = await processFileList(fileList);
    if (files.length > 0) onFilesSelected(files);
    if (inputRef.current) inputRef.current.value = "";
    if (imageInputRef.current) imageInputRef.current.value = "";
  };

  return (
    <>
      <input ref={inputRef} type="file" multiple accept={TEXT_EXTENSIONS.join(",")} style={{ display: "none" }} onChange={handleFileInput} />
      <input ref={imageInputRef} type="file" multiple accept={IMAGE_EXTENSIONS.join(",")} style={{ display: "none" }} onChange={handleFileInput} />
      <button onClick={() => inputRef.current?.click()} className="chat-attach-btn" title="Attach file" aria-label="Attach file">
        <IconPaperclip size={16} />
      </button>
      <button onClick={() => imageInputRef.current?.click()} className="chat-attach-btn" title="Attach image (or Ctrl+V to paste)" aria-label="Attach image">
        <IconImage size={16} />
      </button>
    </>
  );
}
