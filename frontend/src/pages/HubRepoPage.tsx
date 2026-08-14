import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, downloadAuth } from "../api";
import { useAuth } from "../auth";
import { RepoTaxonomyNav } from "../components/RepoTaxonomyNav";
import { ResizableHeight } from "../components/ResizableColumns";
import { TaxonomySelect } from "../components/TaxonomyTree";
import type { RepoFile, RepoPack, TaxonomyNode, TaxonomySchemeDef } from "../types";
import { MODALITY_LABEL, ONTOLOGY_LABEL, QUALITY_LABEL, taxonomySchemeLabel } from "../types";

type Tree = Record<
  string,
  Record<
    string,
    Record<string, Record<string, { count: number; files: { id: number; name: string; path: string }[] }>>
  >
>;

/** 同一动作跨格式的聚合（来源夹内同名，BVH 的 _Skeleton 后缀会归一化） */
type PackAction = {
  key: string;
  title: string;
  formats: string[];
  files: RepoFile[];
};

type ViewingAction = {
  packKey: string;
  pack: RepoPack;
  action: PackAction;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function taxonomyTagIdsPayload(ids: Record<string, number | "">): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(ids)) {
    out[k] = v === "" ? null : v;
  }
  return out;
}

function emptyTaxIds(schemes: TaxonomySchemeDef[]): Record<string, number | ""> {
  const out: Record<string, number | ""> = {};
  for (const sch of schemes) out[sch.key] = "";
  return out;
}

/** 从已存 meta / action_def 恢复分类选择 */
function taxIdsFromSaved(
  meta: Record<string, unknown>,
  actionDef: Record<string, unknown>,
  schemes: TaxonomySchemeDef[]
): Record<string, number | ""> {
  const out = emptyTaxIds(schemes);
  const raw = meta.taxonomy_tag_ids;
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      else if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) out[k] = Number(v);
    }
  }
  const tax = actionDef.taxonomy;
  if (tax && typeof tax === "object") {
    for (const [k, v] of Object.entries(tax as Record<string, unknown>)) {
      if (out[k]) continue;
      if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "number") {
        out[k] = (v as { id: number }).id;
      }
    }
  }
  return out;
}

function taxBriefOf(
  schemeKey: string,
  ids: Record<string, number | "">,
  taxNodes: TaxonomyNode[]
) {
  const id = ids[schemeKey];
  if (id === "" || id == null) return null;
  const n = taxNodes.find((x) => x.id === id);
  if (!n) return null;
  return { id: n.id, name: n.name, code: n.code, path: n.path, scheme: n.scheme };
}

function buildTaxonomyMap(
  schemes: TaxonomySchemeDef[],
  ids: Record<string, number | "">,
  taxNodes: TaxonomyNode[]
): Record<string, unknown> {
  const taxonomy: Record<string, unknown> = {};
  for (const sch of schemes) {
    const b = taxBriefOf(sch.key, ids, taxNodes);
    if (b) taxonomy[sch.key] = b;
  }
  return taxonomy;
}

/** 从分类树选择推导动作定义 / 工程标记（不再单独维护重复文本框） */
function dimsFromTaxonomy(
  schemes: TaxonomySchemeDef[],
  ids: Record<string, number | "">,
  taxNodes: TaxonomyNode[]
): {
  taxonomy: Record<string, unknown>;
  atomic_action: string;
  type: string;
  style: string;
  project: string;
  acquire_location: string;
  acquire_method: string;
  acquire_device: string;
} {
  const taxonomy = buildTaxonomyMap(schemes, ids, taxNodes);
  const atomic = taxBriefOf("atomic", ids, taxNodes);
  const intent = taxBriefOf("intent", ids, taxNodes);
  const style = taxBriefOf("style", ids, taxNodes);
  let project = "";
  let acquire_location = "";
  let acquire_method = "";
  let acquire_device = "";
  for (const sch of schemes) {
    const brief = taxBriefOf(sch.key, ids, taxNodes);
    if (!brief) continue;
    const key = sch.key.toLowerCase();
    const name = sch.name || "";
    if (key.includes("location") || key.includes("place") || name.includes("地点") || name.includes("录制")) {
      acquire_location = brief.name;
    } else if (
      key.includes("method") ||
      key.includes("acquire") ||
      name.includes("获取方式") ||
      (name.includes("方式") && !name.includes("设备"))
    ) {
      acquire_method = brief.name;
    } else if (key.includes("device") || key.includes("equipment") || name.includes("设备")) {
      acquire_device = brief.name;
    }
    if (key.includes("project") || name.includes("项目")) {
      project = brief.name;
    }
  }
  return {
    taxonomy,
    atomic_action: atomic
      ? `${atomic.code ? atomic.code + " " : ""}${atomic.name}`.trim()
      : "",
    type: intent?.name || "",
    style: style?.name || "",
    project,
    acquire_location,
    acquire_method,
    acquire_device,
  };
}

