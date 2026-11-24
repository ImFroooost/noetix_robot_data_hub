import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import type { TrashEntry } from "../types";

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = units[0];
  for (let index = 0; index < units.length; index += 1) {
    unit = units[index];
    if (value < 1024 || index === units.length - 1) break;
    value /= 1024;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function TrashPage() {
  const { hasPerm } = useAuth();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.storageTrash();
      setEntries(data.entries || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "回收站加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasPerm("manage_data")) void load();
  }, [hasPerm, load]);

  if (!hasPerm("manage_data")) {
    return <div className="page muted">需要数据管理权限才能查看回收站。</div>;
  }

  const restore = async (entry: TrashEntry) => {
    if (!window.confirm(`恢复「${entry.label}」中的 ${entry.file_count} 个文件？`)) return;
    setBusyId(entry.id);
    setError("");
    setMessage("");
    try {
      const result = await api.storageRestoreTrash(entry.id);
      const conflicts = result.conflicts?.length || 0;
      setMessage(
        conflicts
          ? `已恢复 ${result.restored.length} 个文件，${conflicts} 个因原位置已有文件而留在回收站。`
          : `已恢复 ${result.restored.length} 个文件。`
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "恢复失败");
    } finally {
      setBusyId("");
    }
  };

  const purge = async (entry: TrashEntry) => {
    if (!window.confirm(`永久删除「${entry.label}」中的 ${entry.file_count} 个文件？此操作不能恢复。`)) {
      return;
    }
    setBusyId(entry.id);
    setError("");
    setMessage("");
    try {
      await api.storagePurgeTrash(entry.id);
      setMessage("已永久删除。");
      if (openId === entry.id) setOpenId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "永久删除失败");
    } finally {
      setBusyId("");
    }
  };

  const empty = async () => {
    if (!entries.length) return;
    const count = entries.reduce((sum, entry) => sum + entry.file_count, 0);
    if (!window.confirm(`永久删除回收站中的 ${count} 个文件？此操作不能恢复。`)) return;
    setBusyId("*");
    setError("");
    setMessage("");
    try {
      await api.storageEmptyTrash();
      setMessage("回收站已清空。");
      setOpenId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "清空失败");
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="page stack trash-page">
      <p className="muted" style={{ margin: 0 }}>
        数据管理里删除的文件会先留在这里。恢复后回到原来的批次和数据单元；永久删除后不能再找回。
        筛选后删除时，只有当时筛选到的文件会进来。
      </p>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="secondary" disabled={loading || busyId === "*"} onClick={() => void load()}>
          {loading ? "刷新中…" : "刷新"}
        </button>
        <button type="button" className="danger" disabled={!entries.length || !!busyId} onClick={() => void empty()}>
          清空回收站
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}
      {!loading && !entries.length && <div className="card muted">回收站是空的。</div>}
      {entries.map((entry) => {
        const open = openId === entry.id;
        const shown = open ? entry.files.slice(0, 40) : [];
        return (
          <article className="card stack" key={entry.id}>
            <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <strong>{entry.label}</strong>
                <div className="muted">
                  {formatTime(entry.deleted_at)}
                  {entry.deleted_by?.username ? ` · ${entry.deleted_by.username}` : ""}
                  {` · ${entry.file_count} 个文件 · ${formatBytes(entry.bytes)}`}
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="secondary" onClick={() => setOpenId(open ? null : entry.id)}>
                  {open ? "收起" : "查看文件"}
                </button>
                <button type="button" disabled={!!busyId} onClick={() => void restore(entry)}>
                  {busyId === entry.id ? "处理中…" : "恢复"}
                </button>
                <button type="button" className="danger" disabled={!!busyId} onClick={() => void purge(entry)}>
                  永久删除
                </button>
              </div>
            </div>
            {open && (
              <ul className="trash-files">
                {shown.map((file) => (
                  <li key={file.path}>
                    <span>{file.ontology === "human" ? "人体" : file.ontology === "robot" ? "机器人" : file.ontology}</span>
                    <code>{file.path}</code>
                  </li>
                ))}
                {entry.files.length > shown.length && (
                  <li className="muted">还有 {entry.files.length - shown.length} 个文件</li>
                )}
              </ul>
            )}
          </article>
        );
      })}
    </div>
  );
}
