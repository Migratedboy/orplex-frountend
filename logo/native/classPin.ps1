<#
.SYNOPSIS
  Class mode window pin with borderless fullscreen.

.DESCRIPTION
  All Win32 calls live inside the C# helper class with primitive-only
  signatures: PowerShell 5.1 mis-marshals [ref] nested structs (MONITORINFO,
  WINDOWPLACEMENT) across P/Invoke, so structs never cross the PS boundary.

  pin <hwnd> <parentPid> <stateFile> [--Once]:
    - Saves the window's style/ex-style/rect/placement to the state file.
    - Borderless fullscreen on its monitor, TOPMOST, taskbar/Alt+Tab hidden.
    - 300 ms watchdog keeps it topmost + focused (skipped with --Once).
    - Restores the window on exit (window closed / parent died).

  restore <hwnd> <stateFile>:
    - Restores the saved style/rect/placement; clears the state file.
#>
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Hwnd = '0',
  [string]$ParentPid = '0',
  [string]$StateFile = '',
  # Optional countdown-widget HWND: kept just above the pinned class window
  # every watchdog tick, so the timer floats over the fullscreen class.
  [string]$WidgetHwnd = '0',
  [switch]$Once
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinPin {
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
  [DllImport("user32.dll", SetLastError = true)] public static extern long GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", SetLastError = true)] public static extern long SetWindowLongPtr(IntPtr hWnd, int index, long value);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);

  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOREDRAW = 0x0008;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const int GWL_STYLE = -16;
  public const int GWL_EXSTYLE = -20;
  public const long WS_CAPTION = 0x00C00000L;
  public const long WS_THICKFRAME = 0x00040000L;
  public const long WS_MINIMIZEBOX = 0x00020000L;
  public const long WS_MAXIMIZEBOX = 0x00010000L;
  public const long WS_SYSMENU = 0x00080000L;
  public const long WS_EX_APPWINDOW = 0x00040000L;
  public const long WS_EX_TOOLWINDOW = 0x00000080L;
  public const uint MONITOR_DEFAULTTONEAREST = 2;

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct WINDOWPLACEMENT {
    public int length;
    public uint flags;
    public uint showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }

  // CaptureState: all struct handling stays inside C#. Returns
  // "hwnd|style|exStyle|x|y|w|h|showCmd|normL,normT,normR,normB".
  public static string CaptureState(IntPtr hwnd) {
    WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
    wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
    GetWindowPlacement(hwnd, ref wp);
    RECT r;
    GetWindowRect(hwnd, out r);
    return string.Format(
      "{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8},{9},{10},{11}",
      hwnd.ToInt64(),
      GetWindowLongPtr(hwnd, GWL_STYLE),
      GetWindowLongPtr(hwnd, GWL_EXSTYLE),
      r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top,
      wp.showCmd,
      wp.rcNormalPosition.Left, wp.rcNormalPosition.Top,
      wp.rcNormalPosition.Right, wp.rcNormalPosition.Bottom);
  }

  // ApplyFullscreen: strips window chrome, hides from taskbar/Alt+Tab,
  // sizes to the monitor's full bounds and makes TOPMOST. Primitive-only
  // signature so nothing but IntPtr/long crosses into PowerShell.
  public static string ApplyFullscreen(IntPtr hwnd) {
    long style = GetWindowLongPtr(hwnd, GWL_STYLE);
    style &= ~(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
    SetWindowLongPtr(hwnd, GWL_STYLE, style);

    long ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
    ex &= ~WS_EX_APPWINDOW;
    ex |= WS_EX_TOOLWINDOW;
    SetWindowLongPtr(hwnd, GWL_EXSTYLE, ex);

    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    IntPtr hMon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    if (hMon == IntPtr.Zero || !GetMonitorInfo(hMon, ref mi)) {
      return "monitor-failed err=" + Marshal.GetLastWin32Error();
    }
    int w = mi.rcMonitor.Right - mi.rcMonitor.Left;
    int h = mi.rcMonitor.Bottom - mi.rcMonitor.Top;
    bool ok = SetWindowPos(hwnd, (IntPtr)(-1), mi.rcMonitor.Left, mi.rcMonitor.Top, w, h,
      SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    return "applied " + w + "x" + h + " ok=" + ok + " err=" + Marshal.GetLastWin32Error();
  }

  // KeepTopmost: one watchdog iteration. Primitive-only signature.
  // Raises the class window to the top of the topmost band, then places the
  // countdown widget (if any) above it, so the timer is always visible.
  public static bool KeepTopmost(IntPtr hwnd, IntPtr widget) {
    if (!IsWindow(hwnd)) return false;
    if (IsIconic(hwnd)) ShowWindowAsync(hwnd, 9);  // SW_RESTORE
    SetWindowPos(hwnd, (IntPtr)(-1), 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOREDRAW | SWP_SHOWWINDOW);
    if (widget != IntPtr.Zero && IsWindow(widget)) {
      SetWindowPos(widget, (IntPtr)(-1), 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
    if (!GetForegroundWindow().Equals(hwnd)) {
      SetForegroundWindow(hwnd);
    }
    return true;
  }

  // RestoreFromState: reapplies a state string produced by CaptureState.
  // All struct marshaling stays inside C#.
  public static bool RestoreFromState(IntPtr hwnd, string saved) {
    string[] parts = saved.Split('|');
    if (parts.Length < 9) return false;
    if (!IsWindow(hwnd)) return false;

    SetWindowLongPtr(hwnd, GWL_STYLE, long.Parse(parts[1]));
    SetWindowLongPtr(hwnd, GWL_EXSTYLE, long.Parse(parts[2]));

    string[] norm = parts[8].Split(',');
    if (norm.Length == 4) {
      WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
      wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
      GetWindowPlacement(hwnd, ref wp);
      wp.rcNormalPosition.Left = int.Parse(norm[0]);
      wp.rcNormalPosition.Top = int.Parse(norm[1]);
      wp.rcNormalPosition.Right = int.Parse(norm[2]);
      wp.rcNormalPosition.Bottom = int.Parse(norm[3]);
      wp.showCmd = uint.Parse(parts[7]);
      SetWindowPlacement(hwnd, ref wp);
    }

    SetWindowPos(hwnd, IntPtr.Zero, int.Parse(parts[3]), int.Parse(parts[4]),
      int.Parse(parts[5]), int.Parse(parts[6]),
      SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE);
    if (uint.Parse(parts[7]) == 2) {
      ShowWindowAsync(hwnd, 9);  // SW_RESTORE (was maximized)
    }
    return true;
  }
}
'@

function Trace([string]$msg) {
  [Console]::Error.WriteLine("[classPin] $msg")
}

function Dump-Errors {
  for ($i = 0; $i -lt $Error.Count; $i++) {
    $e = $Error[$i]
    [Console]::Error.WriteLine("[classPin] err[$i]: $($e.Exception.Message)")
    if ($e.Exception.InnerException) {
      [Console]::Error.WriteLine("[classPin]   inner: $($e.Exception.InnerException.Message)")
    }
  }
}

function Get-State {
  if ($StateFile -and (Test-Path $StateFile)) {
    return (Get-Content $StateFile -Raw).Trim()
  }
  return $null
}

function Set-State([string]$value) {
  if ($StateFile) {
    [System.IO.File]::WriteAllText($StateFile, $value)
  }
}

function Clear-State {
  if ($StateFile -and (Test-Path $StateFile)) {
    Remove-Item $StateFile -Force
  }
}

if ($Action -eq 'pin') {
  # NOTE: must NOT name this $hwnd - the param is [string]$Hwnd and PowerShell
  # variables are case-insensitive, so the constraint would coerce our IntPtr
  # back into a string and every P/Invoke call would fail.
  $hWin = [IntPtr][long]$Hwnd
  Trace "start hwnd=$Hwnd stateFile=[$StateFile]"
  if (-not [WinPin]::IsWindow($hWin)) {
    Trace 'not-a-window'
    exit 1
  }

  $saved = [WinPin]::CaptureState($hWin)
  Set-State $saved
  Trace "saved=$saved"

  $result = [WinPin]::ApplyFullscreen($hWin)
  Trace "fullscreen: $result"

  if ($Once) { exit 0 }

  # Watchdog loop: keep TOPMOST + focused, widget above, restore if minimized.
  $parent = [long]$ParentPid
  $hWidget = [IntPtr][long]$WidgetHwnd
  while ($true) {
    if (-not [WinPin]::KeepTopmost($hWin, $hWidget)) { break }
    if ((Get-Process -Id $parent -ErrorAction SilentlyContinue) -eq $null) { break }
    Start-Sleep -Milliseconds 300
  }

  # Helper is exiting (window closed / parent died): restore best-effort so a
  # killed app can never leave the class window stuck fullscreen.
  $restored = [WinPin]::RestoreFromState($hWin, (Get-State))
  Trace "restore-on-exit: $restored"
  Clear-State
  exit 0
}

if ($Action -eq 'restore') {
  $hWin = [IntPtr][long]$Hwnd
  $saved = Get-State
  if (-not $saved) {
    Trace 'no-state-to-restore'
    exit 0
  }
  $ok = [WinPin]::RestoreFromState($hWin, $saved)
  Trace "restore: $ok"
  Clear-State
  exit 0
}

Trace "unknown-action: $Action"
exit 1
