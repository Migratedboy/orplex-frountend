"use client";

/**
 * PermissionsTab — the Settings list of "Always allow" command rules.
 *
 * Reads the same store the approval card writes (src/lib/approval-rules.ts), so
 * a rule added from the card shows up here immediately and Remove really
 * deletes it (the next matching command shows the card again).
 */
import { useCallback, useEffect, useState } from "react";
import { listRules, removeRule, subscribeRules, type AlwaysAllowRule } from "@/lib/approval-rules";
import { useToast } from "@/components/Toast";

function formatAdded(addedAt: number): string {
  try {
    return new Date(addedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

export function PermissionsTab() {
  const { toast } = useToast();
  const [rules, setRules] = useState<AlwaysAllowRule[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => setRules(listRules()), []);

  useEffect(() => {
    load();
    return subscribeRules(load);
  }, [load]);

  const remove = (rule: AlwaysAllowRule) => {
    try {
      removeRule(rule.command, rule.workspace);
      setError(null);
      setRules(listRules());
      toast("Allow rule removed", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the allow rule.");
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h2 className="settings-section-title">Permissions</h2>
        <p className="settings-section-desc">
          Commands you chose to Always allow. Each rule applies to one exact command in one workspace;
          removing it brings the approval card back.
        </p>
      </div>

      <div className="settings-card">
        {rules.length === 0 ? (
          <p className="settings-hint" style={{ margin: 0 }}>
            No commands are always allowed. Approve a command with “Always allow” to add one here.
          </p>
        ) : (
          <ul className="perm-list">
            {rules.map((rule) => (
              <li className="perm-row" key={`${rule.workspace}::${rule.command}`}>
                <div className="perm-main">
                  <code className="perm-command" title={rule.command}>{rule.command}</code>
                  <span className="perm-meta">
                    <span className="perm-workspace" title={rule.workspace}>{rule.workspace}</span>
                    <span className="perm-sep" aria-hidden="true">·</span>
                    <span>Added {formatAdded(rule.addedAt)}</span>
                  </span>
                </div>
                <button
                  type="button"
                  className="settings-save-btn perm-remove"
                  onClick={() => remove(rule)}
                  aria-label={`Remove always-allow rule for ${rule.command} in ${rule.workspace}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {error ? <p className="settings-hint perm-error" role="alert">{error}</p> : null}
      </div>
    </div>
  );
}

export default PermissionsTab;
