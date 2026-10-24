import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: { DEFAULT: "#f9f9fa", dark: "#181818" },
        "on-background": { DEFAULT: "#1a1c1d", dark: "#cccccc" },
        surface: { DEFAULT: "#f9f9fa", dark: "#181818" },
        "surface-pure": { DEFAULT: "#FFFFFF", dark: "#181818" },
        "surface-subtle": { DEFAULT: "#F9FAFB", dark: "#1f1f1f" },
        "surface-container-low": { DEFAULT: "#f3f3f4", dark: "#1f1f1f" },
        "surface-container": { DEFAULT: "#eeeeef", dark: "#262626" },
        "surface-container-high": { DEFAULT: "#e8e8e9", dark: "#2b2b2b" },
        "surface-container-highest": { DEFAULT: "#e2e2e3", dark: "#353535" },
        "surface-variant": { DEFAULT: "#e2e2e3", dark: "#2f2f2f" },
        "on-surface": { DEFAULT: "#1a1c1d", dark: "#cccccc" },
        "on-surface-variant": { DEFAULT: "#5a4136", dark: "#9d9d9d" },
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
        "border-light": { DEFAULT: "#E4E4E7", dark: "#2f2f2f" },
        "accent-warm": { DEFAULT: "#FFF7ED", dark: "#241a10" },
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
