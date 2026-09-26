# Strict-mode hook verification: launches the FocusLockKeyboardHook helper,
# sends REAL Alt+Tab keypresses (SendInput via SendKeys), and reads the hook's
# blocked counter through its named pipe. Proves the hook swallows Alt+Tab.
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot '..\prebuilds\FocusLockKeyboardHook.exe'
$exe = [System.IO.Path]::GetFullPath($exe)

Add-Type -AssemblyName System.Windows.Forms

function Read-HookState {
    $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'FocusLockKeyboardHook', [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $client.Connect(2000)
        $writer = New-Object System.IO.StreamWriter($client)
        $writer.AutoFlush = $true
        $reader = New-Object System.IO.StreamReader($client)
        $writer.WriteLine('state')
        return $reader.ReadLine()
    } finally {
        $client.Dispose()
    }
}

function Stop-Hook {
    try {
        $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'FocusLockKeyboardHook', [System.IO.Pipes.PipeDirection]::InOut)
        $client.Connect(1000)
        $writer = New-Object System.IO.StreamWriter($client)
        $writer.AutoFlush = $true
        $reader = New-Object System.IO.StreamReader($client)
        $writer.WriteLine('quit')
        $null = $reader.ReadLine()
        $client.Dispose()
    } catch { }
}

# 1. Launch the helper (no --owner: this script is the owner).
$proc = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
try {
    # Wait for the pipe to appear and the hook to be installed.
    $state = $null
    for ($i = 0; $i -lt 30; $i++) {
        try { $state = Read-HookState } catch { }
        if ($state -match 'installed=1') { break }
        Start-Sleep -Milliseconds 200
    }
    Write-Output "HOOK_STATE_BEFORE: $state"
    if ($state -notmatch 'installed=1') {
        Write-Output 'RESULT: FAIL (hook did not install)'
        exit 1
    }

    # 2. Send REAL Alt+Tab keypresses via SendInput (System.Windows.Forms.SendKeys
    #    posts messages to the focused window, which the hook WOULD see, but
    #    SendInput injects at the same level as a physical keyboard - the exact
    #    adversary the hook must defeat).
    $sig = @'
using System;
using System.Runtime.InteropServices;
public static class KbInject {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    public static void Tap(ushort vk, bool alt) {
        INPUT[] down = new INPUT[alt ? 2 : 1];
        if (alt) { down[0].type = INPUT_KEYBOARD; down[0].U.ki.wVk = 0x12; } // VK_MENU
        down[alt ? 1 : 0].type = INPUT_KEYBOARD;
        down[alt ? 1 : 0].U.ki.wVk = vk;
        SendInput((uint)down.Length, down, Marshal.SizeOf(typeof(INPUT)));
        System.Threading.Thread.Sleep(60);
        INPUT[] up = new INPUT[alt ? 2 : 1];
        up[alt ? 1 : 0].type = INPUT_KEYBOARD;
        up[alt ? 1 : 0].U.ki.wVk = vk;
        up[alt ? 1 : 0].U.ki.dwFlags = KEYEVENTF_KEYUP;
        if (alt) { up[0].type = INPUT_KEYBOARD; up[0].U.ki.wVk = 0x12; up[0].U.ki.dwFlags = KEYEVENTF_KEYUP; }
        SendInput((uint)up.Length, up, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@
    Add-Type -TypeDefinition $sig

    # Ten Alt+Tab taps. If the hook works, the Task Switcher never appears
    # (nothing else is running to tab to anyway - the keys are simply eaten).
    for ($i = 0; $i -lt 10; $i++) {
        [KbInject]::Tap(0x09, $true)  # VK_TAB with Alt held
        Start-Sleep -Milliseconds 40
    }
    # Two Win-key taps (must also be swallowed).
    [KbInject]::Tap(0x5B, $false)  # VK_LWIN
    [KbInject]::Tap(0x5B, $false)

    Start-Sleep -Milliseconds 300
    $after = Read-HookState
    Write-Output "HOOK_STATE_AFTER: $after"

    if ($after -match 'blocked=(\d+)') {
        $blocked = [int]$Matches[1]
        if ($blocked -ge 12) {
            Write-Output "RESULT: PASS ($blocked injected combos swallowed)"
            exit 0
        } else {
            Write-Output "RESULT: FAIL (only $blocked blocked; expected >= 12)"
            exit 1
        }
    }
    Write-Output 'RESULT: FAIL (could not read blocked counter)'
    exit 1
} finally {
    Stop-Hook
    if (-not $proc.HasExited) { $proc.Kill() }
}
