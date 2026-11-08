/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import styles from "./UpdateCard.module.css";
import {
  useUpdateStore,
  applyStatus,
  setCurrentVersion,
  markDoneIfNeeded,
  checkForUpdates,
  downloadUpdate,
  cancelDownload,
  dismiss,
  defer,
  installUpdate,
  clearDone,
  type DesktopBridge,
  type UpdateStatusPayload,
} from "@/lib/update/updateStore";
import { parseReleaseNotes } from "@/lib/update/parseReleaseNotes";
import {
  formatMB,
  formatSpeed,
  formatEta,
  bytesToMB,
} from "@/lib/update/formatters";

const spring = { type: "spring", stiffness: 380, damping: 30 } as const;

const LOGO = "/orplex-logo.svg";

function Icon({ phase }: { phase: string }) {
  const ok = phase === "ready" || phase === "done";
  return (
    <motion.div
      className={styles.ico}
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={spring}
    >
      <img src={LOGO} alt="Orplex Code" width={44} height={44} />
      <AnimatePresence mode="wait">
        <motion.div
          key={phase}
          className={`${styles.badge} ${ok ? styles.ok : ""} ${phase === "error" ? styles.errorBadge : ""}`}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          exit={{ scale: 0 }}
          transition={spring}
        >
          {phase === "installing" ? (
            <div className={styles.spin} />
          ) : ok ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3.2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <motion.path
                d="M5 12.5l4.5 4.5L19 7.5"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.5, delay: 0.1 }}
              />
            </svg>
          ) : phase === "downloading" ? (
            <motion.div
              style={{ display: "grid" }}
              animate={{ y: [-1.5, 2, -1.5] }}
              transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut" }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v13m0 0l-5-5m5 5l5-5" />
              </svg>
            </motion.div>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5m0 0l-6 6m6-6l6 6" />
            </svg>
          )}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

