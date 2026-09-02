"use client";

import { useState, useCallback, useRef, ReactNode } from "react";
import { processFileList } from "@/lib/file-adapter";

interface DragDropZoneProps {
  onFilesDropped: (files: { name: string; content: string; size: number; type: string; dataUrl?: string }[]) => void;
  children: ReactNode;
}

export default function DragDropZone({ onFilesDropped, children }: DragDropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      const files = await processFileList(e.dataTransfer.files);
      if (files.length > 0) onFilesDropped(files);
    }
  }, [onFilesDropped]);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      className="drag-drop-zone"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {dragging && (
        <div className="drag-drop-overlay">
          <div className="drag-drop-content">
            <div className="drag-drop-icon">&#x1F4C1;</div>
            <div className="drag-drop-title">Drop files here</div>
            <div className="drag-drop-subtitle">Code files, images, and text files supported</div>
          </div>
        </div>
      )}
    </div>
  );
}
