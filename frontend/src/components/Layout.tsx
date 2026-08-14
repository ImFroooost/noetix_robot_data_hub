import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth";
import { ROLE_LABEL } from "../types";

export function Layout() {
  const { user, logout, canEdit, isAdmin } = useAuth();
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">Noetix Robot Data Hub</div>
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : undefined)}>
            浏览
          </NavLink>
          {canEdit && (
            <NavLink to="/upload" className={({ isActive }) => (isActive ? "active" : undefined)}>
              上传
            </NavLink>
          )}
          <NavLink to="/hub" className={({ isActive }) => (isActive ? "active" : undefined)}>
            维度仓库
          </NavLink>
          <NavLink to="/taxonomies" className={({ isActive }) => (isActive ? "active" : undefined)}>
            分类管理
          </NavLink>
          <NavLink to="/robots" className={({ isActive }) => (isActive ? "active" : undefined)}>
            机器人型号
          </NavLink>
          {isAdmin && (
            <NavLink to="/users" className={({ isActive }) => (isActive ? "active" : undefined)}>
              用户管理
            </NavLink>
          )}
        </nav>
        <div className="user-chip">
          {user?.username}（{user ? ROLE_LABEL[user.role] : ""}）
        </div>
        <button className="secondary" onClick={logout}>
          退出
        </button>
      </header>
      <Outlet />
    </div>
  );
}
