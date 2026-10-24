"use client";

// SandboxArtifact — renders an [ARTIFACT] payload as a live, isolated widget.
//
// The AI's files (HTML/CSS/JS) are combined into a single document and run in
// an iframe with sandbox="allow-scripts" and NO allow-same-origin:
//   - the frame cannot read cookies, localStorage, or the parent DOM;
//   - its only channel to the app is postMessage({ __orplex: ... }).
// That makes model-authored code safe to run inline by construction — the
// sandbox IS the blast radius.
//
// Controls (from the marker's `controls` array) render in a panel under the
// frame; every change is postMessage'd in so state updates are live — no
// page refresh. Buttons dispatch an "action" instead of a value.
//
// Session-bound memory: widget state lives in the iframe. Restart re-mounts
// the frame (equals a refresh); a real page reload loses it too, matching
// Gemini's code-execution semantics.

import { useMemo, useRef, useState } from "react";
import type { ArtifactControl, ArtifactPayload } from "@/lib/message-content";
import { apiFetch } from "@/lib/api-base";

const FRAME_HEIGHT = 420;

interface ControlValueMessage {
  __orplex: "controls" | "action";
  id?: string;
  values?: Record<string, string | number | boolean>;
}

// Assemble one document: the AI's .html page, its sibling .css injected as
// <style> and sibling .js as <script>, then the bridge injected before
// </body> so the host panel can talk to the widget without any contract the
// model must remember beyond the documented window.orplex API.
function buildDoc(artifact: ArtifactPayload): string {
  // parseArtifactPayload guarantees exactly the file kinds used here; pick
  // the first .html entry as the page.
  const page = artifact.files.find((f) => /\.html?$/i.test(f.name))!;
  const css = artifact.files.filter((f) => f.name.toLowerCase().endsWith(".css"));
  const js = artifact.files.filter((f) => f.name.toLowerCase().endsWith(".js"));

  const styleTags = css.map((f) => `<style>\n${f.content}\n</style>`).join("\n");
  const scriptTags = js
    .map((f) => `<script>\n${f.content}\n<` + `/script>`)
    .join("\n");
  const bridge = `<script>
(function () {
  var listeners = [];
  window.orplex = {
    values: {},
    onUpdate: function (fn) { listeners.push(fn); try { fn(window.orplex.values); } catch (err) {} },
    setValues: function (values) {
      window.orplex.values = values || {};
      for (var i = 0; i < listeners.length; i++) { try { listeners[i](window.orplex.values); } catch (err) {} }
    },
    send: function (detail) {
      try { window.parent.postMessage({ __orplex: "widget-event", detail: detail }, "*"); } catch (err) {}
    },
  };
  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.__orplex === "controls") { window.orplex.setValues(d.values || {}); }
    if (d.__orplex === "action") { document.dispatchEvent(new CustomEvent("orplex:action", { detail: d.id })); }
  });
})();
<\/script>`;

  let doc = page.content;
  if (/<\/head>/i.test(doc)) doc = doc.replace(/<\/head>/i, `${styleTags}</head>`);
  else if (/<body[^>]*>/i.test(doc)) doc = doc.replace(/<body[^>]*>/i, (m) => `${m}<style>${styleTags}</style>`);
  else doc = `<style>${styleTags}</style>\n${doc}`;

  if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, `${scriptTags}${bridge}</body>`);
  else doc = `${doc}${scriptTags}${bridge}`;

  return doc;
}

