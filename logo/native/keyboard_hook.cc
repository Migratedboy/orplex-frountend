/**
 * Native Windows low-level keyboard hook (WH_KEYBOARD_LL) as an N-API addon.
 *
 * Build: npm run build:native
 * Exports:
 *   installHook(onBlocked: () => void): boolean
 *   removeHook(): void
 *   isHookInstalled(): boolean
 *
 * The hook runs on a dedicated thread with its own message pump; blocked
 * combos are forwarded to JS through the thread-safe function callback.
 *
 * Blocked while installed: Alt+Tab, both Win keys, Ctrl+Esc, Alt+Esc,
 * Alt+F4, Ctrl+Shift+Esc (Task Manager hotkey), Win+anything.
 * Ctrl+Alt+Del cannot be blocked by any userland program.
 *
 * IMPORTANT: Alt+Tab / Alt+Esc / Alt+F4 / Win-combos arrive at low-level
 * hooks as WM_SYSKEYDOWN, not WM_KEYDOWN. A hook that only handles
 * WM_KEYDOWN silently fails to block them. We handle both.
 */

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <napi.h>

#include <atomic>

namespace {

std::atomic<bool> g_installed{false};
std::atomic<HHOOK> g_hook{nullptr};
std::atomic<HWND> g_msg_window{nullptr};
Napi::ThreadSafeFunction g_tsfn;
std::atomic<bool> g_tsfn_valid{false};

bool KeyUp(const KBDLLHOOKSTRUCT* info) {
  return (info->flags & LLKHF_UP) != 0;
}

bool AltHeld() {
  return (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
}

bool WinHeld() {
  return (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 ||
         (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
}

bool CtrlHeld() {
  return (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
}

bool ShouldBlock(DWORD vk) {
  // Win key alone, Win+anything (search, snapping, etc.).
  if (vk == VK_LWIN || vk == VK_RWIN) return true;
  if (WinHeld()) return true;

  // Alt+Tab, Alt+Esc, Alt+F4.
  if ((vk == VK_TAB || vk == VK_ESCAPE || vk == VK_F4) && AltHeld()) return true;

  // Ctrl+Esc (Start menu) and Ctrl+Shift+Esc (Task Manager hotkey).
  if (vk == VK_ESCAPE && CtrlHeld()) return true;

  return false;
}

LRESULT CALLBACK LowLevelKeyboardProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION && (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN)) {
    const auto* info = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    if (!KeyUp(info) && ShouldBlock(info->vkCode)) {
      if (g_tsfn_valid.load()) {
        g_tsfn.BlockingCall();
      }
      return 1;  // Swallow: the system never sees the key.
    }
  }
  return CallNextHookEx(g_hook.load(), code, wParam, lParam);
}

// Dedicated thread: installs the hook and pumps messages. WH_KEYBOARD_LL
// callbacks are delivered on the thread that installed the hook while it
// pumps messages, so this thread must stay alive and responsive.
DWORD WINAPI HookThread(LPVOID) {
  // Message-only window: lets the uninstaller wake the GetMessageW loop.
  HWND window = CreateWindowExW(0, L"STATIC", L"focuslock_hook", 0, 0, 0, 0,
                                0, HWND_MESSAGE, nullptr, nullptr, nullptr);
  g_msg_window.store(window);

  HHOOK hook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc, nullptr, 0);
  if (hook == nullptr) {
    g_installed.store(false);
    return 1;
  }
  g_hook.store(hook);
  g_installed.store(true);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  UnhookWindowsHookEx(hook);
  g_hook.store(nullptr);
  g_installed.store(false);
  return 0;
}

void UninstallAndWait() {
  HWND window = g_msg_window.exchange(nullptr);
  if (window != nullptr) {
    PostMessageW(window, WM_CLOSE, 0, 0);
  }
  if (g_tsfn_valid.exchange(false)) {
    g_tsfn.Release();
  }
  // Wait briefly for the pump to exit and confirm.
  for (int i = 0; i < 50 && g_installed.load(); ++i) {
    Sleep(10);
  }
}

Napi::Value InstallHook(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_installed.load()) return Napi::Boolean::New(env, true);
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "installHook(callback) requires a function")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  g_tsfn = Napi::ThreadSafeFunction::New(
      env, info[0].As<Napi::Function>(), "keyboard_hook_blocked", 0, 1,
      [](Napi::Env) {});
  g_tsfn_valid.store(true);

  DWORD thread_id = 0;
  HANDLE thread = CreateThread(nullptr, 0, HookThread, nullptr, 0, &thread_id);
  if (thread == nullptr) {
    g_tsfn_valid.store(false);
    g_tsfn.Release();
    Napi::Error::New(env, "CreateThread failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  CloseHandle(thread);

  // Wait up to ~2s for the hook to come up.
  for (int i = 0; i < 200 && !g_installed.load(); ++i) {
    Sleep(10);
  }
  return Napi::Boolean::New(env, g_installed.load());
}

Napi::Value RemoveHook(const Napi::CallbackInfo& info) {
  UninstallAndWait();
  return info.Env().Undefined();
}

Napi::Value IsHookInstalled(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_installed.load());
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("installHook", Napi::Function::New(env, InstallHook));
  exports.Set("removeHook", Napi::Function::New(env, RemoveHook));
  exports.Set("isHookInstalled", Napi::Function::New(env, IsHookInstalled));
  return exports;
}

}  // namespace

NODE_API_MODULE(keyboard_hook, InitModule)
