import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, getToken } from "../api";
import { useAuth } from "../auth";
import { BrowseTree } from "../components/BrowseTree";
import { ClipBrowsePanel } from "../components/ClipBrowsePanel";
import { ResizableColumns, ResizableHeight } from "../components/ResizableColumns";
import { TaxonomyBrowseTree } from "../components/TaxonomyBrowseTree";
import type {
  ClipListItem,
  Folder,
  RepoPack,
  TaxonomyNode,
  TaxonomySchemeDef,
} from "../types";
import {
  MODALITY_LABEL,
  ONTOLOGY_LABEL,
  QUALITY_LABEL,
  STAGE_LABEL,
  taxonomySchemeLabel,
} from "../types";

type BrowseMode = string; // "folder" | scheme key

function tagLabel(t: { code?: string; name: string } | null | undefined): string {
  if (!t) return "";
  return t.code ? `${t.code} ${t.name}` : t.name;
}

/** 始终按 clipId 拉取缩略图，避免列表缓存里 thumbnail_path 为空时一直显示「无图」 */
function ResultThumb({ clipId }: { clipId: number }) {
  const [failed, setFailed] = useState(false);
  const src = `/api/thumbnails/${clipId}?token=${encodeURIComponent(getToken() || "")}`;
  if (failed) {
    return (
      <div className="browse-result-thumb">
        <span className="muted">无图</span>
      </div>
    );
  }
  return (
    <div className="browse-result-thumb">
      <img src={src} alt="" onError={() => setFailed(true)} />
    </div>
  );
}

/**
 * 完整浏览：左侧文件夹/分类标准树（到条目），中部筛选，右侧列表或详情可视化。
 */
