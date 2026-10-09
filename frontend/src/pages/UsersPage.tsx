import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { fetchStorageOverview } from "../storageOverviewCache";
import { useAuth } from "../auth";
import { humanModelFiles } from "../components/HumanModelFields";
import { robotDescriptionVersions } from "../components/RobotStyleFields";
import type {
  ModelInstance,
  PermissionItem,
  Role,
  StorageUploader,
  TaxonomyNode,
  TaxonomySchemeDef,
  User,
  UserPresence,
} from "../types";
import {
  CAPABILITY_COLUMNS,
  MOTION_KIND_OPTIONS,
  ROLE_CAPABILITIES,
  ROLE_LABEL,
  ROLE_OPTIONS,
  SUPER_ROLES,
  isSuperRole,
  taxonomySchemeLabel,
} from "../types";
import { useHistoryReload, useUndo } from "../undo/UndoContext";

const CAPABILITY_LABEL: Record<string, string> = {
  browse: "浏览",
  download: "下载",
  upload: "上传",
  annotate: "标注",
  manage_data: "管理数据",
};

const FILTER_DIMENSIONS: { key: string; label: string }[] = [
  { key: "uploader", label: "上传用户" },
  { key: "subject", label: "数据主体" },
  { key: "format", label: "数据格式" },
  { key: "modality", label: "数据模态" },
];

const MODALITY_SCOPES: { value: string; label: string }[] = [
  { value: "tpv_video", label: "第三视角视频" },
  { value: "fpv_video", label: "第一视角视频" },
  ...MOTION_KIND_OPTIONS.map(([kind, label]) => ({ value: `motion:${kind}`, label })),
  { value: "text", label: "文本" },
  { value: "audio", label: "音频" },
  { value: "log", label: "日志" },
];

type ScopeOption = { value: string; label: string };

function withCurrentScope(options: ScopeOption[], current: string): ScopeOption[] {
  if (!current || options.some((item) => item.value === current)) return options;
  return [...options, { value: current, label: current }];
}

function subjectScopes(instances: ModelInstance[]): ScopeOption[] {
  const options: ScopeOption[] = [{ value: "/", label: "/（全部）" }];
  for (const ontology of ["human", "robot"] as const) {
    const title = ontology === "human" ? "人体" : "机器人";
    options.push({ value: ontology, label: title });
    for (const item of instances.filter((row) => row.ontology === ontology)) {
      options.push({ value: `${ontology}|${item.name}`, label: `${title} / ${item.name}` });
      const versions =
        ontology === "robot" ? robotDescriptionVersions(item) : humanModelFiles(item);
      for (const file of versions) {
        options.push({
          value: `${ontology}|${item.name}|${file.relative_path}`,
          label: `${title} / ${item.name} / ${file.name}`,
        });
      }
    }
  }
  return options;
}

