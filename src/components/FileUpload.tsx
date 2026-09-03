"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import {
  processFileList,
  readFileAsDataUrl,
  TEXT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MAX_IMAGE_SIZE,
} from "@/lib/file-adapter";
import {
  SKILL_CATEGORIES,
  type Skill,
  type SkillCategory,
} from "@/lib/skills";

interface FileUploadProps {
  onFilesSelected: (
    files: {
      name: string;
      content: string;
      size: number;
      type: string;
      dataUrl?: string;
    }[]
  ) => void;
  onSkillSelected?: (skill: Skill) => void;
}

/** Detect language from pasted code content */
function detectLanguage(text: string): string {
  if (
    text.includes("import React") ||
    text.includes('from "react"') ||
    /\btsx?\b/.test(text)
  )
    return "ts";
  if (text.includes("def ") || (text.includes("import ") && text.includes(":")))
    return "py";
  if (text.includes("func ") || text.includes("package ")) return "go";
  if (text.includes("fn ") || text.includes("impl ")) return "rs";
  if (text.includes("class ") && text.includes("public static")) return "java";
  if (text.includes("<html") || text.includes("<!DOCTYPE")) return "html";
  if (text.includes("SELECT ") || text.includes("CREATE TABLE")) return "sql";
  if (text.includes("{") && text.includes('"')) return "json";
  if (text.includes("#include") || text.includes("printf")) return "c";
  if (
    text.includes("console.log") ||
    text.includes("const ") ||
    text.includes("function ") ||
    text.includes("=> ")
  )
    return "js";
  if (
    text.includes("#!/bin/bash") ||
    text.includes("echo ") ||
    text.includes("grep ")
  )
    return "sh";
  return "txt";
}

export default function FileUpload({
  onFilesSelected,
  onSkillSelected,
}: FileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const [popupOpen, setPopupOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close popup on outside click
  useEffect(() => {
    if (!popupOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setPopupOpen(false);
        setActiveCategory(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [popupOpen]);

  // Close on Escape
  useEffect(() => {
    if (!popupOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPopupOpen(false);
        setActiveCategory(null);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [popupOpen]);

  // Cleanup hover timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  // Paste handler (unchanged from original)
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
            onFilesSelected([
              {
                name: `pasted-image.${ext}`,
                content: "",
                size: file.size,
                type: "image",
                dataUrl,
              },
            ]);
          } catch {}
          return;
        }
      }

      // Then check for text paste
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;

      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const looksLikeCode =
        /[{}();]/.test(text) ||
        text.includes("\n  ") ||
        text.includes("import ") ||
        text.includes("function ");
      const isLong = wordCount > 150;

      if (isLong || looksLikeCode) {
        e.preventDefault();
        const ext = looksLikeCode ? detectLanguage(text) : "txt";
        onFilesSelected([
          {
            name: `pasted-text.${ext}`,
            content: text,
            size: new Blob([text]).size,
            type: "text",
          },
        ]);
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [onFilesSelected]);

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = await processFileList(fileList);
    if (files.length > 0) onFilesSelected(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (imageInputRef.current) imageInputRef.current.value = "";
    setPopupOpen(false);
    setActiveCategory(null);
  };

  const handleSkillClick = useCallback(
    (skill: Skill) => {
      onSkillSelected?.(skill);
      setPopupOpen(false);
      setActiveCategory(null);
    },
    [onSkillSelected]
  );

  return (
    <div className="attach-menu-container" ref={popupRef}>
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={TEXT_EXTENSIONS.join(",")}
        style={{ display: "none" }}
        onChange={handleFileInput}
      />
      <input
        ref={imageInputRef}
        type="file"
        multiple
        accept={IMAGE_EXTENSIONS.join(",")}
        style={{ display: "none" }}
        onChange={handleFileInput}
      />

      {/* + Button */}
      <button
        className="attach-plus-btn"
        onClick={() => {
          setPopupOpen(!popupOpen);
          setActiveCategory(null);
        }}
        title="Attach files, images, or use skills"
        aria-label="Open attach menu"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M8 3v10M3 8h10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Popup Menu */}
      {popupOpen && (
        <div className="attach-popup">
          {/* Main items */}
          <div className="attach-popup-main">
            <button
              className="attach-popup-item"
              onClick={() => fileInputRef.current?.click()}
            >
              <span className="attach-popup-icon">📁</span>
              <span className="attach-popup-label">File</span>
              <span className="attach-popup-hint">Text, code, docs</span>
            </button>

            <button
              className="attach-popup-item"
              onClick={() => imageInputRef.current?.click()}
            >
              <span className="attach-popup-icon">🖼️</span>
              <span className="attach-popup-label">Image</span>
              <span className="attach-popup-hint">or Ctrl+V to paste</span>
            </button>

            <div className="attach-popup-divider" />

            <button
              className={`attach-popup-item ${activeCategory ? "active" : ""}`}
              onClick={() =>
                setActiveCategory(activeCategory ? null : "skills")
              }
              onMouseEnter={() => {
                if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
                setActiveCategory("skills");
              }}
              onMouseLeave={() => {
                // Delay closing so mouse can move to submenu
                hoverTimeoutRef.current = setTimeout(() => {
                  setActiveCategory(null);
                }, 150);
              }}
            >
              <span className="attach-popup-icon">⚡</span>
              <span className="attach-popup-label">Skills</span>
              <span className="attach-popup-arrow">›</span>
            </button>
          </div>

          {/* Skills Submenu */}
          {activeCategory === "skills" && (
            <div
              className="attach-skills-submenu"
              onMouseEnter={() => {
                if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
              }}
              onMouseLeave={() => {
                hoverTimeoutRef.current = setTimeout(() => {
                  setActiveCategory(null);
                }, 150);
              }}
            >
              <div className="attach-skills-header">⚡ Skills</div>
              <div className="attach-skills-list">
                {SKILL_CATEGORIES.map((cat) => (
                  <SkillCategorySection
                    key={cat.id}
                    category={cat}
                    onSkillClick={handleSkillClick}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// === Skill Category Section ===

function SkillCategorySection({
  category,
  onSkillClick,
}: {
  category: SkillCategory;
  onSkillClick: (skill: Skill) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="skill-category">
      <button
        className="skill-category-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="skill-category-icon">{category.icon}</span>
        <span className="skill-category-name">{category.name}</span>
        <span className={`skill-category-arrow ${expanded ? "open" : ""}`}>
          ›
        </span>
      </button>

      {expanded && (
        <div className="skill-category-items">
          {category.skills.map((skill) => (
            <button
              key={skill.id}
              className="skill-item"
              onClick={() => onSkillClick(skill)}
              title={skill.description}
            >
              <span className="skill-item-icon">{skill.icon}</span>
              <div className="skill-item-info">
                <span className="skill-item-name">{skill.name}</span>
                <span className="skill-item-desc">{skill.description}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
