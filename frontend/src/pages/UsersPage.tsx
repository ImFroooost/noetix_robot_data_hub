import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { fetchStorageOverview } from "../storageOverviewCache";
import { useAuth } from "../auth";
import type {
  PermissionItem,
  Role,
  TaxonomyNode,
  TaxonomySchemeDef,
  User,
} from "../types";
import {
  CAPABILITY_COLUMNS,
  ROLE_CAPABILITIES,
  ROLE_LABEL,
  ROLE_OPTIONS,
  SUPER_ROLES,
  isSuperRole,
  taxonomySchemeLabel,
} from "../types";

const CAPABILITY_LABEL: Record<string, string> = {
  browse: "浏览",
  download: "下载",
  upload: "上传",
  annotate: "标注",
  manage_data: "管理数据",
};

function PermissionEditor({
  user,
  folderPaths,
  schemes,
  taxNodes,
  onSaved,
}: {
  user: User;
  folderPaths: string[];
  schemes: TaxonomySchemeDef[];
  taxNodes: TaxonomyNode[];
  onSaved: () => void;
}) {
  const [items, setItems] = useState<PermissionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setLoading(true);
    api
      .getUserPermissions(user.id)
      .then((p) => setItems(p))
      .catch((e) => setError(e instanceof Error ? e.message : "加载权限失败"))
      .finally(() => setLoading(false));
  }, [user.id]);

  const pathOptions = (scheme: string): string[] => {
    if (!scheme) {
      return ["/", ...folderPaths];
    }
    return ["/", ...taxNodes.filter((n) => n.scheme === scheme).map((n) => n.path)];
  };

  const update = (idx: number, patch: Partial<PermissionItem>) => {
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    );
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setMsg("");
    try {
      const saved = await api.putUserPermissions(user.id, items);
      setItems(saved);
      setMsg("权限已保存（管理数据包含同范围的浏览 / 下载 / 标注 / 上传；其它能力会自动附带浏览）");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="muted">加载权限…</div>;

  return (
    <div className="stack" style={{ gap: 8 }}>
      {error && <div className="error">{error}</div>}
      {msg && <div className="success">{msg}</div>}
      <table className="table">
        <thead>
          <tr>
            <th>能力</th>
            <th>适用分类标准</th>
            <th>范围（文件夹 / 分类节点）</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={idx}>
              <td>
                <select
                  value={it.capability}
                  onChange={(e) => update(idx, { capability: e.target.value })}
                >
                  {(ROLE_CAPABILITIES[user.role] || ["browse"])
                    .filter((k) => k !== "manage_users")
                    .map((k) => (
                    <option key={k} value={k}>
                      {CAPABILITY_LABEL[k] || k}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  value={it.scheme || ""}
                  onChange={(e) =>
                    update(idx, { scheme: e.target.value, path_prefix: "/" })
                  }
                >
                  <option value="">文件夹目录</option>
                  {schemes.map((s) => (
                    <option key={s.key} value={s.key}>
                      {taxonomySchemeLabel(s.key, schemes)}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  value={it.path_prefix}
                  onChange={(e) => update(idx, { path_prefix: e.target.value })}
                >
                  {pathOptions(it.scheme || "").map((p) => (
                    <option key={p} value={p}>
                      {p === "/" ? "/（全部）" : p}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <button
                  type="button"
                  className="danger"
                  onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                >
                  移除
                </button>
              </td>
            </tr>
          ))}
          {!items.length && (
            <tr>
              <td colSpan={4} className="muted">
                暂无权限（该用户当前无法看到任何数据）
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            setItems((prev) => [
              ...prev,
              { capability: "browse", scheme: "", path_prefix: "/", recursive: true },
            ])
          }
        >
          + 添加权限
        </button>
        <button type="button" disabled={saving} onClick={save}>
          {saving ? "保存中…" : "保存权限"}
        </button>
      </div>
    </div>
  );
}

export function UsersPage() {
  const { hasPerm, user: me, impersonate } = useAuth();
  const canManageUsers = hasPerm("manage_users");
  const [users, setUsers] = useState<User[]>([]);
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const [schemes, setSchemes] = useState<TaxonomySchemeDef[]>([]);
  const [taxNodes, setTaxNodes] = useState<TaxonomyNode[]>([]);
  const nav = useNavigate();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [viewBusy, setViewBusy] = useState<number | null>(null);

  const reload = () => api.listUsers().then(setUsers);

  useEffect(() => {
    if (!canManageUsers) return;
    reload().catch((e) => setError(e.message));
    Promise.all([api.listFolders(), fetchStorageOverview()])
      .then(([folders, storage]) => {
        const paths = [
          ...folders.map((folder) => folder.path),
          ...storage.batches.flatMap((batch) => [
            `/${batch.name}/`,
            ...batch.units.map((unit) => `/${batch.name}/${unit.name}/`),
          ]),
        ];
        setFolderPaths([...new Set(paths)].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => undefined);
    api.listTaxonomySchemes().then(setSchemes).catch(() => undefined);
    api.listTaxonomies().then(setTaxNodes).catch(() => undefined);
  }, [canManageUsers]);

  if (!canManageUsers) return <div className="page error">需要超级管理者权限</div>;

  const onCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const fd = new FormData(el);
    try {
      await api.createUser({
        username: fd.get("username"),
        password: fd.get("password"),
        role: fd.get("role"),
      });
      el.reset();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    }
  };

  return (
    <div className="page stack">
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          普通角色的能力为「受限」：只对已分配的文件夹或分类节点生效。超级角色的对应能力为全量。
          「管理数据」包含同范围的浏览、下载、标注、上传。只有超级管理者可以管理用户。点「进入视角」可按该用户的权限浏览界面。
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ fontSize: "0.85rem" }}>
            <thead>
              <tr>
                <th>用户角色</th>
                {CAPABILITY_COLUMNS.map((col) => (
                  <th key={col.key}>{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROLE_OPTIONS.map((role) => (
                <tr key={role}>
                  <td>{ROLE_LABEL[role]}</td>
                  {CAPABILITY_COLUMNS.map((col) => {
                    const has = (ROLE_CAPABILITIES[role] || []).includes(col.key);
                    return (
                      <td key={col.key}>
                        {has ? (SUPER_ROLES.has(role) ? "是" : "受限") : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && <div className="error">{error}</div>}
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>用户名</th>
              <th>角色</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <>
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td>{u.username}</td>
                  <td>
                    <select
                      value={u.role}
                      onChange={async (e) => {
                        await api.updateUser(u.id, { role: e.target.value as Role });
                        await reload();
                      }}
                    >
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                      {!ROLE_OPTIONS.includes(u.role) && (
                        <option value={u.role}>{ROLE_LABEL[u.role] || u.role}</option>
                      )}
                    </select>
                  </td>
                  <td>{u.is_active ? "启用" : "禁用"}</td>
                  <td>
                    <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <button
                        className="secondary"
                        onClick={async () => {
                          await api.updateUser(u.id, { is_active: !u.is_active });
                          await reload();
                        }}
                      >
                        {u.is_active ? "禁用" : "启用"}
                      </button>
                      {!isSuperRole(u.role) && (
                        <button
                          className="secondary"
                          onClick={() => setExpanded(expanded === u.id ? null : u.id)}
                        >
                          {expanded === u.id ? "收起范围" : "配置范围"}
                        </button>
                      )}
                      {me?.id !== u.id && (
                        <button
                          className="secondary"
                          disabled={viewBusy === u.id}
                          onClick={async () => {
                            setViewBusy(u.id);
                            setError("");
                            try {
                              await impersonate(u.id);
                              nav("/", { replace: true });
                            } catch (err) {
                              setError(err instanceof Error ? err.message : "切换视角失败");
                            } finally {
                              setViewBusy(null);
                            }
                          }}
                        >
                          {viewBusy === u.id ? "进入中…" : "进入视角"}
                        </button>
                      )}
                      {me?.id !== u.id && (
                        <button
                          className="danger"
                          onClick={async () => {
                            if (!confirm(`确认删除用户 ${u.username}？`)) return;
                            try {
                              await api.deleteUser(u.id);
                              await reload();
                            } catch (err) {
                              setError(err instanceof Error ? err.message : "删除失败");
                            }
                          }}
                        >
                          删除
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
                {expanded === u.id && !isSuperRole(u.role) && (
                  <tr key={`${u.id}-perm`}>
                    <td colSpan={5}>
                      <PermissionEditor
                        user={u}
                        folderPaths={folderPaths}
                        schemes={schemes}
                        taxNodes={taxNodes}
                        onSaved={() => void reload()}
                      />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      <form className="card stack" style={{ maxWidth: 480 }} onSubmit={onCreate}>
        <h2>新建用户</h2>
        <label>
          用户名
          <input name="username" required />
        </label>
        <label>
          密码
          <input name="password" type="password" required />
        </label>
        <label>
          角色
          <select name="role" defaultValue="visitor">
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          普通角色创建后请点「配置范围」，指定可访问的文件夹或分类节点。超级角色无需配置范围。
        </p>
        <button type="submit">创建</button>
      </form>
    </div>
  );
}