function seenAgo(iso: string | null | undefined) {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const sec = Math.max(0, (Date.now() - at) / 1000);
  if (sec < 60) return "刚刚";
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

function presenceActivity(item: UserPresence | undefined) {
  if (!item?.seen_at) return "—";
  const doing = [item.page, item.detail].filter(Boolean).join(" · ");
  if (item.online || item.away) return doing || "—";
  const when = seenAgo(item.seen_at);
  if (!doing) return when ? `上次 ${when}` : "—";
  return when ? `上次 ${when} · ${doing}` : doing;
}

function PresenceStatus({ item }: { item: UserPresence | undefined }) {
  const online = !!item?.online;
  const away = !!item?.away;
  const label = online ? "在线" : away ? "离开" : "离线";
  return (
    <span className="presence-status">
      <span className={`presence-dot${online ? " is-online" : away ? " is-away" : ""}`} />
      {label}
    </span>
  );
}

function PermissionEditor({
  user,
  folderPaths,
  schemes,
  taxNodes,
  uploaders,
  formats,
  instances,
  onSaved,
}: {
  user: User;
  folderPaths: string[];
  schemes: TaxonomySchemeDef[];
  taxNodes: TaxonomyNode[];
  uploaders: StorageUploader[];
  formats: string[];
  instances: ModelInstance[];
  onSaved: () => void;
}) {
  const [items, setItems] = useState<PermissionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const { execute } = useUndo();
  const [savedItems, setSavedItems] = useState<PermissionItem[]>([]);

  useEffect(() => {
    setLoading(true);
    api
      .getUserPermissions(user.id)
      .then((p) => {
        setItems(p);
        setSavedItems(p);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载权限失败"))
      .finally(() => setLoading(false));
  }, [user.id]);

  const scopeOptions = (scheme: string, current: string): ScopeOption[] => {
    if (scheme === "uploader") {
      return withCurrentScope(
        [
          { value: "/", label: "/（全部）" },
          ...uploaders.map((item) => ({ value: String(item.id), label: item.username })),
        ],
        current
      );
    }
    if (scheme === "subject") {
      return withCurrentScope(subjectScopes(instances), current);
    }
    if (scheme === "format") {
      return withCurrentScope(
        [
          { value: "/", label: "/（全部）" },
          ...formats.map((format) => ({ value: format, label: format })),
        ],
        current
      );
    }
    if (scheme === "modality") {
      return withCurrentScope(
        [{ value: "/", label: "/（全部）" }, ...MODALITY_SCOPES],
        current
      );
    }
    const paths = scheme
      ? ["/", ...taxNodes.filter((node) => node.scheme === scheme).map((node) => node.path)]
      : ["/", ...folderPaths];
    return withCurrentScope(
      paths.map((path) => ({ value: path, label: path === "/" ? "/（全部）" : path })),
      current
    );
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
    const prev = savedItems.map((item) => ({ ...item }));
    const next = items.map((item) => ({ ...item }));
    try {
      await execute({
        label: `保存 ${user.username} 的权限`,
        do: async () => {
          const saved = await api.putUserPermissions(user.id, next);
          setItems(saved);
          setSavedItems(saved);
          setMsg("权限已保存（管理数据包含同范围的浏览 / 下载 / 标注 / 上传；其它能力会自动附带浏览）");
          onSaved();
        },
        undo: async () => {
          await api.putUserPermissions(user.id, prev);
        },
      });
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
            <th>筛选维度</th>
            <th>范围</th>
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
                  {FILTER_DIMENSIONS.map((dimension) => (
                    <option key={dimension.key} value={dimension.key}>
                      {dimension.label}
                    </option>
                  ))}
                  {schemes
                    .filter((scheme) => !FILTER_DIMENSIONS.some((dimension) => dimension.key === scheme.key))
                    .map((s) => (
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
                  {scopeOptions(it.scheme || "", it.path_prefix).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
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
  const { execute } = useUndo();
  const canManageUsers = hasPerm("manage_users");
  const [users, setUsers] = useState<User[]>([]);
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const [schemes, setSchemes] = useState<TaxonomySchemeDef[]>([]);
  const [taxNodes, setTaxNodes] = useState<TaxonomyNode[]>([]);
  const [uploaders, setUploaders] = useState<StorageUploader[]>([]);
  const [formats, setFormats] = useState<string[]>([]);
  const [instances, setInstances] = useState<ModelInstance[]>([]);
  const nav = useNavigate();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [viewBusy, setViewBusy] = useState<number | null>(null);
  const [presence, setPresence] = useState<Record<number, UserPresence>>({});

  useEffect(() => {
    if (!canManageUsers) return;
    let stop = false;
    const tick = () => {
      api
        .listPresence()
        .then((rows) => {
          if (stop) return;
          setPresence(Object.fromEntries(rows.map((row) => [row.user_id, row])));
        })
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 8000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [canManageUsers]);

  const reload = () => api.listUsers().then(setUsers);
  useHistoryReload(() => {
    void reload();
  });

  useEffect(() => {
    if (!canManageUsers) return;
    reload().catch((e) => setError(e.message));
    Promise.all([api.listFolders(), fetchStorageOverview(), api.storageModels()])
      .then(([folders, storage, models]) => {
        const paths = [
          ...folders.map((folder) => folder.path),
          ...storage.batches.flatMap((batch) => [
            `/${batch.name}/`,
            ...batch.units.map((unit) => `/${batch.name}/${unit.name}/`),
          ]),
        ];
        setFolderPaths([...new Set(paths)].sort((a, b) => a.localeCompare(b)));
        setUploaders(storage.uploaders || []);
        setFormats(
          [...new Set(storage.files.map((file) => (file.format || "").toLowerCase()).filter(Boolean))].sort(
            (a, b) => a.localeCompare(b)
          )
        );
        setInstances(models.instances || []);
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
    const body = {
      username: fd.get("username"),
      password: fd.get("password"),
      role: fd.get("role"),
    };
    let createdId = 0;
    try {
      await execute({
        label: `创建用户 ${String(body.username || "")}`,
        do: async () => {
          const created = (await api.createUser(body)) as User;
          createdId = created.id;
          el.reset();
          await reload();
        },
        undo: async () => {
          if (createdId) await api.deleteUser(createdId);
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    }
  };

  return (
    <div className="page stack">
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          普通角色的能力为「受限」：只对已分配的文件夹、筛选维度或分类节点生效。超级角色的对应能力为全量。
          「管理数据」包含同范围的浏览、下载、标注、上传。只有超级管理者可以管理用户。点「进入视角」可按该用户的权限浏览界面。
          在线表示对方正在使用页面；切到别的窗口会显示为离开。离线时保留最近一次在做的事。
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
              <th>在线</th>
              <th>正在做</th>
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
                        const prev = u.role;
                        const next = e.target.value as Role;
                        await execute({
                          label: `将 ${u.username} 改为${ROLE_LABEL[next] || next}`,
                          do: async () => {
                            await api.updateUser(u.id, { role: next });
                            await reload();
                          },
                          undo: async () => {
                            await api.updateUser(u.id, { role: prev });
                          },
                        });
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
                  <td>
                    <PresenceStatus item={presence[u.id]} />
                  </td>
                  <td className="presence-activity">{presenceActivity(presence[u.id])}</td>
                  <td>{u.is_active ? "启用" : "禁用"}</td>
                  <td>
                    <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <button
                        className="secondary"
                        onClick={async () => {
                          const prev = u.is_active;
                          await execute({
                            label: prev ? `禁用 ${u.username}` : `启用 ${u.username}`,
                            do: async () => {
                              await api.updateUser(u.id, { is_active: !prev });
                              await reload();
                            },
                            undo: async () => {
                              await api.updateUser(u.id, { is_active: prev });
                            },
                          });
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
                    <td colSpan={7}>
                      <PermissionEditor
                        user={u}
                        folderPaths={folderPaths}
                        schemes={schemes}
                        taxNodes={taxNodes}
                        uploaders={uploaders}
                        formats={formats}
                        instances={instances}
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