export function SearchPage() {
  const { user, isAdmin } = useAuth();
  const canManageFolders =
    isAdmin || !!(user?.capabilities?.edit && user.capabilities.edit.length > 0);

  const [browseMode, setBrowseMode] = useState<BrowseMode>("folder");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [taxNodes, setTaxNodes] = useState<TaxonomyNode[]>([]);
  const [schemes, setSchemes] = useState<TaxonomySchemeDef[]>([]);
  const [folderId, setFolderId] = useState<number | null>(null);
  const [taxId, setTaxId] = useState<number | null>(null);
  const [taxPath, setTaxPath] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [humanFormat, setHumanFormat] = useState("");
  const [humanQuality, setHumanQuality] = useState("");
  const [robotModel, setRobotModel] = useState("");
  const [robotStage, setRobotStage] = useState("");
  const [hasReal, setHasReal] = useState("");
  const [facets, setFacets] = useState<{
    human_formats: string[];
    robot_models: string[];
  } | null>(null);

  const [listItems, setListItems] = useState<ClipListItem[]>([]);
  const [listTotal, setListTotal] = useState(0);
  const [hubPacks, setHubPacks] = useState<RepoPack[]>([]);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [selectedClipId, setSelectedClipId] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(true);

  const schemeNodes = useMemo(
    () => (browseMode === "folder" ? [] : taxNodes.filter((n) => n.scheme === browseMode)),
    [taxNodes, browseMode]
  );

  const extraFilters = useMemo(
    () => ({
      q: q.trim() || undefined,
      human_format: humanFormat || undefined,
      human_quality: humanQuality || undefined,
      robot_model: robotModel || undefined,
      robot_stage: robotStage || undefined,
      has_real: hasReal === "" ? undefined : hasReal === "true",
    }),
    [q, humanFormat, humanQuality, robotModel, robotStage, hasReal]
  );

  const loadFolders = () => api.listFolders().then(setFolders).catch(() => undefined);
  const loadTax = () =>
    Promise.all([api.listTaxonomies(), api.listTaxonomySchemes()])
      .then(([t, s]) => {
        setTaxNodes(t);
        setSchemes(s);
        // 默认按第一个分类标准浏览（而非文件夹）
        setBrowseMode((prev) => {
          if (prev !== "folder") return prev;
          return s[0]?.key || "folder";
        });
      })
      .catch(() => undefined);

  const loadHubPacks = async () => {
    try {
      if (browseMode === "folder") {
        // 文件夹树是旧 MotionClip；维度仓库上传包一并列出，避免「全部 0」却看不到包名
        const packs = await api.repoListPacks({
          q: q.trim() || undefined,
        });
        setHubPacks(packs);
        return;
      }
      const packs = await api.repoListPacks({
        taxonomy_scheme: browseMode,
        tag_id: taxId ?? undefined,
        taxonomy_path: taxId == null ? taxPath || undefined : undefined,
        q: q.trim() || undefined,
      });
      setHubPacks(packs);
    } catch {
      setHubPacks([]);
    }
  };

  const loadList = async (p = page, sort = sortBy, dir = sortDir) => {
    setError("");
    try {
      const data = await api.search({
        ...extraFilters,
        folder_id: browseMode === "folder" ? folderId || undefined : undefined,
        taxonomy_scheme: browseMode !== "folder" ? browseMode : undefined,
        taxonomy_path: browseMode !== "folder" ? taxPath || undefined : undefined,
        tag_id: browseMode !== "folder" ? taxId || undefined : undefined,
        page: p,
        page_size: 20,
        sort_by: sort,
        sort_dir: dir,
      });
      setListItems(data.items);
      setListTotal(data.total);
      setPage(p);
      await loadHubPacks();
    } catch (e) {
      setError(e instanceof Error ? e.message : "检索失败");
    }
  };

  useEffect(() => {
    api.facets().then(setFacets).catch(() => undefined);
    loadFolders();
    loadTax();
  }, []);

  useEffect(() => {
    if (browseMode === "folder" && folderId != null && sortBy === "created_at") {
      setSortBy("sort_order");
      setSortDir("asc");
      void loadList(1, "sort_order", "asc");
    } else {
      void loadList(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseMode, folderId, taxId, taxPath, refreshKey]);

  useEffect(() => {
    void loadList(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extraFilters]);

  const switchMode = (mode: BrowseMode) => {
    setBrowseMode(mode);
    setSelectedClipId(null);
    setFolderId(null);
    setTaxId(null);
    setTaxPath(null);
    setPage(1);
  };

  const scopeTitle = () => {
    if (browseMode === "folder") {
      if (folderId == null) {
        if (hubPacks.length === 1) return hubPacks[0].source_name;
        if (hubPacks.length > 1) return `维度仓库（${hubPacks.length} 个上传包）`;
        return "全部文件夹";
      }
      return folders.find((f) => f.id === folderId)?.path || "文件夹";
    }
    if (taxId == null) {
      if (hubPacks.length === 1) return hubPacks[0].source_name;
      return `${taxonomySchemeLabel(browseMode, schemes)} · 全部`;
    }
    const n = taxNodes.find((x) => x.id === taxId);
    const cat = n ? `${n.code ? n.code + " " : ""}${n.name}` : "分类节点";
    if (hubPacks.length === 1) return `${hubPacks[0].source_name} · ${cat}`;
    return cat;
  };

  return (
    <div className="page browse-page stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ margin: 0 }}>数据浏览</h1>
        <p className="muted" style={{ margin: 0, width: "100%" }}>
          按分类标准浏览条目与维度仓库上传包；分类在「分类管理」维护。
        </p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="secondary"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            {filtersOpen ? "收起筛选" : "展开筛选"}
          </button>
        </div>
      </div>

      <div className="browse-tabs" style={{ flexWrap: "wrap", gap: 6 }}>
        <button
          type="button"
          className={browseMode === "folder" ? "" : "secondary"}
          onClick={() => switchMode("folder")}
        >
          文件夹
        </button>
        {schemes.map((s) => (
          <button
            key={s.key}
            type="button"
            className={browseMode === s.key ? "" : "secondary"}
            onClick={() => switchMode(s.key)}
            title={s.builtin ? "内置分类标准" : "自定义分类标准"}
          >
            {s.name}
            {s.builtin ? "" : " ·自定"}
          </button>
        ))}
      </div>

      {filtersOpen && (
        <form
          className="card row"
          style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}
          onSubmit={(e) => {
            e.preventDefault();
            setSelectedClipId(null);
            void loadList(1);
            setRefreshKey((k) => k + 1);
          }}
        >
          <label style={{ flex: "1 1 160px", margin: 0 }}>
            关键词
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="概括 / 描述 / 标签…"
            />
          </label>
          <label style={{ flex: "0 1 120px", margin: 0 }}>
            人体格式
            <select value={humanFormat} onChange={(e) => setHumanFormat(e.target.value)}>
              <option value="">全部</option>
              {(facets?.human_formats || ["bvh", "csv", "fbx", "tak"]).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: "0 1 100px", margin: 0 }}>
            人体质量
            <select value={humanQuality} onChange={(e) => setHumanQuality(e.target.value)}>
              <option value="">全部</option>
              {(["high", "medium", "low"] as const).map((q) => (
                <option key={q} value={q}>
                  {QUALITY_LABEL[q]}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: "0 1 140px", margin: 0 }}>
            机器人型号
            <select value={robotModel} onChange={(e) => setRobotModel(e.target.value)}>
              <option value="">全部</option>
              {(facets?.robot_models || []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: "0 1 120px", margin: 0 }}>
            机器人阶段
            <select value={robotStage} onChange={(e) => setRobotStage(e.target.value)}>
              <option value="">全部</option>
              {(["retarget", "polish", "refine", "real"] as const).map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: "0 1 120px", margin: 0 }}>
            真人视频
            <select value={hasReal} onChange={(e) => setHasReal(e.target.value)}>
              <option value="">全部</option>
              <option value="true">有</option>
              <option value="false">无</option>
            </select>
          </label>
          <button type="submit">应用筛选</button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setQ("");
              setHumanFormat("");
              setHumanQuality("");
              setRobotModel("");
              setRobotStage("");
              setHasReal("");
              setSelectedClipId(null);
              setRefreshKey((k) => k + 1);
            }}
          >
            重置
          </button>
        </form>
      )}

      {error && <div className="error">{error}</div>}

      <ResizableColumns storageKey="browse-main-v2" defaults={[320]} mins={[240]} maxes={[520]}>
        <div className="card stack browse-left">
          <h2 style={{ margin: 0 }}>
            {browseMode === "folder"
              ? "文件夹结构"
              : taxonomySchemeLabel(browseMode, schemes)}
          </h2>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            {browseMode === "folder"
              ? canManageFolders
                ? "左侧可管理文件夹与批量处理条目；点条目看右侧详情。"
                : "展开节点可看条目；点文件夹看列表，点条目看详情。"
              : "展开分类节点可看条目；点条目看详情与可视化。"}
          </p>

          {browseMode === "folder" ? (
            <ResizableHeight storageKey="browse-tree" defaultHeight={560} min={280} max={1000}>
              <BrowseTree
                folders={folders}
                selectedClipId={selectedClipId}
                selectedFolderId={folderId}
                onSelectFolder={(f) => {
                  setFolderId(f?.id ?? null);
                  setSelectedClipId(null);
                }}
                onSelectClip={(c) => setSelectedClipId(c.id)}
                refreshKey={refreshKey}
                extraFilters={extraFilters}
                manageable={canManageFolders}
                onFoldersChanged={() => void loadFolders()}
                onClipsChanged={() => {
                  setRefreshKey((k) => k + 1);
                  setSelectedClipId(null);
                  void loadList(1);
                }}
              />
            </ResizableHeight>
          ) : (
            <ResizableHeight storageKey="browse-tax-tree" defaultHeight={520} min={240} max={1000}>
              <TaxonomyBrowseTree
                nodes={schemeNodes}
                scheme={browseMode}
                selectedNodeId={taxId}
                selectedClipId={selectedClipId}
                onSelectNode={(n) => {
                  setTaxId(n?.id ?? null);
                  setTaxPath(n?.path ?? null);
                  setSelectedClipId(null);
                }}
                onSelectClip={(c) => setSelectedClipId(c.id)}
                refreshKey={refreshKey}
                extraFilters={extraFilters}
              />
            </ResizableHeight>
          )}
        </div>

        <div className="card browse-right stack">
          {selectedClipId != null ? (
            <>
              <button
                type="button"
                className="secondary"
                style={{ alignSelf: "flex-start" }}
                onClick={() => setSelectedClipId(null)}
              >
                ← 返回列表（{scopeTitle()}）
              </button>
              <ClipBrowsePanel
                clipId={selectedClipId}
                schemes={schemes}
                taxNodes={taxNodes}
                onUpdated={() => {
                  setRefreshKey((k) => k + 1);
                  void loadFolders();
                  void loadTax();
                  void loadList(page);
                }}
              />
            </>
          ) : (
            <>
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <h2 style={{ margin: 0 }}>{scopeTitle()}</h2>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    仓库包 {hubPacks.length} 个
                    {hubPacks.length === 1 ? `（${hubPacks[0].source_name}）` : ""}
                    {listTotal > 0
                      ? ` · ${browseMode === "folder" ? "条目" : "旧库条目"} ${listTotal} 条`
                      : ""}
                  </div>
                </div>
                <label style={{ margin: 0, minWidth: 160 }}>
                  排序
                  <select
                    value={`${sortBy}:${sortDir}`}
                    onChange={(e) => {
                      const [s, d] = e.target.value.split(":") as [string, "asc" | "desc"];
                      setSortBy(s);
                      setSortDir(d);
                      void loadList(1, s, d);
                    }}
                  >
                    <option value="created_at:desc">最新创建</option>
                    <option value="created_at:asc">最早创建</option>
                    <option value="summary:asc">名称 A→Z</option>
                    <option value="sort_order:asc">自定义顺序</option>
                  </select>
                </label>
              </div>

              {!!hubPacks.length && (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                    <h3 style={{ margin: 0, fontSize: "1rem" }}>
                      {browseMode === "folder" ? "维度仓库上传包" : "维度仓库（按分类）"}
                    </h3>
                    <Link to="/hub" style={{ fontSize: "0.85rem" }}>
                      在维度仓库中管理 →
                    </Link>
                  </div>
                  <div className="browse-result-list">
                    {hubPacks.map((p) => (
                      <Link
                        key={p.key}
                        to="/hub"
                        className="browse-result-row"
                        style={{ textDecoration: "none", color: "inherit" }}
                      >
                        <div className="browse-result-meta">
                          <div className="browse-result-title">{p.source_name}</div>
                          <div className="browse-result-sub muted">
                            {MODALITY_LABEL[p.modality] || p.modality} /{" "}
                            {ONTOLOGY_LABEL[p.ontology] || p.ontology}
                            {" · "}
                            {p.formats.join("/")}
                            {" · "}
                            {p.file_count} 文件
                            {p.project ? ` · ${p.project}` : ""}
                          </div>
                          <div className="browse-result-tags">
                            {Object.entries(p.action_def?.taxonomy || {}).map(([sch, brief]) => {
                              const b = brief as { id?: number; code?: string; name?: string };
                              if (!b?.name) return null;
                              return (
                                <span key={`${sch}-${b.id}`} className="tag-chip">
                                  {taxonomySchemeLabel(sch, schemes)}:
                                  {b.code ? `${b.code} ` : ""}
                                  {b.name}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              <h3 style={{ margin: "8px 0 0", fontSize: "1rem" }}>
                {browseMode === "folder" ? "条目" : "旧库条目（MotionClip）"}
              </h3>
              <div className="browse-result-list">
                {listItems.map((item) => (
                  <div
                    key={item.id}
                    className="browse-result-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedClipId(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedClipId(item.id);
                      }
                    }}
                  >
                    <ResultThumb clipId={item.id} />
                    <div className="browse-result-meta">
                      <div
                        className="browse-result-title"
                        title={item.action_name || item.summary || undefined}
                      >
                        {item.action_name || item.summary || `条目 #${item.id}`}
                        {item.action_version ? (
                          <span className="muted" style={{ fontWeight: 400 }}>
                            {" "}
                            · v{item.action_version}
                          </span>
                        ) : null}
                      </div>
                      <div className="browse-result-sub muted">
                        {item.folder_path}
                        {item.human_formats?.length
                          ? ` · ${item.human_formats.join("/")}`
                          : ""}
                        {item.has_video ? " · 视频" : ""}
                      </div>
                      <div className="browse-result-tags">
                        {Object.values(item.taxonomy_tags || {}).map((t) => (
                          <span
                            key={`${t.scheme}-${t.id}`}
                            className="tag-chip"
                            title={`${taxonomySchemeLabel(t.scheme, schemes)}: ${tagLabel(t)}`}
                          >
                            {taxonomySchemeLabel(t.scheme, schemes)}:{tagLabel(t)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
                {!listItems.length && !hubPacks.length && (
                  <div className="muted" style={{ padding: "1.5rem 0.5rem" }}>
                    当前分类下暂无数据。可切换分类节点，或到「上传 → 维度仓库」入库并打标。
                  </div>
                )}
                {!listItems.length && !!hubPacks.length && (
                  <div className="muted" style={{ padding: "0.5rem" }}>
                    当前分类下无旧库条目；上方为维度仓库匹配结果。
                  </div>
                )}
              </div>

              {listTotal > 20 && (
                <div className="row" style={{ justifyContent: "center", gap: 8 }}>
                  <button
                    type="button"
                    className="secondary"
                    disabled={page <= 1}
                    onClick={() => void loadList(page - 1)}
                  >
                    上一页
                  </button>
                  <span className="muted">
                    {page} / {Math.max(1, Math.ceil(listTotal / 20))}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={page * 20 >= listTotal}
                    onClick={() => void loadList(page + 1)}
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </ResizableColumns>
    </div>
  );
}