export default function UpdateCard() {
  const state = useUpdateStore();

  useEffect(() => {
    const b = (window as DesktopBridge & { orplexDesktop?: DesktopBridge }).orplexDesktop;
    if (b?.getAppVersion) {
      b.getAppVersion().then((v: string) => {
        setCurrentVersion(v);
        markDoneIfNeeded(v);
      }).catch(() => {});
    }
    const off = b?.updates?.onStatus?.((payload: UpdateStatusPayload) => {
      applyStatus(payload);
    });
    const onForce = () => {
      void checkForUpdates(true);
    };
    window.addEventListener("orplex:force-update", onForce);
    // Dev-only QA harness: lazy import so it tree-shakes out of production.
    if (process.env.NODE_ENV !== "production") {
      void import("@/lib/update/devSimulator").then((m) => m.startDevSimulator());
    }
    return () => {
      off?.();
      window.removeEventListener("orplex:force-update", onForce);
    };
  }, []);

  const phase = state.phase;
  const visible = phase !== "idle";
  const changes = useMemo(() => parseReleaseNotes(state.notes), [state.notes]);

  const sizePart = state.total ? `${formatMB(state.total)} MB` : "";
  const titles: Record<string, [string, string]> = {
    available: ["Update available", `Orplex v${state.version ?? ""}${sizePart ? ` · ${sizePart}` : ""}`],
    downloading: ["Downloading Orplex v" + (state.version ?? ""), "Fetching update in the background"],
    ready: ["Ready to install", `v${state.currentVersion ?? ""} → v${state.version ?? ""}`],
    installing: ["Installing update…", "Restarting Orplex"],
    done: [`You’re on v${state.version ?? ""}`, "Update installed successfully"],
    error: ["Update failed", state.error ?? "update failed"],
  };

  const [title, sub] = titles[phase] ?? ["", ""];

  const hide = () => {
    if (phase === "installing") return;
    dismiss();
  };

  const handleDownload = () => {
    void downloadUpdate();
  };
  const handleCancel = () => {
    void cancelDownload();
  };
  const handleLater = () => {
    void defer();
    dismiss();
  };
  const handleInstall = () => {
    void installUpdate();
  };
  const handleDismissError = () => {
    dismiss();
  };
  const handleRetry = () => {
    void checkForUpdates(true);
  };
  const handleDone = () => {
    clearDone();
  };

  const speedMB = bytesToMB(state.speedBps);
  const etaSeconds = speedMB > 0 ? (state.total - state.transferred) / state.speedBps : 0;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="dock"
          className={styles.cardWrap}
          initial={{ opacity: 0, y: 40, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 30, scale: 0.96 }}
          transition={spring}
        >
          <motion.div className={styles.card} layout transition={spring} role="status" aria-live="polite">
            <div className={styles.row}>
              <Icon phase={phase} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <motion.div
                  key={phase + "t"}
                  className={styles.ttl}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  {title}
                </motion.div>
                <div className={styles.sub}>{sub}</div>
              </div>
              {phase === "downloading" ? (
                <button
                  className={styles.btn}
                  style={{ flex: "none", marginLeft: "auto", padding: "7px 12px", fontSize: 12 }}
                  onClick={handleCancel}
                >
                  Cancel
                </button>
              ) : phase !== "installing" ? (
                <button className={styles.x} aria-label="Dismiss" onClick={hide}>
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              ) : null}
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={phase}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18 }}
                className={styles.body}
              >
                {phase === "available" && (
                  <>
                    {changes.length > 0 && (
                      <ul className={styles.log}>
                        {changes.map((c, i) => (
                          <motion.li
                            key={i}
                            initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.08 * i + 0.1 }}
                          >
                            <span className={`${styles.tag} ${c.tag === "fix" ? styles.fix : ""}`}>
                              {c.tag === "new" ? "new" : "fix"}
                            </span>
                            {c.text}
                          </motion.li>
                        ))}
                      </ul>
                    )}
                    <div className={styles.btns}>
                      <button className={styles.btn} onClick={handleLater}>Later</button>
                      <motion.button
                        className={`${styles.btn} ${styles.p}`}
                        whileTap={{ scale: 0.97 }}
                        whileHover={{ scale: 1.02 }}
                        onClick={handleDownload}
                      >
                        Download update
                      </motion.button>
                    </div>
                  </>
                )}

                {phase === "downloading" && (
                  <>
                    <div className={styles.bar}>
                      <motion.div
                        className={styles.fill}
                        animate={{ width: `${Math.max(0, Math.min(100, state.percent))}%` }}
                        transition={{ ease: "linear", duration: 0.15 }}
                      />
                    </div>
                    <div className={styles.stats}>
                      <div className={styles.pct}>
                        {Math.floor(state.percent)}
                        <small>%</small>
                      </div>
                      <div className={styles.meta}>
                        <b>{formatMB(state.transferred)}</b> / {formatMB(state.total)} MB
                        <br />
                        {formatSpeed(state.speedBps)} MB/s · <b>{formatEta(etaSeconds)}</b> left
                      </div>
                    </div>
                  </>
                )}

                {phase === "ready" && (
                  <>
                    <p className={styles.sub} style={{ marginTop: 0, lineHeight: 1.6 }}>
                      Download verified. Restart Orplex to finish updating — your chats and agents will be restored.
                    </p>
                    <div className={styles.btns}>
                      <button className={styles.btn} onClick={handleLater}>Later</button>
                      <motion.button
                        className={`${styles.btn} ${styles.p}`}
                        whileTap={{ scale: 0.97 }}
                        whileHover={{ scale: 1.02 }}
                        onClick={handleInstall}
                      >
                        Restart &amp; install
                      </motion.button>
                    </div>
                  </>
                )}

                {phase === "installing" && (
                  <>
                    <div className={styles.bar}>
                      <motion.div
                        className={styles.ind}
                        animate={{ left: ["-35%", "100%"] }}
                        transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut" }}
                      />
                    </div>
                    <p className={styles.sub} style={{ marginTop: 12 }}>Please don’t close the app…</p>
                  </>
                )}

                {phase === "done" && (
                  <>
                    <div className={styles.burst}>
                      {Array.from({ length: 14 }).map((_, i) => {
                        const a = (i * (360 / 14) * Math.PI) / 180;
                        return (
                          <motion.span
                            key={i}
                            className={styles.dot}
                            style={{ background: i % 2 ? "var(--accent)" : "var(--ok)" }}
                            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
                            animate={{ x: Math.cos(a) * 90, y: Math.sin(a) * 90 - 40, opacity: 0, scale: 0.3 }}
                            transition={{ duration: 0.9, ease: "easeOut" }}
                          />
                        );
                      })}
                    </div>
                    <div className={styles.btns} style={{ marginTop: 0 }}>
                      <motion.button
                        className={`${styles.btn} ${styles.p}`}
                        whileTap={{ scale: 0.97 }}
                        onClick={handleDone}
                      >
                        Let’s go
                      </motion.button>
                    </div>
                  </>
                )}

                {phase === "error" && (
                  <>
                    <p className={styles.sub} style={{ marginTop: 0, lineHeight: 1.6 }}>{state.error}</p>
                    <div className={styles.btns}>
                      <button className={styles.btn} onClick={handleDismissError}>Dismiss</button>
                      <motion.button
                        className={`${styles.btn} ${styles.p}`}
                        whileTap={{ scale: 0.97 }}
                        whileHover={{ scale: 1.02 }}
                        onClick={handleRetry}
                      >
                        Try again
                      </motion.button>
                    </div>
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}