function TaxonomyPickSection(props: {
  schemes: TaxonomySchemeDef[];
  taxNodes: TaxonomyNode[];
  taxonomyTagIds: Record<string, number | "">;
  setTaxonomyTagIds: (v: Record<string, number | "">) => void;
  canCreateTax: boolean;
  reloadTax: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const { schemes, taxNodes, taxonomyTagIds, setTaxonomyTagIds, canCreateTax, reloadTax, disabled } =
    props;
  if (!schemes.length) {
    return (
      <div className="muted">
        暂无分类标准，请先到「分类管理」维护树，再回此页选择；也可在各级用 + 新建。
      </div>
    );
  }
  return (
    <>
      <h4 style={{ margin: "4px 0 0" }}>分类（在分类管理中维护，此处选择或新建）</h4>
      <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
        原子动作 / 意图 / 风格 / 地点 / 项目 / 获取方式 / 设备等请直接选树节点，无需再填重复文本。
      </p>
      {schemes.map((sch) => (
        <label key={sch.key}>
          {sch.name}
          <TaxonomySelect
            scheme={sch.key}
            nodes={taxNodes.filter((n) => n.scheme === sch.key)}
            value={taxonomyTagIds[sch.key] ?? ""}
            disabled={disabled}
            canCreate={canCreateTax && !disabled}
            onNodesReload={reloadTax}
            onChange={(id) => setTaxonomyTagIds({ ...taxonomyTagIds, [sch.key]: id })}
          />
        </label>
      ))}
    </>
  );
}

/** 去掉扩展名，并剥离骨骼导出后缀（_Skeleton / _Skeleton 001 等）以便跨格式对齐 */
function actionMatchKey(filename: string): string {
  const base = filename.split(/[/\\]/).pop() || filename;
  let stem = base.replace(/\.[^.]+$/, "");
  // .ser.pkl 等双后缀
  if (stem.toLowerCase().endsWith(".ser")) stem = stem.slice(0, -4);
  // BVH 常见：xxx_Skeleton.bvh、xxx_Skeleton 001.bvh、xxx_000_Skeleton.bvh
  stem = stem.replace(/[_\s-]*Skeleton(?:[_\s-]*\d+)?$/i, "");
  return stem.trim() || base;
}

function preferredTitle(files: RepoFile[], key: string): string {
  const nonSkel = files.find((f) => !/_Skeleton\./i.test(f.original_name));
  if (nonSkel) {
    const n = nonSkel.original_name.replace(/\.[^.]+$/, "");
    return n || key;
  }
  return key;
}

function groupPackActions(files: RepoFile[]): PackAction[] {
  const map = new Map<string, RepoFile[]>();
  for (const f of files) {
    const k = actionMatchKey(f.original_name);
    const arr = map.get(k) || [];
    arr.push(f);
    map.set(k, arr);
  }
  return [...map.entries()]
    .map(([key, fls]) => {
      const sorted = [...fls].sort((a, b) => a.format.localeCompare(b.format) || a.id - b.id);
      return {
        key,
        title: preferredTitle(sorted, key),
        formats: [...new Set(sorted.map((f) => f.format))].sort(),
        files: sorted,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

export function HubRepoPage() {
  const { isAdmin, hasPerm } = useAuth();
  const canManage = isAdmin || hasPerm("edit");
  const canCreateTax = isAdmin || hasPerm("edit");

  const [tree, setTree] = useState<Tree>({});
  const [modality, setModality] = useState("");
  const [ontology, setOntology] = useState("");
  const [nameQ, setNameQ] = useState("");
  const [browseScheme, setBrowseScheme] = useState<string>("");
  const [taxId, setTaxId] = useState<number | null>(null);
  const [packs, setPacks] = useState<RepoPack[]>([]);
  const [schemaGroups, setSchemaGroups] = useState<
    { key: string; name: string; fields: { key: string; name: string }[] }[]
  >([]);
  const [taxNodes, setTaxNodes] = useState<TaxonomyNode[]>([]);
  const [schemes, setSchemes] = useState<TaxonomySchemeDef[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [catalogAt, setCatalogAt] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [editingPack, setEditingPack] = useState<RepoPack | null>(null);
  const [viewingAction, setViewingAction] = useState<ViewingAction | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadTax = () =>
    Promise.all([api.listTaxonomies(), api.listTaxonomySchemes()]).then(([t, s]) => {
      setTaxNodes(t);
      setSchemes(s);
      setBrowseScheme((prev) => {
        if (prev && s.some((x) => x.key === prev)) return prev;
        return s[0]?.key || "";
      });
    });

  const reloadTree = () =>
    api.repoBrowseTree().then((r) => setTree((r.tree || {}) as Tree)).catch((e) => setError(e.message));

  const reloadPacks = () =>
    api
      .repoListPacks({
        modality: modality || undefined,
        ontology: ontology || undefined,
        q: nameQ.trim() || undefined,
        taxonomy_scheme: browseScheme || undefined,
        tag_id: taxId ?? undefined,
      })
      .then((list) => {
        setPacks(list);
        setSelectedKeys((prev) => {
          const keys = new Set(list.map((p) => p.key));
          return new Set([...prev].filter((k) => keys.has(k)));
        });
        setEditingPack((cur) => (cur ? list.find((p) => p.key === cur.key) || null : null));
        setViewingAction((cur) => {
          if (!cur) return null;
          const pack = list.find((p) => p.key === cur.packKey);
          if (!pack) return null;
          const action = groupPackActions(pack.files).find((a) => a.key === cur.action.key);
          if (!action) return null;
          return { packKey: pack.key, pack, action };
        });
      });

  useEffect(() => {
    reloadTree().catch(() => undefined);
    reloadTax().catch(() => undefined);
    api
      .repoDimensions()
      .then((s) => {
        const groups =
          (s.groups as { key: string; name: string; fields: { key: string; name: string }[] }[]) || [];
        setSchemaGroups(groups);
      })
      .catch(() => undefined);
    api
      .repoCatalog()
      .then((c) => setCatalogAt(c.updated_at || ""))
      .catch(() => undefined);
  }, []);

  const modalities = useMemo(() => Object.keys(tree).sort(), [tree]);
  const ontologies = useMemo(
    () => (modality ? Object.keys(tree[modality] || {}).sort() : []),
    [tree, modality]
  );
  const schemeNodes = useMemo(
    () => (browseScheme ? taxNodes.filter((n) => n.scheme === browseScheme) : []),
    [taxNodes, browseScheme]
  );

  useEffect(() => {
    setError("");
    const t = setTimeout(() => {
      reloadPacks().catch((e) => setError(e.message));
    }, nameQ ? 200 : 0);
    return () => clearTimeout(t);
  }, [modality, ontology, nameQ, browseScheme, taxId]);

  const allSelected = packs.length > 0 && packs.every((p) => selectedKeys.has(p.key));

  const toggleAll = () => {
    if (allSelected) setSelectedKeys(new Set());
    else setSelectedKeys(new Set(packs.map((p) => p.key)));
  };

  const toggleKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const refreshAfterMutate = async () => {
    await reloadPacks();
    await reloadTree();
    const c = await api.repoCatalog().catch(() => null);
    if (c) setCatalogAt(c.updated_at || "");
  };

  const deletePacks = async (targets: RepoPack[]) => {
    if (!targets.length) return;
    const nFiles = targets.reduce((s, p) => s + p.file_count, 0);
    if (
      !confirm(
        `确认删除 ${targets.length} 个上传包（共 ${nFiles} 个文件）？\n将删除包内全部格式的磁盘文件与索引，不可恢复。`
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setMsg("");
    try {
      let count = 0;
      for (const p of targets) {
        const r = await api.repoDeletePack({
          modality: p.modality,
          ontology: p.ontology,
          source_name: p.source_name,
        });
        count += r.count;
      }
      setMsg(`已删除 ${targets.length} 个上传包（${count} 个文件）`);
      setSelectedKeys(new Set());
      if (editingPack && targets.some((t) => t.key === editingPack.key)) setEditingPack(null);
      if (viewingAction && targets.some((t) => t.key === viewingAction.packKey)) {
        setViewingAction(null);
      }
      await refreshAfterMutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const openAction = (pack: RepoPack, action: PackAction) => {
    setEditingPack(null);
    setViewingAction({ packKey: pack.key, pack, action });
    if (!expanded.has(pack.key)) {
      setExpanded((prev) => new Set(prev).add(pack.key));
    }
  };

  const taxProps = {
    schemes,
    taxNodes,
    canCreateTax,
    reloadTax,
  };

  const sidePanel = viewingAction ? (
    <ActionDetailPanel
      viewing={viewingAction}
      canManage={canManage}
      busy={busy}
      setBusy={setBusy}
      {...taxProps}
      onClose={() => setViewingAction(null)}
      onSaved={async () => {
        setMsg(`已更新动作「${viewingAction.action.title}」的全部格式`);
        await refreshAfterMutate();
      }}
      onError={setError}
      onDeleted={async () => {
        setViewingAction(null);
        setMsg("已删除该动作的全部格式文件");
        await refreshAfterMutate();
      }}
    />
  ) : editingPack ? (
    <PackEditor
      pack={editingPack}
      busy={busy}
      setBusy={setBusy}
      {...taxProps}
      onClose={() => setEditingPack(null)}
      onSaved={async (updated) => {
        setEditingPack(updated);
        setMsg(`已更新上传包「${updated.source_name}」（${updated.file_count} 个文件）`);
        await refreshAfterMutate();
      }}
      onError={setError}
      onDelete={() => void deletePacks([editingPack])}
    />
  ) : null;

  return (
    <div className="page stack">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <h1 style={{ margin: 0 }}>维度仓库</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            按分类标准浏览上传包；展开后按「动作」聚合多格式文件。分类在「分类管理」维护，入库/编辑时打标。
            {canManage ? null : "（当前账号无编辑权限）"}
          </p>
        </div>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <Link to="/upload" className="secondary" style={{ textDecoration: "none", padding: "6px 12px" }}>
            上传入库
          </Link>
          <div className="muted" style={{ fontSize: "0.85rem" }}>
            索引更新：{catalogAt ? new Date(catalogAt).toLocaleString() : "—"}
          </div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="success">{msg}</div>}

      <div className="card stack">
        <h3 style={{ margin: 0 }}>维度定义（可扩展）</h3>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {schemaGroups.map((g) => (
            <span key={g.key} className="badge" title={g.fields.map((f) => f.name).join("、")}>
              {g.name}（{g.fields.length} 字段）
            </span>
          ))}
          {!schemaGroups.length && <span className="muted">加载中…</span>}
        </div>
      </div>

      <div className="browse-tabs" style={{ flexWrap: "wrap", gap: 6 }}>
        {schemes.map((s) => (
          <button
            key={s.key}
            type="button"
            className={browseScheme === s.key ? "" : "secondary"}
            onClick={() => {
              setBrowseScheme(s.key);
              setTaxId(null);
            }}
            title={s.builtin ? "内置分类标准" : "自定义分类标准"}
          >
            {s.name}
            {s.builtin ? "" : " ·自定"}
            <span className="muted" style={{ marginLeft: 4 }}>
              {s.code_prefix}
            </span>
          </button>
        ))}
        {!schemes.length && <span className="muted">加载分类标准…</span>}
      </div>

      <div className="card row" style={{ flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <label>
          数据模态
          <select
            value={modality}
            onChange={(e) => {
              setModality(e.target.value);
              setOntology("");
            }}
          >
            <option value="">全部</option>
            {modalities.map((m) => (
              <option key={m} value={m}>
                {MODALITY_LABEL[m] || m}
              </option>
            ))}
          </select>
        </label>
        <label>
          本体类型
          <select
            value={ontology}
            disabled={!modality}
            onChange={(e) => setOntology(e.target.value)}
          >
            <option value="">全部</option>
            {ontologies.map((o) => (
              <option key={o} value={o}>
                {ONTOLOGY_LABEL[o] || o}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: "1 1 220px" }}>
          搜索上传包 / 动作 / 文件
          <input
            value={nameQ}
            onChange={(e) => setNameQ(e.target.value)}
            placeholder="来源名 / 动作名 / 文件名"
          />
        </label>
      </div>

      <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
        <div className="card stack" style={{ flex: "0 0 280px", maxWidth: "100%" }}>
          <h3 style={{ margin: 0 }}>
            {browseScheme ? taxonomySchemeLabel(browseScheme, schemes) : "分类"}
          </h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            点选节点筛选带该分类（含子类）的上传包
          </p>
          <ResizableHeight storageKey="hub-tax-tree" defaultHeight={480} min={240} max={900}>
            <RepoTaxonomyNav
              nodes={schemeNodes}
              selectedId={taxId}
              onSelect={(n) => setTaxId(n?.id ?? null)}
            />
          </ResizableHeight>
        </div>

        <div className="card stack" style={{ flex: "1 1 480px", minWidth: 0 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0 }}>上传包</h3>
            <span className="muted">
              {packs.length} 个包
              {selectedKeys.size ? ` · 已选 ${selectedKeys.size}` : ""}
            </span>
          </div>

          {canManage && (
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                className="secondary"
                disabled={selectedKeys.size !== 1 || busy}
                onClick={() => {
                  const p = packs.find((x) => x.key === [...selectedKeys][0]);
                  if (p) {
                    setViewingAction(null);
                    setEditingPack(p);
                  }
                }}
              >
                编辑整包属性
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!selectedKeys.size || busy}
                onClick={() =>
                  void deletePacks(packs.filter((p) => selectedKeys.has(p.key)))
                }
              >
                删除选中包
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setMsg("");
                  setError("");
                  void refreshAfterMutate()
                    .then(() => setMsg("已刷新"))
                    .catch((e) => setError(e.message));
                }}
              >
                刷新
              </button>
            </div>
          )}

          {!packs.length && (
            <div className="muted">暂无上传包。请到「上传 → 维度仓库」入库后再刷新本页。</div>
          )}

          {!!packs.length && (
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    {canManage && (
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleAll}
                          aria-label="全选"
                        />
                      </th>
                    )}
                    <th style={{ width: 28 }}></th>
                    <th>上传包名</th>
                    <th>模态 / 本体</th>
                    <th>格式</th>
                    <th>动作 / 文件</th>
                    <th>项目</th>
                    <th>质量</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {packs.map((p) => {
                    const open = expanded.has(p.key);
                    const active =
                      editingPack?.key === p.key || viewingAction?.packKey === p.key;
                    const quality =
                      (QUALITY_LABEL as Record<string, string>)[p.quality] || p.quality || "—";
                    const actions = groupPackActions(p.files);
                    return (
                      <PackRows
                        key={p.key}
                        pack={p}
                        actions={actions}
                        open={open}
                        active={active}
                        activeActionKey={
                          viewingAction?.packKey === p.key ? viewingAction.action.key : ""
                        }
                        canManage={canManage}
                        selected={selectedKeys.has(p.key)}
                        busy={busy}
                        quality={quality}
                        onToggleSelect={() => toggleKey(p.key)}
                        onToggleExpand={() => toggleExpand(p.key)}
                        onEditPack={() => {
                          setViewingAction(null);
                          setEditingPack(p);
                        }}
                        onDelete={() => void deletePacks([p])}
                        onOpenAction={(a) => openAction(p, a)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            展开包后按动作名聚合；BVH 的 <code>_Skeleton</code> /{" "}
            <code>_Skeleton 001</code> 等骨骼后缀会与同名的 fbx/csv/tak 合成同一动作。点击动作行查看详情。
          </p>
        </div>

        {sidePanel}
      </div>
    </div>
  );
}

function PackRows(props: {
  pack: RepoPack;
  actions: PackAction[];
  open: boolean;
  active: boolean;
  activeActionKey: string;
  canManage: boolean;
  selected: boolean;
  busy: boolean;
  quality: string;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onEditPack: () => void;
  onDelete: () => void;
  onOpenAction: (a: PackAction) => void;
}) {
  const { pack: p, actions, open, active, activeActionKey, canManage, selected, busy, quality } =
    props;

  return (
    <>
      <tr
        style={active && !activeActionKey ? { outline: "1px solid var(--accent, #4a9eff)" } : undefined}
        onDoubleClick={() => canManage && props.onEditPack()}
      >
        {canManage && (
          <td>
            <input
              type="checkbox"
              checked={selected}
              onChange={props.onToggleSelect}
              aria-label={`选择 ${p.source_name}`}
            />
          </td>
        )}
        <td>
          <button
            type="button"
            className="secondary"
            style={{ padding: "2px 8px", minWidth: 28 }}
            onClick={props.onToggleExpand}
            aria-expanded={open}
            title={open ? "收起" : "展开动作"}
          >
            {open ? "▾" : "▸"}
          </button>
        </td>
        <td>
          <strong style={{ fontWeight: 600 }}>{p.source_name}</strong>
        </td>
        <td>
          {MODALITY_LABEL[p.modality] || p.modality} / {ONTOLOGY_LABEL[p.ontology] || p.ontology}
        </td>
        <td>
          <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            {p.formats.map((f) => (
              <span key={f} className="badge">
                {f}
              </span>
            ))}
          </span>
        </td>
        <td>
          {actions.length} / {p.file_count}
        </td>
        <td>{p.project || "—"}</td>
        <td>{quality}</td>
        <td>
          <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
            {canManage && (
              <button type="button" className="secondary" onClick={props.onEditPack}>
                整包
              </button>
            )}
            {canManage && (
              <button type="button" className="secondary" disabled={busy} onClick={props.onDelete}>
                删除
              </button>
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={canManage ? 9 : 8} style={{ padding: "4px 12px 16px 40px" }}>
            {!actions.length && <div className="muted">包内无文件</div>}
            <table className="table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>动作名</th>
                  <th>格式</th>
                  <th>副本</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a) => {
                  const replica = str(asRecord(a.files[0]?.dimensions?.replica).copy_no) || "—";
                  const isActive = activeActionKey === a.key;
                  return (
                    <tr
                      key={a.key}
                      style={
                        isActive
                          ? { outline: "1px solid var(--accent, #4a9eff)", cursor: "pointer" }
                          : { cursor: "pointer" }
                      }
                      onClick={() => props.onOpenAction(a)}
                    >
                      <td
                        title={a.title}
                        style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        {a.title}
                      </td>
                      <td>
                        <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                          {a.formats.map((f) => (
                            <span key={f} className="badge">
                              {f}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td>{replica}</td>
                      <td>
                        <button
                          type="button"
                          className="secondary"
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onOpenAction(a);
                          }}
                        >
                          详情
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

function ActionDetailPanel(props: {
  viewing: ViewingAction;
  canManage: boolean;
  busy: boolean;
  setBusy: (v: boolean) => void;
  schemes: TaxonomySchemeDef[];
  taxNodes: TaxonomyNode[];
  canCreateTax: boolean;
  reloadTax: () => Promise<unknown>;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (msg: string) => void;
  onDeleted: () => Promise<void>;
}) {
  const {
    viewing,
    canManage,
    busy,
    setBusy,
    schemes,
    taxNodes,
    canCreateTax,
    reloadTax,
    onClose,
    onSaved,
    onError,
    onDeleted,
  } = props;
  const { action, pack } = viewing;
  const primary = action.files[0];
  const def0 = asRecord(primary?.action_def);
  const meta0 = asRecord(primary?.meta);
  const replica0 = asRecord(primary?.dimensions?.replica);

  const [actionName, setActionName] = useState(str(def0.action_name) || action.title);
  const [detailDesc, setDetailDesc] = useState(str(def0.detail_desc));
  const [copyNo, setCopyNo] = useState(str(replica0.copy_no) || "1");
  const [fps, setFps] = useState(primary?.fps != null ? String(primary.fps) : "");
  const [quality, setQuality] = useState(str(meta0.quality) || "medium");
  const [tags, setTags] = useState(
    Array.isArray(meta0.tags) ? (meta0.tags as string[]).join("，") : str(meta0.tags)
  );
  const [description, setDescription] = useState(str(meta0.description));
  const [taxonomyTagIds, setTaxonomyTagIds] = useState(() =>
    taxIdsFromSaved(meta0, def0, schemes)
  );

  // 仅切换动作时重置；勿依赖 schemes（新建分类会 reloadTax，否则会清空已选）
  useEffect(() => {
    const f = action.files[0];
    const def = asRecord(f?.action_def);
    const meta = asRecord(f?.meta);
    const replica = asRecord(f?.dimensions?.replica);
    setActionName(str(def.action_name) || action.title);
    setDetailDesc(str(def.detail_desc));
    setCopyNo(str(replica.copy_no) || "1");
    setFps(f?.fps != null ? String(f.fps) : "");
    setQuality(str(meta.quality) || "medium");
    setTags(Array.isArray(meta.tags) ? (meta.tags as string[]).join("，") : str(meta.tags));
    setDescription(str(meta.description));
    setTaxonomyTagIds(taxIdsFromSaved(meta, def, schemes));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- schemes 仅作初始恢复，不因 reload 重置
  }, [action.key, pack.key]);

  useEffect(() => {
    setTaxonomyTagIds((prev) => {
      const next = emptyTaxIds(schemes);
      for (const [k, v] of Object.entries(prev)) {
        if (v !== "" && v != null) next[k] = v;
      }
      return next;
    });
  }, [schemes]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canManage) return;
    setBusy(true);
    onError("");
    try {
      const fpsNum = fps.trim() === "" ? null : Number(fps);
      if (fps.trim() !== "" && Number.isNaN(fpsNum)) {
        throw new Error("帧率须为数字");
      }
      const fromTax = dimsFromTaxonomy(schemes, taxonomyTagIds, taxNodes);
      const body = {
        fps: fpsNum ?? undefined,
        clear_fps: fps.trim() === "",
        engineering: {
          project: fromTax.project,
          acquire_method: fromTax.acquire_method,
          acquire_location: fromTax.acquire_location,
          acquire_device: fromTax.acquire_device,
        },
        replica: { copy_no: copyNo.trim() || "1" },
        action_def: {
          action_name: actionName.trim(),
          atomic_action: fromTax.atomic_action,
          type: fromTax.type,
          style: fromTax.style,
          detail_desc: detailDesc.trim(),
          taxonomy: fromTax.taxonomy,
        },
        meta: {
          quality,
          tags: tags
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
          description: description.trim(),
          taxonomy_tag_ids: taxonomyTagIdsPayload(taxonomyTagIds),
        },
      };
      for (const f of action.files) {
        await api.repoUpdateFile(f.id, body);
      }
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const deleteAction = async () => {
    if (
      !confirm(
        `确认删除动作「${action.title}」的全部 ${action.files.length} 个格式文件？不可恢复。`
      )
    ) {
      return;
    }
    setBusy(true);
    onError("");
    try {
      await api.repoBatchDeleteFiles(action.files.map((f) => f.id));
      await onDeleted();
    } catch (err) {
      onError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card stack"
      onSubmit={submit}
      style={{ flex: "0 0 360px", maxWidth: "100%", position: "sticky", top: 12 }}
    >
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>动作详情</h3>
        <button type="button" className="secondary" onClick={onClose}>
          关闭
        </button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: "0.85rem", wordBreak: "break-all" }}>
        包 <strong>{pack.source_name}</strong> · {MODALITY_LABEL[pack.modality] || pack.modality}/
        {ONTOLOGY_LABEL[pack.ontology] || pack.ontology}
        <br />
        对齐键：{action.key}
      </p>

      <TaxonomyPickSection
        schemes={schemes}
        taxNodes={taxNodes}
        taxonomyTagIds={taxonomyTagIds}
        setTaxonomyTagIds={setTaxonomyTagIds}
        canCreateTax={canCreateTax}
        reloadTax={reloadTax}
        disabled={!canManage}
      />

      <div>
        <div className="muted" style={{ fontSize: "0.85rem", marginBottom: 6 }}>
          可用格式（{action.files.length}）
        </div>
        <div className="stack" style={{ gap: 6 }}>
          {action.files.map((f) => (
            <div
              key={f.id}
              className="row"
              style={{ justifyContent: "space-between", gap: 8, alignItems: "center" }}
            >
              <span>
                <span className="badge">{f.format}</span>{" "}
                <span title={f.repo_path} style={{ fontSize: "0.85rem" }}>
                  {f.original_name}
                </span>
              </span>
              <button
                type="button"
                className="secondary"
                style={{ padding: "2px 8px", flexShrink: 0 }}
                onClick={() =>
                  downloadAuth(api.repoDownloadUrl(f.id), f.original_name || undefined)
                }
              >
                下载
              </button>
            </div>
          ))}
        </div>
      </div>

      <label>
        动作名称
        <input
          value={actionName}
          onChange={(e) => setActionName(e.target.value)}
          disabled={!canManage}
        />
      </label>
      <label>
        动作描述
        <textarea
          value={detailDesc}
          onChange={(e) => setDetailDesc(e.target.value)}
          rows={2}
          disabled={!canManage}
        />
      </label>

      <h4 style={{ margin: "4px 0 0" }}>其它标记（同步到本动作全部格式）</h4>
      <div className="row" style={{ gap: 8 }}>
        <label style={{ flex: 1 }}>
          副本号
          <input value={copyNo} onChange={(e) => setCopyNo(e.target.value)} disabled={!canManage} />
        </label>
        <label style={{ flex: 1 }}>
          帧率
          <input
            value={fps}
            onChange={(e) => setFps(e.target.value)}
            placeholder="可选"
            disabled={!canManage}
          />
        </label>
      </div>
      <label>
        质量
        <select value={quality} onChange={(e) => setQuality(e.target.value)} disabled={!canManage}>
          <option value="high">好</option>
          <option value="medium">中</option>
          <option value="low">差</option>
        </select>
      </label>
      <label>
        标签（逗号分隔）
        <input value={tags} onChange={(e) => setTags(e.target.value)} disabled={!canManage} />
      </label>
      <label>
        描述
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          disabled={!canManage}
        />
      </label>

      {canManage && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存本动作"}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void deleteAction()}>
            删除本动作
          </button>
        </div>
      )}
    </form>
  );
}

function PackEditor(props: {
  pack: RepoPack;
  busy: boolean;
  setBusy: (v: boolean) => void;
  schemes: TaxonomySchemeDef[];
  taxNodes: TaxonomyNode[];
  canCreateTax: boolean;
  reloadTax: () => Promise<unknown>;
  onClose: () => void;
  onSaved: (p: RepoPack) => Promise<void>;
  onError: (msg: string) => void;
  onDelete: () => void;
}) {
  const {
    pack,
    busy,
    setBusy,
    schemes,
    taxNodes,
    canCreateTax,
    reloadTax,
    onClose,
    onSaved,
    onError,
    onDelete,
  } = props;
  const def0 = asRecord(pack.action_def);
  const meta0 = asRecord(pack.meta);

  const [sourceName, setSourceName] = useState(pack.source_name);
  const [fps, setFps] = useState(pack.fps != null ? String(pack.fps) : "");
  const [actionName, setActionName] = useState(str(def0.action_name));
  const [detailDesc, setDetailDesc] = useState(str(def0.detail_desc));
  const [quality, setQuality] = useState(str(meta0.quality) || "medium");
  const [tags, setTags] = useState(
    Array.isArray(meta0.tags) ? (meta0.tags as string[]).join("，") : str(meta0.tags)
  );
  const [description, setDescription] = useState(str(meta0.description));
  const [taxonomyTagIds, setTaxonomyTagIds] = useState(() =>
    taxIdsFromSaved(meta0, def0, schemes)
  );

  // 仅切换上传包时重置；勿依赖 schemes（新建分类会 reloadTax，否则会清空已选）
  useEffect(() => {
    const def = asRecord(pack.action_def);
    const meta = asRecord(pack.meta);
    setSourceName(pack.source_name);
    setFps(pack.fps != null ? String(pack.fps) : "");
    setActionName(str(def.action_name));
    setDetailDesc(str(def.detail_desc));
    setQuality(str(meta.quality) || "medium");
    setTags(Array.isArray(meta.tags) ? (meta.tags as string[]).join("，") : str(meta.tags));
    setDescription(str(meta.description));
    setTaxonomyTagIds(taxIdsFromSaved(meta, def, schemes));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- schemes 仅作初始恢复，不因 reload 重置
  }, [pack.key]);

  useEffect(() => {
    setTaxonomyTagIds((prev) => {
      const next = emptyTaxIds(schemes);
      for (const [k, v] of Object.entries(prev)) {
        if (v !== "" && v != null) next[k] = v;
      }
      return next;
    });
  }, [schemes]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onError("");
    try {
      const fpsNum = fps.trim() === "" ? null : Number(fps);
      if (fps.trim() !== "" && Number.isNaN(fpsNum)) {
        throw new Error("帧率须为数字");
      }
      const fromTax = dimsFromTaxonomy(schemes, taxonomyTagIds, taxNodes);
      const updated = await api.repoUpdatePack({
        modality: pack.modality,
        ontology: pack.ontology,
        source_name: pack.source_name,
        new_source_name: sourceName.trim(),
        fps: fpsNum ?? undefined,
        clear_fps: fps.trim() === "",
        engineering: {
          project: fromTax.project,
          acquire_method: fromTax.acquire_method,
          acquire_location: fromTax.acquire_location,
          acquire_device: fromTax.acquire_device,
        },
        action_def: {
          action_name: actionName.trim(),
          atomic_action: fromTax.atomic_action,
          type: fromTax.type,
          style: fromTax.style,
          detail_desc: detailDesc.trim(),
          taxonomy: fromTax.taxonomy,
        },
        meta: {
          quality,
          tags: tags
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
          description: description.trim(),
          taxonomy_tag_ids: taxonomyTagIdsPayload(taxonomyTagIds),
        },
      });
      await onSaved(updated);
    } catch (err) {
      onError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card stack"
      onSubmit={submit}
      style={{ flex: "0 0 340px", maxWidth: "100%", position: "sticky", top: 12 }}
    >
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>编辑上传包</h3>
        <button type="button" className="secondary" onClick={onClose}>
          关闭
        </button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
        以下属性将应用到包内全部 {pack.file_count} 个文件
        <br />
        格式：{pack.formats.join(", ") || "—"}
      </p>

      <TaxonomyPickSection
        schemes={schemes}
        taxNodes={taxNodes}
        taxonomyTagIds={taxonomyTagIds}
        setTaxonomyTagIds={setTaxonomyTagIds}
        canCreateTax={canCreateTax}
        reloadTax={reloadTax}
      />

      <label>
        上传包名（ZIP/来源名；改名会移动全部格式目录）
        <input value={sourceName} onChange={(e) => setSourceName(e.target.value)} required />
      </label>
      <label>
        动作名称
        <input value={actionName} onChange={(e) => setActionName(e.target.value)} />
      </label>
      <label>
        动作描述
        <textarea value={detailDesc} onChange={(e) => setDetailDesc(e.target.value)} rows={2} />
      </label>

      <h4 style={{ margin: "4px 0 0" }}>其它标记</h4>
      <div className="row" style={{ gap: 8 }}>
        <label style={{ flex: 1 }}>
          帧率（整包）
          <input value={fps} onChange={(e) => setFps(e.target.value)} placeholder="可选" />
        </label>
        <label style={{ flex: 1 }}>
          质量
          <select value={quality} onChange={(e) => setQuality(e.target.value)}>
            <option value="high">好</option>
            <option value="medium">中</option>
            <option value="low">差</option>
          </select>
        </label>
      </div>
      <label>
        标签（逗号分隔）
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      <label>
        描述
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </label>

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存整包"}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onDelete}>
          删除整包
        </button>
      </div>
    </form>
  );
}
