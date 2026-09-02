"use client";

import { useState, useEffect } from "react";

export default function QuotaIndicator() {
  const [quota, setQuota] = useState<{ remaining: number; limit: number } | null>(null);

  useEffect(() => {
    fetch("/api/user/quota")
      .then(r => r.json())
      .then(data => setQuota(data))
      .catch(() => {});
  }, []);

  if (!quota) return null;

  const used = quota.limit - quota.remaining;
  const percent = (used / quota.limit) * 100;

  return (
    <div className="quota-indicator">
      <div className="quota-bar">
        <div className="quota-fill" style={{ width: `${percent}%`, background: percent > 80 ? "#ef4444" : percent > 50 ? "#f59e0b" : "#22c55e" }} />
      </div>
      <span className="quota-text">{used}/{quota.limit} requests today</span>
    </div>
  );
}
