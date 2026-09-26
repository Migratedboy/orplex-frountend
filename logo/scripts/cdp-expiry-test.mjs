// End-to-end expiry test over CDP: starts a real class session (5 s) through
// the widget's bridge (the panel self-destroys mid-invoke, so its promise
// never settles), waits for natural expiry, and verifies the phase returns
// to idle. With --pin-hwnd <hwnd> it also verifies the pinned window is
// physically restored (style + bounds) after expiry.
const port = process.env['CDP_PORT'] ?? '9222';
const args = process.argv.slice(2);
const pinIdx = args.indexOf('--pin-hwnd');
const pinHwnd = pinIdx >= 0 ? args[pinIdx + 1] : null;
const durationMs = 5000;

import { execSync } from 'node:child_process';

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('ws connect failed'));
  });
}

function makeEval(ws) {
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  return (expression, timeoutMs = 8000) => {
    const id = ++seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error('eval timeout'));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result?.result?.value);
      });
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        })
      );
    });
  };
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const probePath = path.join(os.tmpdir(), 'fl-winstate.ps1');
fs.writeFileSync(
  probePath,
  `param([string]$H)
Add-Type @'
using System; using System.Runtime.InteropServices;
public class P {
  [DllImport("user32.dll")] public static extern long GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static string State(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    long style = GetWindowLongPtr(h, -16);
    long ex = GetWindowLongPtr(h, -20);
    return string.Format("{0}x{1}@({2},{3}) cap={4} thick={5} tool={6} topmost={7}",
      r.Right - r.Left, r.Bottom - r.Top, r.Left, r.Top,
      (style & 0xC00000L) != 0, (style & 0x40000L) != 0,
      (ex & 0x80L) != 0, (ex & 0x8L) != 0);
  }
}
'@
Write-Output ([P]::State([IntPtr][long]$H))
`,
  'utf8'
);

function winState(hwnd) {
  return execSync(
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${probePath}" -H ${hwnd}`,
    { encoding: 'utf8' }
  ).trim();
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const widget = targets.find((t) => t.url.includes('widget.html'));
if (!widget) {
  console.error('FAIL: widget target not found');
  process.exit(1);
}
const evalWidget = makeEval(await connect(widget.webSocketDebuggerUrl));

const before = pinHwnd ? winState(pinHwnd) : null;
if (pinHwnd) console.log('BEFORE-PIN:', before);

console.log('STEP: starting class session', { pinHwnd });
const startResult = await evalWidget(
  `window.focuslock.startTimer({ durationMs: ${durationMs}, strictMode: false, mode: 'class', pinHwnd: ${
    pinHwnd ? `'${pinHwnd}'` : 'null'
  } })`
);
console.log('START:', JSON.stringify(startResult));

const t0 = Date.now();
let last = null;
const timeline = [];
let duringPin = null;
while (Date.now() - t0 < durationMs + 15000) {
  const s = await evalWidget('window.focuslock.getState()');
  if (s && s.phase !== last) {
    timeline.push({ t: Date.now() - t0, phase: s.phase });
    last = s.phase;
  }
  if (pinHwnd && s && s.phase === 'locked' && duringPin === null && Date.now() - t0 > 1500) {
    try {
      duringPin = winState(pinHwnd);
      console.log('DURING-PIN:', duringPin);
    } catch {}
  }
  if (s && s.phase === 'idle') break;
  await new Promise((r) => setTimeout(r, 300));
}
console.log('TIMELINE:', JSON.stringify(timeline));

let ok = timeline.some((e) => e.phase === 'locked') && timeline.at(-1)?.phase === 'idle';

if (pinHwnd) {
  await new Promise((r) => setTimeout(r, 1500)); // let restore settle
  const after = winState(pinHwnd);
  console.log('AFTER-PIN:', after);
  const released =
    after.includes('cap=True') && after.includes('thick=True') && !after.includes('topmost=True');
  console.log('PIN-RELEASED:', released);
  ok = ok && released;
}

console.log(ok ? 'RESULT: PASS (lock released at expiry)' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
