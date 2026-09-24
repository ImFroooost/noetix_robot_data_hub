import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { subscribeLoading } from "../loadingState";
import { ThemeToggle } from "../theme";
import { IndexRefreshControl } from "./IndexRefreshControl";
import { RoleHelpDialog, useRoleHelpAutoOpen } from "./RoleHelpDialog";
import { PreviewProvider } from "../preview/PreviewContext";
import { HistoryButtons, UndoProvider } from "../undo/UndoContext";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { ROLE_LABEL } from "../types";
import type { User } from "../types";

const SIDEBAR_KEY = "hub-sidebar-collapsed";

const PAGES: Record<string, { title: string; subtitle: string }> = {
  "/": { title: "浏览", subtitle: "按批次、分类和上传记录查找数据" },
  "/?mode=upload": { title: "上传", subtitle: "导入文件夹或压缩包，并补齐分类" },
  "/?mode=annotate": { title: "标注", subtitle: "为范围内的数据补充标签与评价" },
  "/?mode=manage": { title: "数据管理", subtitle: "整理批次、单元，并处理过期文件" },
  "/taxonomies": { title: "分类管理", subtitle: "维护项目、地点等分类标准" },
  "/robots": { title: "3D 模型", subtitle: "管理人体与机器人的描述和网格" },
  "/users": { title: "用户与权限", subtitle: "开账号、配范围，并进入对方视角验收" },
};