function ControlRow({
  control,
  defaultValue,
  onChange,
}: {
  control: ArtifactControl;
  defaultValue: string | number | boolean;
  onChange: (id: string, value: string | number | boolean, kind: "value" | "action") => void;
}) {
  switch (control.type) {
    case "slider":
      return (
        <div className="sandbox-artifact-control">
          <label htmlFor={`ctl-${control.id}`}>{control.label || control.id}</label>
          <input
            id={`ctl-${control.id}`}
            type="range"
            min={control.min ?? 0}
            max={control.max ?? 100}
            step={control.step ?? 1}
            defaultValue={defaultValue as number}
            onChange={(e) => onChange(control.id, Number(e.target.value), "value")}
          />
        </div>
      );
    case "toggle":
      return (
        <div className="sandbox-artifact-control">
          <label htmlFor={`ctl-${control.id}`}>{control.label || control.id}</label>
          <input
            id={`ctl-${control.id}`}
            type="checkbox"
            defaultChecked={defaultValue === true}
            onChange={(e) => onChange(control.id, e.target.checked, "value")}
          />
        </div>
      );
    case "input":
      return (
        <div className="sandbox-artifact-control">
          <label htmlFor={`ctl-${control.id}`}>{control.label || control.id}</label>
          <input
            id={`ctl-${control.id}`}
            type="text"
            defaultValue={defaultValue as string}
            onChange={(e) => onChange(control.id, e.target.value, "value")}
          />
        </div>
      );
    case "select":
      return (
        <div className="sandbox-artifact-control">
          <label htmlFor={`ctl-${control.id}`}>{control.label || control.id}</label>
          <select
            id={`ctl-${control.id}`}
            defaultValue={defaultValue as string}
            onChange={(e) => onChange(control.id, e.target.value, "value")}
          >
            {(control.options || []).map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
      );
    case "button":
      return (
        <div className="sandbox-artifact-control sandbox-artifact-control-action">
          <button type="button" onClick={() => onChange(control.id, true, "action")}>
            {control.label || control.id}
          </button>
        </div>
      );
  }
}

/**
 * Initial control value for one control — the marker's declared default,
 * normalized to the value type each control kind edits.
 */
function controlDefault(c: ArtifactControl): string | number | boolean {
  switch (c.type) {
    case "slider":
      return typeof c.value === "number" ? c.value : Math.min((c.max ?? 100), Math.max((c.min ?? 0), 0));
    case "toggle":
      return c.value === true;
    case "select":
      return typeof c.value === "string" ? c.value : (c.options?.[0] ?? "");
    case "input":
      return typeof c.value === "string" ? c.value : "";
    case "button":
      return "";
  }
}

export default function SandboxArtifact({ artifact }: { artifact: ArtifactPayload }) {
  // Key increments on restart: remounting the iframe discards the widget's
  // whole JS state — the same effect a page refresh has, on demand.
  const [gen, setGen] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const controls = artifact.controls || [];

  const doc = useMemo(() => buildDoc(artifact), [artifact]);
  // Latest panel state — read fresh on every send so a control changed while
  // the frame was reloading is announced with its current value on onLoad.
  const valuesRef = useRef<Record<string, string | number | boolean>>(
    Object.fromEntries(controls.map((c) => [c.id, controlDefault(c)]))
  );
  // Bumped whenever the server-mode control values change: the served app
  // reads them from the query string (it has no bridge to talk to).
  const [valuesVersion, setValuesVersion] = useState(0);

  // ── server mode (live app inside a Vercel Sandbox VM) ─────────────────
  const [server, setServer] = useState<{ status: "idle" | "booting" | "live" | "error"; url?: string; message?: string }>({ status: "idle" });

  // ── one-shot code run (python/node script in the sandbox) ─────────────
  const [run, setRun] = useState<{ status: "idle" | "running" | "done" | "error"; stdout?: string; stderr?: string; exitCode?: number; message?: string }>({ status: "idle" });

  const serverEntry = artifact.server;
  // One-shot inference: a .py file runs as python, .js/.mjs as node.
  const scriptEntry = useMemo(() => {
    if (serverEntry) return null;
    const py = artifact.files.find((f) => /\.py$/i.test(f.name));
    if (py) return { name: py.name, language: "python" as const };
    const js = artifact.files.find((f) => /\.(js|mjs)$/i.test(f.name));
    if (js) return { name: js.name, language: "node" as const };
    return null;
  }, [artifact.files, serverEntry]);

  const post = (msg: ControlValueMessage) => {
    try {
      frameRef.current?.contentWindow?.postMessage(msg, "*");
    } catch {
      /* frame torn down mid-send — ignore */
    }
  };

  // Served apps have no postMessage bridge: values travel in the query
  // string, so a control change re-embeds the frame with fresh values.
  const serverSrc = useMemo(() => {
    if (server.status !== "live" || !server.url) return undefined;
    const payload = JSON.stringify(valuesRef.current);
    return `${server.url}${server.url.includes("?") ? "&" : "?"}__orplex=${encodeURIComponent(payload)}&v=${valuesVersion}`;
  }, [server.status, server.url, valuesVersion]);

  const startServer = async () => {
    if (!serverEntry) return;
    setServer({ status: "booting" });
    try {
      const res = await apiFetch("/api/agent/sandbox/artifact-serve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: artifact.files.map((f) => ({ path: f.name, content: f.content })),
          entry: serverEntry.entry,
          language: serverEntry.type,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setServer({ status: "error", message: data?.error || "server failed to start" });
        return;
      }
      setServer({ status: "live", url: data.url });
    } catch (err) {
      setServer({ status: "error", message: (err as Error).message });
    }
  };

  const runScript = async () => {
    if (!scriptEntry) return;
    setRun({ status: "running" });
    try {
      const res = await apiFetch("/api/agent/sandbox/artifact-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: artifact.files.map((f) => ({ path: f.name, content: f.content })),
          entry: scriptEntry.name,
          language: scriptEntry.language,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRun({ status: "error", message: data?.error || "run failed" });
        return;
      }
      setRun({ status: "done", stdout: data.stdout, stderr: data.stderr, exitCode: data.exitCode });
    } catch (err) {
      setRun({ status: "error", message: (err as Error).message });
    }
  };

  const sendValues = () => {
    if (server.status === "live") {
      // Server mode: re-embed with the new values.
      setValuesVersion((v) => v + 1);
      return;
    }
    post({ __orplex: "controls", values: valuesRef.current });
  };

  return (
    <div className="sandbox-artifact">
      <div className="sandbox-artifact-head">
        <span className="sandbox-artifact-title">{artifact.title || "Preview"}</span>
        <div className="sandbox-artifact-head-actions">
          {serverEntry && server.status !== "live" && (
            <button
              type="button"
              className="sandbox-artifact-run"
              onClick={startServer}
              disabled={server.status === "booting"}
              title="Run this app inside a Vercel Sandbox and embed the live URL"
            >
              {server.status === "booting" ? "Starting…" : server.status === "error" ? "Retry server" : "Run server"}
            </button>
          )}
          {scriptEntry && (
            <button
              type="button"
              className="sandbox-artifact-run"
              onClick={runScript}
              disabled={run.status === "running"}
              title="Execute this script inside a Vercel Sandbox"
            >
              {run.status === "running" ? "Running…" : "Run code"}
            </button>
          )}
          <button
            type="button"
            className="sandbox-artifact-restart"
            onClick={() => {
              if (server.status === "live") {
                // A live server lives in the VM — restarting it means a fresh
                // process (and a fresh app workspace) on the same VM.
                startServer();
                return;
              }
              setGen((g) => g + 1);
            }}
            title="Restart the preview (resets its state)"
          >
            Restart
          </button>
        </div>
      </div>
      {server.status === "live" && server.url ? (
        <iframe
          key={`server-${gen}-${valuesVersion}`}
          ref={frameRef}
          className="sandbox-artifact-frame"
          sandbox="allow-scripts allow-forms allow-popups"
          title={artifact.title || "Live app"}
          src={serverSrc}
          style={{ height: FRAME_HEIGHT }}
        />
      ) : (
        <iframe
          key={gen}
          ref={frameRef}
          className="sandbox-artifact-frame"
          sandbox="allow-scripts"
          title={artifact.title || "Interactive preview"}
          srcDoc={doc}
          style={{ height: FRAME_HEIGHT }}
          onLoad={() => post({ __orplex: "controls", values: valuesRef.current })}
        />
      )}
      {server.status === "error" && (
        <div className="sandbox-artifact-console sandbox-artifact-console-error">
          Server failed: {server.message}
        </div>
      )}
      {server.status === "live" && server.url && (
        <div className="sandbox-artifact-meta">
          Live at <a href={server.url} target="_blank" rel="noreferrer">{server.url}</a>
        </div>
      )}
      {run.status !== "idle" && (
        <div className="sandbox-artifact-console">
          {run.status === "running" && <div className="sandbox-artifact-console-line">Running in sandbox…</div>}
          {run.status === "error" && <div className="sandbox-artifact-console-line sandbox-artifact-console-error">{run.message}</div>}
          {run.status === "done" && (
            <>
              {run.stdout ? <pre className="sandbox-artifact-console-out">{run.stdout}</pre> : null}
              {run.stderr ? <pre className="sandbox-artifact-console-out sandbox-artifact-console-error">{run.stderr}</pre> : null}
              <div className="sandbox-artifact-console-line">exit code {run.exitCode}</div>
            </>
          )}
        </div>
      )}
      {controls.length > 0 && (
        <div className="sandbox-artifact-controls">
          {controls.map((c) => (
            <ControlRow
              key={c.id}
              control={c}
              defaultValue={valuesRef.current[c.id]}
              onChange={(id, value, kind) => {
                if (kind === "action") {
                  if (server.status === "live") {
                    // Actions have no query-string channel — a re-embed is the
                    // closest equivalent (the app re-reads state on load).
                    setValuesVersion((v) => v + 1);
                  } else {
                    post({ __orplex: "action", id });
                  }
                } else {
                  valuesRef.current[id] = value;
                  sendValues();
                }
              }}
            />
          ))}
        </div>
      )}
      {artifact.files.length > 1 && (
        <div className="sandbox-artifact-meta">
          {artifact.files.map((f) => f.name).join(" · ")}
        </div>
      )}
    </div>
  );
}
