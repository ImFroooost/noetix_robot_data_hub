import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import type {
  PermissionItem,
  Role,
  TaxonomyNode,
  TaxonomySchemeDef,
  User,
} from "../types";
import { ROLE_LABEL, taxonomySchemeLabel } from "../types";

const CAPABILITY_LABEL: Record<string, string> = {
  browse: "浏览",
  download: "下载",
  upload: "上传",
  annotate: "标注",
  edit: "编辑",
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
      setMsg("权限已保存（非浏览能力会自动附带同范围的浏览权限）");
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
                  {Object.entries(CAPABILITY_LABEL).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
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
  const { isAdmin, user: me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const [schemes, setSchemes] = useState<TaxonomySchemeDef[]>([]);
  const [taxNodes, setTaxNodes] = useState<TaxonomyNode[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState("");

  const reload = () => api.listUsers().then(setUsers);

  useEffect(() => {
    if (!isAdmin) return;
    reload().catch((e) => setError(e.message));
    Promise.all([api.listFolders(), api.storageOverview()])
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
  }, [isAdmin]);

  if (!isAdmin) return <div className="page error">需要管理员权限</div>;

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
        <h1>用户管理</h1>
        <p className="muted" style={{ margin: 0 }}>
          除管理员外，浏览 / 下载 / 上传 / 标注 / 编辑等能力可针对每个用户按
          「分类标准 + 文件夹（或分类节点）」指定适用范围。
        </p>
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
                      {(["admin", "editor", "viewer"] as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
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
                      {u.role !== "admin" && (
                        <button
                          className="secondary"
                          onClick={() => setExpanded(expanded === u.id ? null : u.id)}
                        >
                          {expanded === u.id ? "收起权限" : "配置权限"}
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
                {expanded === u.id && u.role !== "admin" && (
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
          <select name="role" defaultValue="viewer">
            <option value="admin">管理员</option>
            <option value="editor">编辑者</option>
            <option value="viewer">普通用户（按权限配置）</option>
          </select>
        </label>
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          创建后在列表中点「配置权限」，为浏览者 / 下载者 / 上传者 / 标注者分配能力和范围。
        </p>
        <button type="submit">创建</button>
      </form>
    </div>
  );
}
