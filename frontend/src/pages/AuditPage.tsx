import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import type { AuditLogRow } from "../types";

const ACTION_LABEL: Record<string, string> = {
  upload: "上传",
  replace: "替换",
  skip: "跳过",
  fail: "失败",
  delete: "删除",
  rename: "重命名",
  annotate: "标注",
  login: "登录",
  login_failed: "登录失败",
  download: "下载",
  view: "查看",
  change_password: "修改密码",
  impersonate: "进入视角",
  stop_impersonate: "退出视角",
  create: "新建",
  update: "修改",
  renumber: "重编号",
  restore: "恢复",
  reorder: "调整顺序",
};

function actionLabel(action: string) {
  return ACTION_LABEL[action] || action;
}

function detailText(detail: Record<string, unknown>) {
  const query =
    detail.query && typeof detail.query === "object"
      ? (detail.query as Record<string, unknown>)
      : null;
  const target =
    query?.path ||
    (typeof detail.path === "string" && detail.path.startsWith("/api/") ? "" : detail.path) ||
    detail.name ||
    detail.username;
  const parts = [
    detail.batch,
    detail.file_version,
    detail.unit_name,
    target,
    detail.detail,
  ]
    .map((item) => (item == null ? "" : String(item).trim()))
    .filter(Boolean);
  if (parts.length) return parts.join(" · ");
  if (detail.method && detail.path) {
    const status = detail.status != null ? ` ${detail.status}` : "";
    return `${detail.method} ${detail.path}${status}`;
  }
  const text = JSON.stringify(detail);
  return text === "{}" ? "" : text;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function AuditPage() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError("");
    api
      .listAuditLogs(query, offset)
      .then((items) => {
        if (cancel) return;
        setRows((current) => (offset === 0 ? items : [...current, ...items]));
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : "加载失败");
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [query, offset]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    setRows([]);
    setOffset(0);
    setQuery(q.trim());
  };

  return (
    <div className="page stack">
      <p className="muted" style={{ margin: 0 }}>
        每个用户的每次操作单独记一条。目录刷新和在线心跳不记。批量上传、删除、下载按每个文件或数据单元各记一条。
      </p>
      <form className="row" onSubmit={search} style={{ gap: 8 }}>
        <label style={{ flex: 1 }}>
          搜索用户、动作或路径
          <input value={q} onChange={(event) => setQ(event.target.value)} />
        </label>
        <button type="submit" style={{ alignSelf: "end" }}>
          搜索
        </button>
      </form>
      {error && <div className="error">{error}</div>}
      <table className="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>用户</th>
            <th>操作</th>
            <th>对象</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{formatTime(row.created_at)}</td>
              <td>{row.username || (row.user_id ? `#${row.user_id}` : "未知")}</td>
              <td>{actionLabel(row.action)}</td>
              <td className="audit-detail">{detailText(row.detail || {})}</td>
            </tr>
          ))}
          {!loading && !rows.length && (
            <tr>
              <td colSpan={4} className="muted">
                还没有操作记录
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {rows.length > 0 && rows.length % 200 === 0 && (
        <button type="button" className="secondary" disabled={loading} onClick={() => setOffset(rows.length)}>
          {loading ? "加载中…" : "更早的记录"}
        </button>
      )}
    </div>
  );
}
