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

  const post = (msg: ControlValueMessage) => {
    try {
      frameRef.current?.contentWindow?.postMessage(msg, "*");
    } catch {
      /* frame torn down mid-send — ignore */
    }
  };

  return (
    <div className="sandbox-artifact">
      <div className="sandbox-artifact-head">
        <span className="sandbox-artifact-title">{artifact.title || "Preview"}</span>
        <div className="sandbox-artifact-head-actions">
          <button
            type="button"
            className="sandbox-artifact-restart"
            onClick={() => setGen((g) => g + 1)}
            title="Restart the preview (resets its state)"
          >
            Restart
          </button>
        </div>
      </div>
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
      {controls.length > 0 && (
        <div className="sandbox-artifact-controls">
          {controls.map((c) => (
            <ControlRow
              key={c.id}
              control={c}
              defaultValue={valuesRef.current[c.id]}
              onChange={(id, value, kind) => {
                if (kind === "action") {
                  post({ __orplex: "action", id });
                } else {
                  valuesRef.current[id] = value;
                  post({ __orplex: "controls", values: valuesRef.current });
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
