import { useEffect, useState } from "react";
import { consumeOpenRoleHelp, helpDocPath, helpDocTitle } from "../help/roleHelp";
import { renderMarkdown } from "../help/renderMarkdown";
import type { Role } from "../types";

export function RoleHelpDialog({
  role,
  open,
  onClose,
}: {
  role: Role | string | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const path = helpDocPath(role);
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(path)
      .then((res) => {
        if (!res.ok) throw new Error("说明文档加载失败");
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setMarkdown(text);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "说明文档加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, role]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="help-overlay" onClick={onClose} role="presentation">
      <div
        className="help-dialog card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="role-help-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="help-dialog-head">
          <h2 id="role-help-title">{helpDocTitle(role)}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="help-dialog-body">
          {loading && <p className="muted">正在加载使用说明…</p>}
          {error && <p className="error">{error}</p>}
          {!loading && !error && renderMarkdown(markdown)}
        </div>
        <footer className="help-dialog-foot">
          <button type="button" onClick={onClose}>
            我知道了
          </button>
        </footer>
      </div>
    </div>
  );
}

export function useRoleHelpAutoOpen(role: Role | string | undefined) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!role) return;
    if (consumeOpenRoleHelp()) setOpen(true);
  }, [role]);

  return { open, setOpen };
}
