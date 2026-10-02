"use client";

import { useState } from "react";

interface HeaderProps {
  onBugReport: () => void;
}

export default function Header({ onBugReport }: HeaderProps) {
  return (
    <header className="fixed top-0 w-full z-50 backdrop-blur-md bg-surface-glass border-b border-border-glass shadow-sm flex justify-between items-center px-4 h-16">
      {/* Logo */}
      <div className="flex items-center gap-2 cursor-pointer active:scale-95">
        <svg className="w-6 h-6 text-primary-container" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8 12H9v-2h3v2zm5-4H9V9h8v2z" />
        </svg>
        <span className="font-display text-lg font-bold text-primary-container">Orplex Code</span>
      </div>

      {/* Status + Nav */}
      <div className="flex items-center gap-4">
        {/* System Status */}
        <div className="flex items-center gap-2 px-3 py-1 rounded-full border border-primary-container bg-primary-container/10">
          <div className="w-2 h-2 rounded-full bg-primary-container animate-pulse-amber" />
          <span className="font-label text-[10px] text-primary-container uppercase tracking-wider">System: Healthy</span>
        </div>

        {/* Nav Links */}
        <nav className="hidden md:flex gap-6 font-label text-[11px]">
          <a className="text-primary-container font-bold flex items-center gap-1 hover:text-primary transition-colors" href="#">
            <span className="ms">code</span>
            IDE/Dashboard
          </a>
          <a className="text-on-surface-variant flex items-center gap-1 hover:text-primary-container transition-colors" href="#">
            <span className="ms">account_tree</span>
            Workflows
          </a>
          <a className="text-on-surface-variant flex items-center gap-1 hover:text-primary-container transition-colors" href="#">
            <span className="ms">rocket_launch</span>
            Deploy
          </a>
        </nav>

        {/* Bug Report Button */}
        <button
          onClick={onBugReport}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-error-container bg-error-container/10 text-error hover:bg-error-container/20 hover:border-error transition-colors transition-transform font-label text-[10px] uppercase tracking-wider active:scale-95"
          title="Report a Bug"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 2l1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
            <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z" />
            <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M6 17l-4 1M17.47 9c1.93-.2 3.53-1.9 3.53-4M18 13h4M18 17l4 1" />
          </svg>
          Bug Report
        </button>
      </div>
    </header>
  );
}
