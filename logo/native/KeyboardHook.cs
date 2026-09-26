//
// FocusLockKeyboardHook: strict-mode keyboard blocker, C# fallback backend.
//
// Implements the same WH_KEYBOARD_LL semantics as native/keyboard_hook.cc for
// machines where no C++ toolchain is available to compile the N-API addon.
// Compiled with the .NET Framework C# compiler that ships with every Windows
// install (no dependencies, no admin, C# 5 only).
//
// Usage: FocusLockKeyboardHook.exe --owner <pid>
// Named pipe  \\.\pipe\FocusLockKeyboardHook  commands:
//   "state\n" -> "installed=<0|1>;blocked=<n>\n"
//   "quit\n"  -> "bye\n" then unhooks and exits (code 0)
//
// Blocked while installed: Alt+Tab, Alt+Esc, Alt+F4, both Win keys,
// Win+anything, Ctrl+Esc, Ctrl+Shift+Esc. Alt+Tab/Alt+Esc/Alt+F4 arrive as
// WM_SYSKEYDOWN, not WM_KEYDOWN; both are handled.
// Ctrl+Alt+Del cannot be blocked by any userland program.
//
// Exits by itself when the owner process dies, stdin closes, or "quit".
//
#define WIN32_LEAN_AND_MEAN
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;

namespace FocusLock
{
    internal static class KeyboardHook
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_QUIT = 0x0012;
        private const uint LLKHF_UP = 0x80u;
        private const uint STILL_ACTIVE = 259u;
        private const int VK_TAB = 0x09;
        private const int VK_ESCAPE = 0x1B;
        private const int VK_MENU = 0x12;
        private const int VK_CONTROL = 0x11;
        private const int VK_LWIN = 0x5B;
        private const int VK_RWIN = 0x5C;
        private const int VK_F4 = 0x73;
        private const uint SYNCHRONIZE = 0x00100000u;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000u;

        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public int ptX;
            public int ptY;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookExW(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern int GetMessageW(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        private static extern bool TranslateMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern IntPtr DispatchMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern bool PostThreadMessageW(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        private static IntPtr hookHandle = IntPtr.Zero;
        private static long blockedCount = 0;
        private static volatile bool running = true;
        private static uint mainThreadId = 0;

        private static bool KeyUp(KBDLLHOOKSTRUCT info)
        {
            return (info.flags & LLKHF_UP) != 0;
        }

        private static bool ModifierHeld(int vk)
        {
            return (GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        private static bool ShouldBlock(uint vk)
        {
            if (vk == VK_LWIN || vk == VK_RWIN) return true;
            if (ModifierHeld(VK_LWIN) || ModifierHeld(VK_RWIN)) return true;
            if (ModifierHeld(VK_MENU) && (vk == VK_TAB || vk == VK_ESCAPE || vk == VK_F4)) return true;
            if (vk == VK_ESCAPE && ModifierHeld(VK_CONTROL)) return true;
            return false;
        }

        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            long wp = wParam.ToInt64();
            if (nCode >= 0 && (wp == WM_KEYDOWN || wp == WM_SYSKEYDOWN))
            {
                KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                if (!KeyUp(info) && ShouldBlock(info.vkCode))
                {
                    Interlocked.Increment(ref blockedCount);
                    return (IntPtr)1; // Swallow: the system never sees the key.
                }
            }
            return CallNextHookEx(hookHandle, nCode, wParam, lParam);
        }

        private static void Quit()
        {
            running = false;
            if (mainThreadId != 0)
            {
                PostThreadMessageW(mainThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            }
        }

        private static void WatchOwner(IntPtr processHandle)
        {
            while (running)
            {
                uint exitCode;
                if (!GetExitCodeProcess(processHandle, out exitCode) || exitCode != STILL_ACTIVE)
                {
                    Quit();
                    return;
                }
                Thread.Sleep(400);
            }
        }

        private static void WatchStdin()
        {
            try
            {
                // Blocks until the parent closes the pipe.
                Stream stdin = Console.OpenStandardInput();
                byte[] buf = new byte[256];
                while (running && stdin.Read(buf, 0, buf.Length) > 0)
                {
                }
            }
            catch
            {
            }
            Quit();
        }

        private static void PipeServer()
        {
            while (running)
            {
                NamedPipeServerStream server = null;
                try
                {
                    server = new NamedPipeServerStream(
                        "FocusLockKeyboardHook", PipeDirection.InOut, 1,
                        PipeTransmissionMode.Byte, PipeOptions.None);
                    // Blocking wait on this dedicated background thread (the
                    // timeout overload is .NET Core only). When the process
                    // exits, the thread dies with it.
                    server.WaitForConnection();
                    using (StreamReader reader = new StreamReader(server))
                    using (StreamWriter writer = new StreamWriter(server))
                    {
                        writer.AutoFlush = true;
                        string line = reader.ReadLine();
                        if (line == "state")
                        {
                            writer.WriteLine(string.Format(
                                "installed={0};blocked={1}",
                                hookHandle != IntPtr.Zero ? 1 : 0,
                                Interlocked.Read(ref blockedCount)));
                        }
                        else if (line == "quit")
                        {
                            writer.WriteLine("bye");
                            Quit();
                        }
                    }
                }
                catch
                {
                    // Connect timeout or client vanished: listen again.
                }
                finally
                {
                    if (server != null)
                    {
                        try { server.Dispose(); } catch { }
                    }
                }
            }
        }

        private static int Run(uint ownerPid)
        {
            mainThreadId = GetCurrentThreadId();

            if (ownerPid != 0)
            {
                IntPtr handle = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, ownerPid);
                if (handle != IntPtr.Zero)
                {
                    Thread t = new Thread(delegate() { WatchOwner(handle); });
                    t.IsBackground = true;
                    t.Start();
                }
            }

            Thread stdinThread = new Thread(new ThreadStart(WatchStdin));
            stdinThread.IsBackground = true;
            stdinThread.Start();

            Thread pipeThread = new Thread(new ThreadStart(PipeServer));
            pipeThread.IsBackground = true;
            pipeThread.Start();

            // Keep the delegate referenced for the process lifetime: the hook
            // callback must never be collected while installed.
            LowLevelKeyboardProc proc = HookCallback;
            hookHandle = SetWindowsHookExW(WH_KEYBOARD_LL, proc, IntPtr.Zero, 0);
            if (hookHandle == IntPtr.Zero)
            {
                return 1;
            }

            MSG msg;
            while (running)
            {
                int r = GetMessageW(out msg, IntPtr.Zero, 0, 0);
                if (r <= 0) break;
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }

            UnhookWindowsHookEx(hookHandle);
            hookHandle = IntPtr.Zero;
            return 0;
        }

        private static int Main(string[] args)
        {
            uint ownerPid = 0;
            for (int i = 0; i + 1 < args.Length; i++)
            {
                if (args[i] == "--owner")
                {
                    uint.TryParse(args[i + 1], out ownerPid);
                }
            }

            bool createdNew;
            using (Mutex mutex = new Mutex(true, "FocusLockKeyboardHook", out createdNew))
            {
                if (!createdNew)
                {
                    bool acquired = false;
                    try
                    {
                        acquired = mutex.WaitOne(5000);
                    }
                    catch (AbandonedMutexException)
                    {
                        acquired = true;
                    }
                    if (!acquired)
                    {
                        return 2; // Another hook instance is already running.
                    }
                }
                try
                {
                    return Run(ownerPid);
                }
                finally
                {
                    try { mutex.ReleaseMutex(); } catch { }
                }
            }
        }
    }
}
