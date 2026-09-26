const lightCodeTheme = require("prism-react-renderer").themes.github;
const darkCodeTheme = require("prism-react-renderer").themes.dracula;

module.exports = {
  title: "Orplex Tech",
  tagline: "AI coding assistant with streaming chat, multi-provider support, and agentic tool calling",
  url: "https://docs.orplex.dev",
  baseUrl: "/",
  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",
  favicon: "img/favicon.png",
  organizationName: "orplex-tech",
  projectName: "orplex-tech",
  themeConfig: {
    navbar: {
      logo: { alt: "Orplex Tech Logo", src: "img/logo.png" },
      title: "Orplex Tech",
      items: [
        { type: "doc", docId: "getting-started/install", position: "left", label: "Get Started" },
        { to: "/guides", label: "Guides", position: "left" },
        { to: "/api", label: "API Reference", position: "left" },
        { href: "https://github.com/orplex-tech/orplex-tech", label: "GitHub", position: "right" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        { title: "Docs", items: [
          { label: "Get Started", to: "/docs/getting-started/install" },
          { label: "Architecture", to: "/docs/guides/architecture" },
          { label: "Self-Hosting", to: "/docs/guides/self-hosting" },
        ]},
        { title: "Community", items: [
          { label: "GitHub", href: "https://github.com/orplex-tech/orplex-tech" },
          { label: "Discord", href: "https://discord.gg/orplex" },
        ]},
        { title: "More", items: [
          { label: "VS Code Extension", href: "https://marketplace.visualstudio.com/items?itemName=orplex-tech.orplex-tech" },
          { label: "npm Package", href: "https://www.npmjs.com/package/orplex-cli" },
        ]},
      ],
      copyright: `Copyright ${new Date().getFullYear()} Orplex Tech.`,
    },
    prism: { theme: lightCodeTheme, darkTheme: darkCodeTheme },
  },
  presets: [
    ["classic", {
      docs: { sidebarPath: "./sidebars.js" },
      blog: false,
      theme: { customCss: ["./src/css/custom.css", "./src/css/fonts.css"] },
    }],
  ],
};
