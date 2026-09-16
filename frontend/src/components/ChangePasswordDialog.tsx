import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";

export function ChangePasswordDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!open) {
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
      setError("");
      setMsg("");
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setError("");
    setMsg("");
    if (!oldPw) {
      setError("请输入原密码");
      return;
    }
    if (newPw.length < 4) {
      setError("新密码至少 4 位");
      return;
    }
    if (newPw !== confirmPw) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(oldPw, newPw);
      setMsg("密码已修改，下次登录请使用新密码");
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "修改失败");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="storage-modal-backdrop" onClick={onClose}>
      <div
        className="storage-modal card stack"
        style={{ maxWidth: 380, gap: 12 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0 }}>修改密码</h3>
        {error && <div className="error">{error}</div>}
        {msg && <div className="success">{msg}</div>}
        <label>
          原密码
          <input
            type="password"
            value={oldPw}
            autoFocus
            onChange={(e) => setOldPw(e.target.value)}
          />
        </label>
        <label>
          新密码（至少 4 位）
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
          />
        </label>
        <label>
          确认新密码
          <input
            type="password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="secondary" onClick={onClose}>
            {msg ? "关闭" : "取消"}
          </button>
          {!msg && (
            <button type="button" disabled={busy} onClick={() => void submit()}>
              {busy ? "提交中…" : "确认修改"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
