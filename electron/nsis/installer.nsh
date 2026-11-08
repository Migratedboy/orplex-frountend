; installer.nsh — Orplex Code NSIS hook (electron-builder `build.nsis.include`).
;
; WHY THIS FILE EXISTS: the stray Electron window after a self-update.
;
; electron-builder's installer re-launches the app by executing $launchLink,
; and templates/nsis/installSection.nsh picks that link like this:
;
;   ${if} ${FileExists} "$newStartMenuLink"
;     StrCpy $launchLink "$newStartMenuLink"
;   ${else}
;     StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
;   ${endIf}
;
; ...and templates/nsis/common.nsh's StartApp macro then does
;
;   ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
;
; So on an UPDATE the app is started through the Start Menu shortcut, never
; through the exe that was just installed. Electron's Windows toast path
; creates a Start Menu shortcut for whatever binary is running, so a dev run
; left "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Orplex Code.lnk"
; pointing at node_modules\electron\dist\orplex-dev.exe. The installer keeps
; existing shortcuts (KeepShortcuts), so the updater re-launched that dev
; binary with no app path — and a bare Electron binary with no app path shows
; Electron's default_app welcome window ("Electron v41 | Chromium | Node",
; hint "$ orplex-dev.exe path-to-app") instead of Orplex Code.
;
; THE FIX: customInstall is invoked AFTER $launchLink has been chosen and
; BEFORE StartApp, so override it with the executable we just installed. The
; relaunch target can then never be a shortcut, whatever it points at.
;
; (The poisoned shortcut itself is repaired in place by the app: see
; electron/main.ts sweepIconPoison() / repairShortcut(), which rewrites it to
; process.execPath and the packaged AUMID. Detection of dev-lane targets —
; stock electron.exe AND the branded orplex-dev.exe — is in
; electron/icon-poison.ts.)

!macro customInstall
  ; Always relaunch the installed executable, never a shortcut.
  StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend
