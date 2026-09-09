import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { ThemeToggle } from "../theme";
import { IndexRefreshControl } from "./IndexRefreshControl";
import { RoleHelpDialog, useRoleHelpAutoOpen } from "./RoleHelpDialog";
import { PreviewProvider } from "../preview/PreviewContext";
import { ROLE_LABEL } from "../types";
import type { User } from "../types";

export function Layout() {
  const { user, logout, hasPerm, impersonating, impersonate, stopImpersonate } = useAuth();
  const nav = useNavigate();
  const [targets, setTargets] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const { open: helpOpen, setOpen: setHelpOpen } = useRoleHelpAutoOpen(user?.role);

  useEffect(() => {
    if (!impersonating) {
      setTargets([]);
      return;
    }
    api
      .impersonationTargets()
      .then(setTargets)
      .catch(() => undefined);
  }, [impersonating, user?.id]);

  const switchTo = async (userId: number) => {
    if (!user || userId === user.id) return;
    setBusy(true);
    try {
      await impersonate(userId);
      nav("/", { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const exitView = async () => {
    setBusy(true);
    try {
      await stopImpersonate();
      nav("/users", { replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <div className="app-chrome">
        {impersonating && user?.impersonated_by && (
          <div className="impersonate-bar">
            <span>
              正在以 <strong>{user.username}</strong>
              （{ROLE_LABEL[user.role] || user.role}）的视角查看
              {user.is_active ? "" : " · 该账号已禁用"}
              ，实际登录为 {user.impersonated_by.username}
            </span>
            <label className="impersonate-switch">
              切换到
              <select
                disabled={busy}
                value={user.id}
                onChange={(e) => void switchTo(Number(e.target.value))}
              >
                {targets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.username}（{ROLE_LABEL[item.role] || item.role}）
                    {item.is_active ? "" : " ·已禁用"}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="secondary" disabled={busy} onClick={() => void exitView()}>
              {busy ? "切换中…" : "退出视角"}
            </button>
          </div>
        )}
        <header className="topbar">
          <div className="brand">Noetix Robot Data Hub</div>
          <nav className="nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : undefined)}>
              浏览
            </NavLink>
            {hasPerm("upload") && (
              <NavLink to="/upload" className={({ isActive }) => (isActive ? "active" : undefined)}>
                上传
              </NavLink>
            )}
            {hasPerm("annotate") && (
              <NavLink to="/annotate" className={({ isActive }) => (isActive ? "active" : undefined)}>
                标注
              </NavLink>
            )}
            {hasPerm("manage_data") && (
              <NavLink to="/manage" className={({ isActive }) => (isActive ? "active" : undefined)}>
                数据管理
              </NavLink>
            )}
            {hasPerm("manage_data") && (
              <NavLink to="/taxonomies" className={({ isActive }) => (isActive ? "active" : undefined)}>
                分类管理
              </NavLink>
            )}
            <NavLink to="/robots" className={({ isActive }) => (isActive ? "active" : undefined)}>
              3D模型管理
            </NavLink>
            {hasPerm("manage_users") && (
              <NavLink to="/users" className={({ isActive }) => (isActive ? "active" : undefined)}>
                用户管理
              </NavLink>
            )}
          </nav>
          <div className="user-chip">
            {user?.username}（{user ? ROLE_LABEL[user.role] || user.role : ""}）
            {impersonating ? " ·视角" : ""}
          </div>
          <ThemeToggle />
          <IndexRefreshControl />
          <button
            type="button"
            className="secondary help-trigger"
            onClick={() => setHelpOpen(true)}
          >
            使用说明
          </button>
          <button className="secondary" onClick={logout}>
            退出
          </button>
        </header>
      </div>
      <PreviewProvider>
        <Outlet />
      </PreviewProvider>
      <RoleHelpDialog
        role={user?.role}
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
      />
    </div>
  );
}