export function Layout() {
  const { user, logout, hasPerm, impersonating, impersonate, stopImpersonate } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [targets, setTargets] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  const { open: helpOpen, setOpen: setHelpOpen } = useRoleHelpAutoOpen(user?.role);
  const [pwOpen, setPwOpen] = useState(false);
  const [loadingActive, setLoadingActive] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("");
  const [searchParams] = useSearchParams();
  const currentMode = searchParams.get("mode") || "browse";

  useEffect(() => {
    return subscribeLoading((active, label) => {
      setLoadingActive(active);
      setLoadingLabel(label);
    });
  }, []);
  const pageKey = location.pathname + (location.search || "");
  const page = PAGES[pageKey] || PAGES["/"];

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

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
    <UndoProvider>
    <div className="app-frame">
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

      <div className={`app-body${collapsed ? " is-collapsed" : ""}`}>
        {navOpen && (
          <button
            type="button"
            className="nav-scrim"
            aria-label="关闭导航"
            onClick={() => setNavOpen(false)}
          />
        )}
        <aside className={`app-sidebar${navOpen ? " is-open" : ""}${collapsed ? " is-collapsed" : ""}`}>
          <div className="sidebar-brand">
            <span className="sidebar-mark" aria-hidden="true">
              N
            </span>
            <span className="sidebar-brand-copy">
              <strong>Noetix</strong>
              <em>Robot Data Hub</em>
            </span>
            <button
              type="button"
              className="sidebar-toggle"
              title={collapsed ? "展开侧栏" : "收起侧栏"}
              aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
              aria-expanded={!collapsed}
              onClick={toggleCollapsed}
            >
              <IconCollapse />
            </button>
          </div>
          <nav className="sidebar-nav">
            <SideLink to="/?mode=browse" icon={<IconBrowse />} onClick={() => setNavOpen(false)} activeMode={currentMode === "browse"}>
              浏览
            </SideLink>
            {hasPerm("upload") && (
              <SideLink to="/?mode=upload" icon={<IconUpload />} onClick={() => setNavOpen(false)} activeMode={currentMode === "upload"}>
                上传
              </SideLink>
            )}
            {hasPerm("annotate") && (
              <SideLink to="/?mode=annotate" icon={<IconAnnotate />} onClick={() => setNavOpen(false)} activeMode={currentMode === "annotate"}>
                标注
              </SideLink>
            )}
            {hasPerm("manage_data") && (
              <SideLink to="/?mode=manage" icon={<IconManage />} onClick={() => setNavOpen(false)} activeMode={currentMode === "manage"}>
                数据管理
              </SideLink>
            )}
            {hasPerm("manage_data") && (
              <SideLink to="/taxonomies" icon={<IconTaxonomy />} onClick={() => setNavOpen(false)}>
                分类管理
              </SideLink>
            )}
            <SideLink to="/robots" icon={<IconRobot />} onClick={() => setNavOpen(false)}>
              3D 模型
            </SideLink>
            {hasPerm("manage_users") && (
              <SideLink to="/users" icon={<IconUsers />} onClick={() => setNavOpen(false)}>
                用户与权限
              </SideLink>
            )}
          </nav>
          <div className="sidebar-foot">
            <ThemeToggle />
          </div>
        </aside>

        <div className="app-main">
          <header className="app-top">
            <button
              type="button"
              className="nav-open"
              aria-label="打开导航"
              onClick={() => setNavOpen(true)}
            >
              <span />
              <span />
              <span />
            </button>
            <div className="page-heading">
              <h1>{page.title}</h1>
              <p>{page.subtitle}</p>
            </div>
            <div className="app-top-actions">
              {loadingActive && (
                <span className="global-loading-indicator">
                  <span className="global-loading-spinner" />
                  {loadingLabel || "处理中…"}
                </span>
              )}
              <HistoryButtons />
              <IndexRefreshControl className="btn-primary" />
              <button
                type="button"
                className="icon-btn"
                title="使用说明"
                aria-label="使用说明"
                onClick={() => setHelpOpen(true)}
              >
                <IconHelp />
              </button>
              <div className="user-pill">
                <span className="user-avatar" aria-hidden="true">
                  {(user?.username || "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="user-pill-copy">
                  <strong>{user?.username}</strong>
                  <em>
                    {user ? ROLE_LABEL[user.role] || user.role : ""}
                    {impersonating ? " ·视角" : ""}
                  </em>
                </span>
                <button
                  type="button"
                  className="ghost-link"
                  title="修改密码"
                  onClick={() => setPwOpen(true)}
                >
                  改密
                </button>
                <button type="button" className="ghost-link" onClick={logout}>
                  退出
                </button>
              </div>
            </div>
          </header>
          <main className="app-content">
            <PreviewProvider>
              <Outlet />
            </PreviewProvider>
          </main>
        </div>
      </div>

      <RoleHelpDialog
        role={user?.role}
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
      />
      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
    </UndoProvider>
  );
}

function SideLink({
  to,
  icon,
  children,
  onClick,
  activeMode,
}: {
  to: string;
  end?: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  activeMode?: boolean;
}) {
  const label = typeof children === "string" ? children : undefined;
  return (
    <NavLink
      to={to}
      title={label}
      onClick={onClick}
      className={() => (activeMode ? "is-active" : undefined)}
    >
      {icon}
      <span>{children}</span>
    </NavLink>
  );
}

function IconCollapse() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

function IconBrowse() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l5 5" />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 16V5" />
      <path d="M8 9l4-4 4 4" />
      <path d="M5 19h14" />
    </svg>
  );
}

function IconAnnotate() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 19l3.2-.7L19 7.5a1.8 1.8 0 0 0-2.5-2.5L5.7 15.8 5 19z" />
    </svg>
  );
}

function IconManage() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.4" />
      <rect x="13" y="4" width="7" height="7" rx="1.4" />
      <rect x="4" y="13" width="7" height="7" rx="1.4" />
      <rect x="13" y="13" width="7" height="7" rx="1.4" />
    </svg>
  );
}

function IconTaxonomy() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M8.2 6H12v12H8.2M12 12h3.8" />
    </svg>
  );
}

function IconRobot() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="8" width="14" height="11" rx="2.2" />
      <path d="M12 8V5" />
      <circle cx="12" cy="5" r="1.2" />
      <circle cx="9.2" cy="13" r="1.1" />
      <circle cx="14.8" cy="13" r="1.1" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="8" r="2.6" />
      <path d="M4.8 18c.6-2.6 2.5-4 4.2-4s3.6 1.4 4.2 4" />
      <circle cx="16.2" cy="9" r="2.1" />
      <path d="M15.2 14.2c1.7.2 3.2 1.3 3.8 3.8" />
    </svg>
  );
}

function IconHelp() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M9.6 9.4a2.4 2.4 0 1 1 3.3 2.2c-.8.4-1.3 1-1.3 1.8V14" />
      <circle cx="12" cy="16.6" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}
