"use client";

// New project modal — the design in new-project-modal.html, wired to the app.
//
// Two real paths, one dialog:
//   From scratch → POST /api/projects/create → an empty folder on disk.
//   GitHub       → device flow (if needed) → /api/repos/github → git clone.
// Both end the same way: the caller registers the absolute path as the
// workspace and opens a fresh chat in it.
//
// Everything the reference did with mocks (REPOS, the 500ms "Connecting…",
// console.log create, demo toasts) is gone. Every state below is a real HTTP
// answer: loading, error + retry, rate limit, expired token, needs-install.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "@/lib/api-base";
import { startMediatorSignIn } from "@/lib/signin-mediator";
import { MAX_PROJECT_NAME, projectNameMessage, projectNameProblem } from "@/lib/project-names";
import styles from "./NewProjectModal.module.css";

export type GitHubRepo = {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  updatedAt: string;
  cloneUrl: string;
};

type Tab = "scratch" | "github";

type DeviceFlow = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  interval: number;
};

export type NewProjectModalProps = {
  open: boolean;
  onClose: () => void;
  /** Existing project folder names — a duplicate would collide on disk. */
  projects: string[];
  /** Called once the folder exists AND is ready to be opened. */
  onCreated: (path: string, name: string) => void | Promise<void>;
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export default function NewProjectModal({ open, onClose, projects, onCreated }: NewProjectModalProps) {
  const [tab, setTab] = useState<Tab>("scratch");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // From scratch
  const [parent, setParent] = useState<{ path: string; label: string } | null>(null);
  const [defaultParent, setDefaultParent] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);

  // GitHub — connection status survives re-opens, the list itself is refetched.
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [needsInstall, setNeedsInstall] = useState(false);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [login, setLogin] = useState<string | null>(null);
  const [repoMsg, setRepoMsg] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<GitHubRepo | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteMsg, setRemoteMsg] = useState<string | null>(null);

  const [device, setDevice] = useState<DeviceFlow | null>(null);
  const [deviceErr, setDeviceErr] = useState<string | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceCancelled, setDeviceCancelled] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);

  const openExternal = useCallback((url: string) => {
    const bridge = window.orplexDesktop?.openExternal;
    if (bridge) void bridge(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const resetInputs = useCallback(() => {
    setTab("scratch");
    setName("");
    setError(null);
    setParent(null);
    setQuery("");
    setSelected(null);
    setRemoteMsg(null);
  }, []);

  // Open: remember the trigger, clear per-open state, focus the name field.
  useLayoutEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement;
    resetInputs();
    setDeviceErr(null);
    setDeviceCancelled(false);
    const t = window.setTimeout(() => nameRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, resetInputs]);

  // Close: hand focus back to whatever opened the dialog.
  useEffect(() => {
    if (open) return;
    const el = returnFocusRef.current as HTMLElement | null;
    returnFocusRef.current = null;
    if (el && typeof el.focus === "function" && document.contains(el)) el.focus();
  }, [open]);

  // Where projects land when no folder is chosen — named, not guessed.
  useEffect(() => {
    if (!open || defaultParent) return;
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch("/api/projects/create");
        const data = await res.json().catch(() => ({}));
        if (live && typeof data?.defaultParent === "string") setDefaultParent(data.defaultParent);
      } catch {
        /* the label is cosmetic; creation still works */
      }
    })();
    return () => {
      live = false;
    };
  }, [open, defaultParent]);

  const loadRepos = useCallback(async () => {
    setRepos(null);
    setRepoMsg(null);
    try {
      const res = await apiFetch("/api/repos/github");
      const data = await res.json().catch(() => ({}));
      const list = Array.isArray(data?.repos) ? (data.repos as GitHubRepo[]) : [];
      setRepos(list);
      setConnected(data?.connected !== false);
      setNeedsInstall(data?.needsInstall === true);
      setInstallUrl(typeof data?.installUrl === "string" ? data.installUrl : null);
      setLogin(typeof data?.login === "string" ? data.login : null);
      setRepoMsg(typeof data?.error === "string" ? data.error : null);
    } catch {
      setConnected(false);
      setRepos([]);
      setRepoMsg("Could not reach the app server.");
    }
  }, []);

  useEffect(() => {
    if (open && tab === "github" && repos === null && !device) void loadRepos();
  }, [open, tab, repos, device, loadRepos]);

  const connectGitHub = useCallback(async () => {
    setDeviceBusy(true);
    setDeviceErr(null);
    setDeviceCancelled(false);
    try {
      const res = await apiFetch("/api/repos/github/device", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.flowId && data?.userCode) {
        setDevice({
          flowId: data.flowId,
          userCode: data.userCode,
          verificationUri: data.verificationUri || "https://github.com/login/device",
          interval: Math.max(5, Number(data.interval) || 5),
        });
        openExternal(data.verificationUri || "https://github.com/login/device");
        return;
      }
      if (res.status === 501) {
        // This install has no device-flow client id: use the browser door.
        startMediatorSignIn("github", "/");
        return;
      }
      setDeviceErr(data?.error || `GitHub responded ${res.status}`);
    } catch (e) {
      setDeviceErr(e instanceof Error ? e.message : "Could not start GitHub sign-in");
    } finally {
      setDeviceBusy(false);
    }
  }, [openExternal]);

  // Poll the device flow until GitHub hands over a token (or says no).
  useEffect(() => {
    if (!device || deviceCancelled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await apiFetch(`/api/repos/github/device?flow=${encodeURIComponent(device.flowId)}`);
        const data = await res.json().catch(() => ({}));
        if (stopped) return;
        if (data?.status === "authorized") {
          setDevice(null);
          setRepoMsg(null);
          await loadRepos();
          return;
        }
        if (data?.status === "expired" || data?.status === "denied" || data?.status === "error") {
          setDevice(null);
          setDeviceErr(
            data?.status === "denied"
              ? "Authorisation was cancelled on GitHub."
              : data?.error || "The code expired. Try again."
          );
          return;
        }
      } catch {
        /* a dropped poll must not kill the flow */
      }
      if (!stopped) timer = setTimeout(poll, device.interval * 1000);
    };
    timer = setTimeout(poll, device.interval * 1000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [device, deviceCancelled, loadRepos]);

  const filtered = useMemo(() => {
    const list = repos ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => (r.fullName + " " + (r.description ?? "")).toLowerCase().includes(q));
  }, [repos, query]);

  // A query with no local match asks the server: the list is capped, and
  // "No repositories found" for a repo the user owns is a lie.
  useEffect(() => {
    if (!open || tab !== "github" || connected !== true) return;
    const q = query.trim();
    if (q.length < 2 || filtered.length > 0) {
      setRemoteBusy(false);
      setRemoteMsg(null);
      return;
    }
    let live = true;
    setRemoteBusy(true);
    setRemoteMsg(null);
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/repos/github?q=${encodeURIComponent(q)}`);
        const data = await res.json().catch(() => ({}));
        if (!live) return;
        const hits = Array.isArray(data?.repos) ? (data.repos as GitHubRepo[]) : [];
        if (hits.length) {
          setRepos((prev) => {
            const seen = new Set((prev ?? []).map((r) => r.fullName));
            return [...(prev ?? []), ...hits.filter((h) => !seen.has(h.fullName))];
          });
        } else {
          setRemoteMsg("No repositories found");
        }
      } catch {
        if (live) setRemoteMsg("Could not search GitHub.");
      } finally {
        if (live) setRemoteBusy(false);
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, tab, connected, query, filtered.length]);

  const nameProblem = useMemo(() => {
    if (!name.trim()) return null; // empty is the muted-button state, not an error yet
    const problem = projectNameProblem(name);
    if (problem) return projectNameMessage(problem);
    const lower = name.trim().toLowerCase();
    if (projects.some((p) => p.toLowerCase() === lower)) {
      return `You already have a project called "${name.trim()}"`;
    }
    return null;
  }, [name, projects]);

  const chooseFolder = useCallback(async () => {
    const bridge = window.orplexDesktop;
    if (!bridge?.pickDirectory) {
      setError("Choosing a folder needs the desktop app.");
      return;
    }
    setFolderBusy(true);
    setError(null);
    try {
      const picked = await bridge.pickDirectory();
      if (!picked) return; // cancelled — silent
      const label = picked.split(/[\\/]/).filter(Boolean).pop() || picked;
      setParent({ path: picked, label });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the folder picker");
    } finally {
      setFolderBusy(false);
    }
  }, []);

  const close = useCallback(() => {
    if (busy) return;
    setDevice(null);
    setDeviceCancelled(true);
    resetInputs();
    onClose();
  }, [busy, onClose, resetInputs]);

  // Esc + focus trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const root = modalRef.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!open || typeof document === "undefined") return null;

  const submit = async () => {
    const problem = nameProblem ?? (name.trim() ? null : "Enter a project name");
    if (problem) {
      setError(problem);
      nameRef.current?.focus();
      return;
    }
    if (tab === "github" && !selected) {
      setError("Select a repository");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (tab === "scratch") {
        const res = await apiFetch("/api/projects/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), parent: parent?.path }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.success) {
          setError(data?.error || `Could not create the project (HTTP ${res.status})`);
          return;
        }
        await onCreated(String(data.path), String(data.name || name.trim()));
      } else {
        const repo = selected as GitHubRepo;
        const res = await apiFetch("/api/repos/clone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: repo.cloneUrl,
            branch: repo.defaultBranch,
            name: name.trim(),
            parent: parent?.path,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.success) {
          setError(data?.error || `Clone failed (HTTP ${res.status})`);
          return;
        }
        await onCreated(String(data.path), String(data.name || name.trim()));
      }
      setDevice(null);
      resetInputs();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const pickRepo = (repo: GitHubRepo) => {
    setSelected(repo);
    setError(null);
    if (!name.trim()) setName(repo.name);
  };

  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-repo]") ?? [])];
    if (rows.length === 0) return;
    const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? rows.length - 1
          : e.key === "ArrowDown"
            ? (idx + 1) % rows.length
            : (idx <= 0 ? rows.length : idx) - 1;
    rows[next].focus();
  };

  const ready = !!name.trim() && !nameProblem;
  const folderLabel = parent?.label ?? (defaultParent ? defaultParent.split(/[\\/]/).filter(Boolean).pop() || null : null);

  const modal = (
    <div
      ref={wrapRef}
      className={styles.wrap}
      onMouseDown={(e) => {
        if (e.target === wrapRef.current) close();
      }}
    >
      <div
        ref={modalRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="npm-title"
        aria-busy={busy}
      >
        <div className={styles.modalHead}>
          <h2 id="npm-title">New project</h2>
          <button type="button" className={styles.close} onClick={close} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            className={styles.tab}
            role="tab"
            id="npm-tab-scratch"
            aria-selected={tab === "scratch"}
            aria-controls="npm-panel-scratch"
            onClick={() => setTab("scratch")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            From scratch
          </button>
          <button
            type="button"
            className={styles.tab}
            role="tab"
            id="npm-tab-github"
            aria-selected={tab === "github"}
            aria-controls="npm-panel-github"
            onClick={() => setTab("github")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
            </svg>
            GitHub
          </button>
        </div>

        <input
          ref={nameRef}
          className={styles.input}
          type="text"
          placeholder="Project name"
          autoComplete="off"
          value={name}
          maxLength={MAX_PROJECT_NAME + 10}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          aria-invalid={!!nameProblem}
          aria-describedby={error ? "npm-error" : undefined}
        />
        {nameProblem && !error ? <p className={styles.errorLine}>{nameProblem}</p> : null}
        {error ? (
          <p className={styles.errorLine} id="npm-error" role="alert">
            {error}
          </p>
        ) : null}

        <div
          className={`${styles.panel} ${tab === "scratch" ? styles.panelActive : ""}`}
          id="npm-panel-scratch"
          role="tabpanel"
          aria-labelledby="npm-tab-scratch"
        >
          <button type="button" className={styles.folderBtn} onClick={() => void chooseFolder()} disabled={folderBusy}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
            </svg>
            Choose folder
            <span className={styles.folderName}>{folderBusy ? "Opening…" : folderLabel ?? ""}</span>
          </button>
        </div>

        <div
          className={`${styles.panel} ${tab === "github" ? styles.panelActive : ""}`}
          id="npm-panel-github"
          role="tabpanel"
          aria-labelledby="npm-tab-github"
        >
          {device ? (
            <div className={styles.box}>
              <p>Enter this code at github.com/login/device to connect your account.</p>
              <div className={styles.codeRow}>
                <span className={styles.code}>{device.userCode}</span>
              </div>
              <button
                type="button"
                className={styles.btnAccent}
                onClick={() => openExternal(device.verificationUri)}
              >
                Open github.com/login/device
              </button>
              <p className={styles.hint}>Waiting for GitHub to approve…</p>
            </div>
          ) : connected === false || connected === null ? (
            <div className={styles.box}>
              <p>Connect GitHub to start a project from your repository.</p>
              <button type="button" className={styles.btnAccent} onClick={() => void connectGitHub()} disabled={deviceBusy}>
                {deviceBusy ? "Connecting…" : "Connect GitHub"}
              </button>
              {deviceErr ? (
                <>
                  <p className={styles.errorLine} style={{ marginTop: 12, marginBottom: 8 }}>
                    {deviceErr}
                  </p>
                  <button
                    type="button"
                    className={styles.retry}
                    onClick={() => startMediatorSignIn("github", "/")}
                  >
                    Use browser sign-in instead
                  </button>
                </>
              ) : null}
            </div>
          ) : needsInstall ? (
            <div className={styles.box}>
              <p>GitHub authorised the app, but it is not installed on any repository yet.</p>
              <button
                type="button"
                className={styles.btnAccent}
                onClick={() => openExternal(installUrl || "https://github.com/settings/installations")}
              >
                Install the app on your repositories
              </button>
              <p className={styles.hint}>
                <button type="button" className={styles.retry} onClick={() => void loadRepos()}>
                  I installed it — refresh
                </button>
              </p>
            </div>
          ) : (
            <div className={`${styles.box} ${styles.boxRepos}`}>
              <input
                className={`${styles.input} ${styles.inputSearch}`}
                type="text"
                placeholder="Search owner/repository"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search repositories"
              />
              <div
                className={styles.repoList}
                ref={listRef}
                role="listbox"
                aria-label={login ? `${login} repositories` : "Repositories"}
                onKeyDown={onListKey}
              >
                {repos === null ? (
                  <div className={styles.repoEmpty}>Loading repositories…</div>
                ) : repoMsg && filtered.length === 0 ? (
                  <div className={styles.repoEmptyStack}>
                    <span>{repoMsg}</span>
                    <button type="button" className={styles.retry} onClick={() => void loadRepos()}>
                      Retry
                    </button>
                  </div>
                ) : remoteBusy && filtered.length === 0 ? (
                  <div className={styles.repoEmpty}>Searching GitHub…</div>
                ) : filtered.length === 0 ? (
                  <div className={styles.repoEmpty}>{remoteMsg ?? "No repositories found"}</div>
                ) : (
                  filtered.map((repo) => (
                    <button
                      key={repo.fullName}
                      type="button"
                      data-repo
                      className={styles.repo}
                      role="option"
                      aria-selected={selected?.fullName === repo.fullName}
                      onClick={() => pickRepo(repo)}
                    >
                      <span className={styles.repoName}>{repo.fullName}</span>
                      {repo.private ? <span className={styles.repoTag}>Private</span> : null}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className={styles.foot}>
          <button
            type="button"
            className={`${styles.btnCreate} ${ready ? styles.ready : ""}`}
            onClick={() => void submit()}
            disabled={busy}
            aria-disabled={!ready}
          >
            {busy ? (tab === "github" ? "Cloning…" : "Creating…") : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
