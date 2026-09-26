# Class-pin fullscreen verification: opens Notepad, pins it via
# native/classPin.ps1 (borderless fullscreen), checks the geometry/styles,
# restores, and checks that the original windowed state came back.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$script = Join-Path $PSScriptRoot '..\native\classPin.ps1'
$script = [System.IO.Path]::GetFullPath($script)
$stateFile = Join-Path $env:TEMP 'fl-verify-pin-state.json'
if (Test-Path $stateFile) { Remove-Item $stateFile -Force }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinProbe {
  [DllImport("user32.dll")] public static extern long GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }
  public const int GWL_STYLE = -16;
  public const int GWL_EXSTYLE = -20;
  public const long WS_CAPTION = 0x00C00000L;
  public const long WS_THICKFRAME = 0x00040000L;
  public const long WS_EX_TOOLWINDOW = 0x00000080L;
}
'@

function Get-Geometry([IntPtr]$h) {
  $r = New-Object WinProbe+RECT
  [WinProbe]::GetWindowRect($h, [ref]$r) | Out-Null
  return @{
    W = $r.Right - $r.Left; H = $r.Bottom - $r.Top
    X = $r.Left; Y = $r.Top
    Caption = (([WinProbe]::GetWindowLongPtr($h, [WinProbe]::GWL_STYLE) -band [WinProbe]::WS_CAPTION) -ne 0)
    Thick = (([WinProbe]::GetWindowLongPtr($h, [WinProbe]::GWL_STYLE) -band [WinProbe]::WS_THICKFRAME) -ne 0)
    ToolWin = (([WinProbe]::GetWindowLongPtr($h, [WinProbe]::GWL_EXSTYLE) -band [WinProbe]::WS_EX_TOOLWINDOW) -ne 0)
  }
}

# 1. Create our own classic Win32 test window via P/Invoke - deterministic,
# no dependency on Store-app stubs or Windows Terminal redirection.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class TestWin {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
  [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
  public static int LastError;
  public static IntPtr MakeTestWindow() {
    // The always-registered user32 "STATIC" class keeps this deterministic;
    // the pin helper only touches generic styles/bounds, not the class.
    // WS_OVERLAPPEDWINDOW: caption + thickframe + sysmenu + min/max boxes.
    IntPtr hwnd = CreateWindowExW(0, "STATIC", "FocusLock Pin Test", 0x00CF0000u, 120, 120, 700, 480, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (hwnd == IntPtr.Zero) { LastError = Marshal.GetLastWin32Error(); }
    return hwnd;
  }
}
'@
$testHwnd = [TestWin]::MakeTestWindow()
if ($testHwnd -eq [IntPtr]::Zero) { Write-Output ("RESULT: FAIL (could not create test window, win32 error {0})" -f [TestWin]::LastError); exit 1 }
$hwnd = $testHwnd
$createdWindow = $true

# 1b. Create a topmost "widget stand-in" (like the real countdown widget:
# small, popup, topmost, toolwindow) whose HWND we hand to the pin helper.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WidgetWin {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
  [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
  public static IntPtr MakeWidget() {
    // WS_POPUP|WS_VISIBLE, WS_EX_TOPMOST|WS_EX_TOOLWINDOW - the countdown
    // widget's profile: a small always-on-top chromeless surface.
    return CreateWindowExW(0x88u, "STATIC", "FocusLock Widget StandIn", 0x98000000u, 16, 16, 172, 64, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
  }
}
'@
$widgetHwnd = [WidgetWin]::MakeWidget()
if ($widgetHwnd -eq [IntPtr]::Zero) { Write-Output 'RESULT: FAIL (could not create widget stand-in)'; [TestWin]::DestroyWindow($hwnd) | Out-Null; exit 1 }
$widgetCenter = New-Object WinProbe+POINT
$widgetCenter.X = 16 + 86
$widgetCenter.Y = 16 + 32

$before = Get-Geometry $hwnd
Write-Output ("BEFORE: {0}x{1} at ({2},{3}) caption={4} thick={5} toolwin={6}" -f $before.W, $before.H, $before.X, $before.Y, $before.Caption, $before.Thick, $before.ToolWin)

# 2. Pin it (borderless fullscreen), capturing the helper's stderr so a
# script error can never hide behind a silent no-op.
$parentPid = $PID
$pinErr = Join-Path $env:TEMP 'fl-pin-err.txt'
$pin = Start-Process powershell -ArgumentList @(
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
  '-File', $script, '-Action', 'pin', '-Hwnd', "$([int64]$hwnd)",
  '-ParentPid', "$parentPid", '-StateFile', $stateFile, '-WidgetHwnd', "$([int64]$widgetHwnd)"
) -PassThru -WindowStyle Hidden -RedirectStandardError $pinErr

# Wait for the fullscreen geometry + style to take effect.
$full = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  $full = Get-Geometry $hwnd
  if (-not $full.Caption -and -not $full.Thick -and $full.ToolWin -and $full.W -ge 1200) { break }
}
if ($pin.HasExited) {
  Write-Output ("PIN-HELPER EXITED code={0}: {1}" -f $pin.ExitCode, (Get-Content $pinErr -Raw))
}
$full = Get-Geometry $hwnd
Write-Output ("PINNED: {0}x{1} at ({2},{3}) caption={4} thick={5} toolwin={6}" -f $full.W, $full.H, $full.X, $full.Y, $full.Caption, $full.Thick, $full.ToolWin)
Write-Output ("SCREEN: {0}x{1}" -f [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height)

$pinnedOk = (-not $full.Caption) -and (-not $full.Thick) -and $full.ToolWin -and ($full.W -ge 1200)
Write-Output "PINNED-OK: $pinnedOk"

# 2b. Z-order check: give the helper's watchdog at least one tick (300 ms),
# then ask Windows which window is visible at the widget stand-in's center.
# If the widget is above the fullscreen pinned window (the fix), the answer
# must be the widget itself - not the pinned window that covers the screen.
Start-Sleep -Milliseconds 700
$atPoint = [WinProbe]::WindowFromPoint($widgetCenter)
$widgetAbove = ($atPoint -eq $widgetHwnd)
Write-Output ("ZORDER: windowAtWidgetPoint={0} widgetHwnd={1} above={2}" -f $atPoint, $widgetHwnd, $widgetAbove)

# 3. Stop the pin (restore path) and check the original windowed state.
$pin.Kill()
Start-Sleep -Milliseconds 500

& powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Action restore -Hwnd "$([int64]$hwnd)" -StateFile $stateFile
Start-Sleep -Milliseconds 800

$after = Get-Geometry $hwnd
Write-Output ("AFTER: {0}x{1} at ({2},{3}) caption={4} thick={5} toolwin={6}" -f $after.W, $after.H, $after.X, $after.Y, $after.Caption, $after.Thick, $after.ToolWin)

$ok = $pinnedOk -and $widgetAbove -and ($after.Caption -eq $true) -and ($after.Thick -eq $true) -and ($after.ToolWin -eq $false) -and ($after.W -lt 1200) -and ($after.H -lt 900)
if ($ok) { Write-Output 'RESULT: PASS' } else { Write-Output 'RESULT: FAIL' }

# Cleanup
[WidgetWin]::DestroyWindow($widgetHwnd) | Out-Null
[TestWin]::DestroyWindow($hwnd) | Out-Null
if (Test-Path $stateFile) { Remove-Item $stateFile -Force }
if ($ok) { exit 0 } else { exit 1 }
