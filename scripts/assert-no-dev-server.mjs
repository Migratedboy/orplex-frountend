// assert-no-dev-server.mjs — refuse to run `next build` under a live dev server.
//
// `next build` and `next dev` share `.next/`. Running a packaged build while the
// dev app is open (which is what `npm run electron:dist` does) rewrites the dev
// server's chunks underneath it: the rendering window then reloads into
// "Failed to load external module ... pages-turbo.runtime.dev.js", the session
// fetch fails, and the app sits on the splash screen flashing between themes
// while every asset 404s. That is a developer-machine footgun, not a product
// bug, so it fails loudly here instead of producing a broken build and a broken
// running app.
import net from "node:net";

const PORTS = [5000, 3000]; // dev app port, then plain `next dev`
const HOST = "127.0.0.1";

function isOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const live = [];
for (const port of PORTS) {
  if (await isOpen(port)) live.push(port);
}

if (live.length) {
  console.error(
    [
      "",
      `  A dev server is running on port ${live.join(", ")}.`,
      "",
      "  `next build` writes into the same .next/ directory the dev server is",
      "  serving from, which breaks the app that is currently open (blank",
      "  chunks, failed session fetch, splash screen that never clears).",
      "",
      "  Quit the dev app first (`Get-Process orplex-dev* | Stop-Process -Force`),",
      "  then run the build again.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("no dev server on :5000/:3000 — safe to build");
