import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { notifyIndexUpdated } from "../storageOverviewCache";
import type { CatalogRebuildStatus } from "../types";

function formatStats(status: CatalogRebuildStatus) {
  const stats = status.stats;
  if (!stats) return "";
  const parts: string[] = [];
  if (stats.file_count != null) parts.push(`数据文件 ${stats.file_count}`);
  if (stats.unit_count != null) parts.push(`数据单元 ${stats.unit_count}`);
  if (stats.model_instance_count != null) {
    parts.push(`模型实例 ${stats.model_instance_count}`);
  }
  if (stats.model_file_count != null) parts.push(`模型文件 ${stats.model_file_count}`);
  return parts.join(" · ");
}

export function IndexRefreshControl({ className = "btn-primary" }: { className?: string }) {
  const [status, setStatus] = useState<CatalogRebuildStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const watching = useRef(false);
  const completedFor = useRef<string | null>(null);
  const timer = useRef<number>();

  const applyStatus = (next: CatalogRebuildStatus, notifyDone: boolean) => {
    if (!mounted.current) return;
    setStatus(next);
    if (next.status === "running") {
      setOpen(true);
      setError("");
      return;
    }
    if (next.status === "error") {
      setOpen(true);
      setError(next.error || next.message || "索引更新失败");
      watching.current = false;
      return;
    }
    if (next.status === "done" && notifyDone) {
      const token = next.finished_at || next.started_at || "done";
      if (completedFor.current !== token) {
        completedFor.current = token;
        notifyIndexUpdated();
      }
      setOpen(true);
      setError("");
      watching.current = false;
    }
  };

  const stopPolling = () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  };

  const pollOnce = async () => {
    try {
      const next = await api.storageRescanStatus();
      applyStatus(next, watching.current);
      if (next.status === "running" && mounted.current) {
        timer.current = window.setTimeout(() => void pollOnce(), 400);
      }
    } catch {
      if (watching.current && mounted.current) {
        timer.current = window.setTimeout(() => void pollOnce(), 800);
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    api
      .storageRescanStatus()
      .then((next) => {
        if (!mounted.current) return;
        if (next.status === "running") {
          watching.current = true;
          applyStatus(next, false);
          void pollOnce();
        }
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
      stopPolling();
    };
  }, []);

  const startRefresh = async () => {
    setError("");
    setOpen(true);
    watching.current = true;
    stopPolling();
    try {
      const next = await api.storageRescan();
      applyStatus(next, false);
    } catch (e) {
      watching.current = false;
      setError(e instanceof Error ? e.message : "无法开始更新索引");
      return;
    }
    void pollOnce();
  };

  const running = status?.status === "running";
  const done = status?.status === "done";
  const failed = status?.status === "error" || Boolean(error);
  const percent = Math.max(0, Math.min(100, status?.percent ?? 0));
  const statsText = status && done ? formatStats(status) : "";

  useEffect(() => {
    if (!open || running) return;
    const fadeTimer = window.setTimeout(() => setOpen(false), 4000);
    return () => window.clearTimeout(fadeTimer);
  }, [open, running, done, failed]);

  useEffect(() => {
    if (!open || running) return;
    const onAwayClick = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (panel && !panel.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onAwayClick);
    return () => window.removeEventListener("mousedown", onAwayClick);
  }, [open, running]);

  const panelRef = useRef<HTMLDivElement>(null);

  return (
    <div className="index-refresh">
      <button
        type="button"
        className={className}
        disabled={running}
        onClick={() => void startRefresh()}
      >
        {running ? "更新中…" : "更新索引"}
      </button>
      {open && (running || done || failed) && (
        <div
          ref={panelRef}
          className={`index-refresh-panel${failed ? " is-error" : ""}${done && !failed ? " is-done" : ""}`}
          role="status"
        >
          <div className="index-refresh-head">
            <strong>
              {failed ? "索引更新失败" : done ? "索引已更新" : "正在更新索引"}
            </strong>
            <button
              type="button"
              className="index-refresh-close"
              onClick={() => setOpen(false)}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <p>{error || status?.message || (running ? "正在扫描本地数据…" : "")}</p>
          {running && (
            <div
              className="index-refresh-bar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span style={{ width: `${percent}%` }} />
            </div>
          )}
          {running && <div className="index-refresh-percent">{percent}%</div>}
          {done && !failed && statsText && <p className="index-refresh-stats">{statsText}</p>}
        </div>
      )}
    </div>
  );
}
