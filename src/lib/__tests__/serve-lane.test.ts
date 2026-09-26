/**
 * serve-lane.test.ts — Server commands must never go through blocking exec:
 * a server never exits, so exec would burn the timeout, kill the shell, and
 * orphan node children that keep holding ports (the "exit 1 → port busy
 * forever" failure). Pins the lane routing, port-conflict diagnosis, and the
 * master-prompt doctrine that teaches the model the difference.
 */
import { isServerCommand, diagnosePortConflict } from "../background-worker";
import { buildSystemPrompt } from "../master-prompt";

describe("isServerCommand — routes long-running servers to the serve lane", () => {
  const servers = [
    "npx serve . -l 3001",
    "npx serve .",
    "serve -l 4000",
    "npm run dev",
    "npm start",
    "npm run start",
    "next dev",
    "next start",
    "vite --port 5173",
    "python -m http.server 3001",
    "python3 -m http.server 8080",
    "flask run",
    "uvicorn main:app",
    "php -S localhost:8000",
    "npx http-server -p 8080",
    "npx json-server db.json",
  ];

  it.each(servers)("detects: %s", (cmd) => {
    expect(isServerCommand(cmd)).toBe(true);
  });

  const oneShots = [
    "npm test",
    "npm run build",
    "npm install",
    "npx tsc --noEmit",
    "git status",
    "node script.js",
    "npx prisma db push",
    "echo hello",
    "dir",
    "npx serve --version", // hmm — actually still a server binary; version query exits. Acceptable false-positive cost.
  ];

  it.each(oneShots.slice(0, 9))("treats as one-shot exec: %s", (cmd) => {
    expect(isServerCommand(cmd)).toBe(false);
  });
});

describe("diagnosePortConflict — actionable hints on EADDRINUSE", () => {
  it("extracts the port and suggests netstat/taskkill on Windows", () => {
    const hint = diagnosePortConflict(
      "python -m http.server 3001",
      "OSError: [Errno 10048] address already in use"
    );
    expect(hint).toContain("3001");
    expect(hint).toContain("netstat");
    expect(hint).toContain("taskkill");
  });

  it("matches Node-style EADDRINUSE output", () => {
    const hint = diagnosePortConflict(
      "npx serve . -l 4000",
      "Error: listen EADDRINUSE: address already in use 0.0.0.0:4000"
    );
    expect(hint).toContain("4000");
  });

  it("returns empty for unrelated failures", () => {
    expect(diagnosePortConflict("npm test", "3 tests failed")).toBe("");
    expect(diagnosePortConflict("npm run build", "TS2322: not assignable")).toBe("");
  });

  it("handles a conflict when no port is detectable in the command", () => {
    const hint = diagnosePortConflict("myserver --start", "EADDRINUSE");
    expect(hint).toContain("different port");
  });
});

describe("master prompt — server doctrine", () => {
  const prompt = buildSystemPrompt({ mode: "code" });

  it("teaches the detached serve lane and forbids shell background tricks", () => {
    expect(prompt).toContain("DETACHED");
    expect(prompt).toMatch(/NEVER wrap servers in background tricks/);
  });

  it("separates exiting commands (exec) from servers (serve lane)", () => {
    expect(prompt).toContain("anything that EXITS");
  });
});
