import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: { DEFAULT: "#f9f9fa", dark: "#1a1c1d" },
        "on-background": { DEFAULT: "#1a1c1d", dark: "#e5e2e1" },
        surface: { DEFAULT: "#f9f9fa", dark: "#1a1c1d" },
        "surface-pure": { DEFAULT: "#FFFFFF", dark: "#1a1c1d" },
        "surface-subtle": { DEFAULT: "#F9FAFB", dark: "#232323" },
        "surface-container-low": { DEFAULT: "#f3f3f4", dark: "#2a2a2a" },
        "surface-container": { DEFAULT: "#eeeeef", dark: "#333333" },
        "surface-container-high": { DEFAULT: "#e8e8e9", dark: "#3a3a3a" },
        "surface-container-highest": { DEFAULT: "#e2e2e3", dark: "#444444" },
        "surface-variant": { DEFAULT: "#e2e2e3", dark: "#404040" },
        "on-surface": { DEFAULT: "#1a1c1d", dark: "#e5e2e1" },
        "on-surface-variant": { DEFAULT: "#5a4136", dark: "#c8b8a8" },
        primary: { DEFAULT: "#a04100", dark: "#ffb693" },
        "primary-container": { DEFAULT: "#ff6b00", dark: "#ff6b00" },
        "on-primary": { DEFAULT: "#ffffff", dark: "#1a1c1d" },
        secondary: { DEFAULT: "#5f5e5e", dark: "#a0a0a0" },
        "on-secondary": { DEFAULT: "#ffffff", dark: "#1a1c1d" },
        tertiary: { DEFAULT: "#944b00", dark: "#ffb783" },
        "tertiary-container": { DEFAULT: "#dd8339", dark: "#dd8339" },
        error: { DEFAULT: "#ba1a1a", dark: "#ffb4ab" },
        "on-error": { DEFAULT: "#ffffff", dark: "#690005" },
        "error-container": { DEFAULT: "#ffdad6", dark: "#93000a" },
        outline: { DEFAULT: "#8e7164", dark: "#a08e7a" },
        "border-light": { DEFAULT: "#E4E4E7", dark: "#404040" },
        "accent-warm": { DEFAULT: "#FFF7ED", dark: "#2a1f14" },
        "on-primary-container": { DEFAULT: "#572000", dark: "#ffdbcc" },
        "primary-fixed-dim": { DEFAULT: "#ffb693", dark: "#ffb693" },
      },
      borderRadius: { DEFAULT: "0.125rem", lg: "0.25rem", xl: "0.5rem", full: "0.75rem" },
      spacing: { unit: "4px", gutter: "24px", "margin-sm": "16px", "margin-md": "32px", "margin-lg": "64px", "container-max": "1280px" },
      fontFamily: {
        display: ["Fraunces", "Lexend", "serif"], body: ["Fraunces", "Lexend", "serif"], headline: ["Fraunces", "Lexend", "serif"],
        code: ["JetBrains Mono", "monospace"], label: ["JetBrains Mono", "monospace"],
      },
      fontSize: {
        "display-lg": ["64px", { lineHeight: "1.1", letterSpacing: "-0.03em", fontWeight: "700" }],
        "headline-lg": ["32px", { lineHeight: "1.2", fontWeight: "600" }],
        "body-md": ["16px", { lineHeight: "1.6", fontWeight: "400" }],
        "code-md": ["14px", { lineHeight: "1.5", fontWeight: "450" }],
        "label-sm": ["11px", { lineHeight: "1.2", letterSpacing: "0.05em", fontWeight: "500" }],
        "label-caps": ["10px", { lineHeight: "1", letterSpacing: "0.15em", fontWeight: "700" }],
      },
      keyframes: {
        "slide-in": { "0%": { transform: "translateX(100%)", opacity: "0" }, "100%": { transform: "translateX(0)", opacity: "1" } },
      },
      animation: { "slide-in": "slide-in 0.3s ease-out" },
    },
  },
  plugins: [],
};
export default config;
