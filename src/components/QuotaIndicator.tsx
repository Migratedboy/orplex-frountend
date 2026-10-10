"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api-base";

export default function QuotaIndicator() {
  const [quota, setQuota] = useState<{ remaining: number; limit: number } | null>(null);

  useEffect(() => {
    apiFetch("/api/user/quota")
      .then(r => r.json())
      .then(data => setQuota(data))
      .catch(() => {});
  }, []);

  if (!quota) return null;

  const used = quota.limit - quota.remaining;
  const percent = quota.limit > 0 ? (used / quota.limit) * 100 : 0;
  // Thresholds: amber warns at 80%, red only becomes urgent at 95%.
  const fill = percent >= 95 ? "#ef4444" : percent >= 80 ? "#f59e0b" : "#22c55e";

  return (
    <div className="quota-indicator">
      <span className="quota-text">{used}/{quota.limit} requests today</span>
      <div className="quota-bar" role="meter" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label="Daily request usage">
        <div className="quota-fill" style={{ width: `${Math.min(100, percent)}%`, background: fill }} />
      </div>
    </div>
  );
}
