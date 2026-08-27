import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, downloadAuth, getToken } from "../api";
import { MotionViewer } from "./MotionViewer";
import { TaxonomySelect } from "./TaxonomyTree";
import { VersionPreviewWorkspace } from "./VersionPreviewWorkspace";
import type {
  Clip,
  HumanFile,
  RobotFile,
  RobotModel,
  TaxonomyNode,
  TaxonomySchemeDef,
} from "../types";
import {
  QUALITY_LABEL,
  REVIEW_OPTIONS,
  ROBOT_VIDEO_KINDS,
  STAGE_LABEL,
  VIDEO_KIND_LABEL,
  clipDisplayName,
  isPlayableHumanFormat,
  isPlayableRobotFormat,
  processStatusLabel,
  taxonomySchemeLabel,
  type ReviewValue,
  type VideoKind,
} from "../types";

function ReviewSelect({
  value,
  disabled,
  onChange,
}: {
  value: string | undefined;
  disabled?: boolean;
  onChange: (v: ReviewValue) => void;
}) {
  const cur = (value || "") as ReviewValue;
  return (
    <select
      value={cur}
      disabled={disabled}
      title="数据评价"
      className={`review-select review-${cur || "none"}`}
      onChange={(e) => onChange(e.target.value as ReviewValue)}
    >
      {REVIEW_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function FileActions({
  review,
  canAnnotate,
  canEdit,
  canDownload,
  busy,
  currentName,
  onReview,
  onRename,
  onDelete,
  onDownload,
}: {
  review: string | undefined;
  canAnnotate: boolean;
  canEdit: boolean;
  canDownload: boolean;
  busy?: boolean;
  currentName?: string;
  onReview: (v: ReviewValue) => Promise<void> | void;
  onRename: (name: string) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
  onDownload: () => void;
}) {
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
      <span className="muted" style={{ fontSize: "0.8rem" }}>
        数据评价
      </span>
      {canAnnotate ? (
        <ReviewSelect value={review} disabled={busy} onChange={(v) => void onReview(v)} />
      ) : (
        <span className="badge">
          {REVIEW_OPTIONS.find((o) => o.value === (review || ""))?.label || "未评价"}
        </span>
      )}
      {canDownload && (
        <button type="button" className="secondary" disabled={busy} onClick={onDownload}>
          下载
        </button>
      )}
      {canEdit && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            const name = prompt("新文件名：", currentName || "");
            if (name && name.trim()) void onRename(name.trim());
          }}
        >
          重命名
        </button>
      )}
      {canEdit && (
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => {
            if (confirm("确认删除该文件？")) void onDelete();
          }}
        >
          删除
        </button>
      )}
    </div>
  );
}

function AuthVideo({ fileId }: { fileId: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let objectUrl = "";
    let cancelled = false;
    const token = getToken();
    fetch(api.fileUrl("video", fileId), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => {
        if (!r.ok) throw new Error("视频加载失败");
        return r.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setSrc("");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId]);
  if (!src) return <div className="muted">视频加载中…</div>;
  return (
    <video controls style={{ width: "100%", aspectRatio: "16 / 9", background: "#000" }} src={src} />
  );
}

function VideoGrid({
  videos,
  clip,
  busy,
  onChanged,
  emptyText,
}: {
  videos: import("../types").RealVideo[];
  clip: Clip;
  busy: boolean;
  onChanged: () => void;
  emptyText: string;
}) {
  if (!videos.length) return <div className="muted">{emptyText}</div>;
  const canAnn = !!clip.can_annotate || !!clip.can_edit;
  return (
    <div className="real-video-grid">
      {videos.map((v) => (
        <figure key={v.id} className="real-video-card">
          <AuthVideo fileId={v.id} />
          <figcaption>
            <span title={v.original_name || undefined}>
              {v.original_name || `video#${v.id}`}
            </span>
            <span className="muted">
              {canAnn ? (
                <select
                  value={(v.kind || "human") as string}
                  disabled={busy}
                  title="视频类型"
                  onChange={async (e) => {
                    await api.updateRealVideo(v.id, { kind: e.target.value });
                    onChanged();
                  }}
                >
                  {Object.entries(VIDEO_KIND_LABEL).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : (
                VIDEO_KIND_LABEL[(v.kind || "human") as VideoKind] || v.kind
              )}{" "}
              · {QUALITY_LABEL[v.quality]}
            </span>
            <FileActions
              review={v.review}
              canAnnotate={canAnn}
              canEdit={!!clip.can_edit}
              canDownload={!!v.can_download}
              busy={busy}
              onReview={async (val) => {
                await api.updateRealVideo(v.id, { review: val });
                onChanged();
              }}
              onRename={async (name) => {
                await api.updateRealVideo(v.id, { original_name: name });
                onChanged();
              }}
              onDelete={async () => {
                await api.deleteClipFile("video", v.id);
                onChanged();
              }}
              onDownload={() =>
                downloadAuth(api.fileUrl("video", v.id), v.original_name || `video-${v.id}.mp4`)
              }
              currentName={v.original_name}
            />
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

const HUMAN_FORMAT_ORDER = ["bvh", "fbx", "csv", "ser.pkl", "pkl", "tak", "smpl"];

function groupHumanByFormat(files: HumanFile[]): { format: string; files: HumanFile[] }[] {
  const m = new Map<string, HumanFile[]>();
  for (const f of files) {
    const k = (f.format || "unknown").toLowerCase();
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(f);
  }
  for (const list of m.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  }
  const keys = [...m.keys()].sort((a, b) => {
    const ai = HUMAN_FORMAT_ORDER.indexOf(a);
    const bi = HUMAN_FORMAT_ORDER.indexOf(b);
    const ao = ai === -1 ? 99 : ai;
    const bo = bi === -1 ? 99 : bi;
    if (ao !== bo) return ao - bo;
    return a.localeCompare(b);
  });
  return keys.map((format) => ({ format, files: m.get(format)! }));
}

function groupRobot(files: RobotFile[]): { key: string; files: RobotFile[] }[] {
  const m = new Map<string, RobotFile[]>();
  for (const f of files) {
    const k = `${f.robot_model_name || f.robot_model_id} · ${STAGE_LABEL[f.stage] || f.stage} · ${f.format}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(f);
  }
  for (const list of m.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  }
  return [...m.entries()].map(([key, files]) => ({ key, files }));
}

function HumanFormatWorkspace({
  format,
  files,
  clip,
  models,
  canUpload,
  busy,
  onUpload,
  onChanged,
}: {
  format: string;
  files: HumanFile[];
  clip: Clip;
  models: RobotModel[];
  canUpload: boolean;
  busy: boolean;
  onUpload: (format: string, file: File) => void;
  onChanged: () => void;
}) {
  const [activeId, setActiveId] = useState(files[0]?.id ?? 0);
  useEffect(() => {
    if (!files.some((f) => f.id === activeId)) {
      setActiveId(files[0]?.id ?? 0);
    }
  }, [files, activeId]);

  const active = files.find((f) => f.id === activeId) || files[0] || null;
  const playable = isPlayableHumanFormat(format);

  return (
    <VersionPreviewWorkspace
      badge={format.toUpperCase()}
      subtitle={
        playable
          ? `${files.length} 个版本 · 可可视化`
          : `${files.length} 个版本 · 仅存档`
      }
      tabs={files.map((f, i) => ({
        id: f.id,
        label: f.label || `v${i + 1}`,
      }))}
      activeId={active?.id ?? null}
      onChange={setActiveId}
      headerActions={
        canUpload ? (
          <label
            className="btn secondary"
            style={{
              cursor: busy ? "wait" : "pointer",
              flexShrink: 0,
              padding: "0.25rem 0.5rem",
              fontSize: "0.8rem",
            }}
            title={`上传 ${format} 新版本`}
          >
            +版本
            <input
              type="file"
              hidden
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) onUpload(format, file);
              }}
            />
          </label>
        ) : undefined
      }
      inspector={
        active ? (
          <>
            <dl>
              <div>
                <dt>当前版本</dt>
                <dd>{active.label || "v1"}</dd>
              </div>
              <div>
                <dt>文件名</dt>
                <dd title={active.original_name || undefined}>
                  {active.original_name || `#${active.id}`}
                </dd>
              </div>
              <div>
                <dt>质量</dt>
                <dd>{QUALITY_LABEL[active.quality]}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{processStatusLabel(active.process_status)}</dd>
              </div>
              <div>
                <dt>帧率</dt>
                <dd>{active.fps ? `${active.fps} Hz` : "—"}</dd>
              </div>
              <div>
                <dt>帧数</dt>
                <dd>{active.frame_count ?? "—"}</dd>
              </div>
              {active.process_message && (
                <div>
                  <dt>备注</dt>
                  <dd>{active.process_message}</dd>
                </div>
              )}
            </dl>
            <FileActions
              review={active.review}
              canAnnotate={!!clip.can_annotate || !!clip.can_edit}
              canEdit={!!clip.can_edit}
              canDownload={!!active.can_download}
              busy={busy}
              onReview={async (v) => {
                await api.updateHumanFile(active.id, { review: v });
                onChanged();
              }}
              onRename={async (name) => {
                await api.updateHumanFile(active.id, { original_name: name });
                onChanged();
              }}
              onDelete={async () => {
                await api.deleteClipFile("human", active.id);
                onChanged();
              }}
              onDownload={() =>
                downloadAuth(
                  api.fileUrl("human", active.id),
                  active.original_name || `${format}-${active.id}`
                )
              }
              currentName={active.original_name}
            />
          </>
        ) : null
      }
    >
      {active && playable ? (
        <MotionViewer
          key={`human-${active.id}`}
          clip={clip}
          robotModels={models}
          humanFileId={active.id}
          hideRobot
          tall
          controlsOnly
        />
      ) : (
        <div className="muted" style={{ padding: "1.25rem 0.5rem" }}>
          该格式仅存档下载，不支持可视化播放（人体仅 bvh / fbx / smpl）。
        </div>
      )}
    </VersionPreviewWorkspace>
  );
}

function RobotGroupWorkspace({
  groupKey,
  files,
  clip,
  models,
  busy,
  onChanged,
}: {
  groupKey: string;
  files: RobotFile[];
  clip: Clip;
  models: RobotModel[];
  busy: boolean;
  onChanged: () => void;
}) {
  const [activeId, setActiveId] = useState(files[0]?.id ?? 0);
  useEffect(() => {
    if (!files.some((f) => f.id === activeId)) {
      setActiveId(files[0]?.id ?? 0);
    }
  }, [files, activeId]);

  const active = files.find((f) => f.id === activeId) || files[0] || null;
  const playable = isPlayableRobotFormat(active?.format);
  const refHumanId =
    clip.human_files.find((f) => isPlayableHumanFormat(f.format))?.id ?? undefined;

  return (
    <VersionPreviewWorkspace
      badge={groupKey}
      subtitle={
        playable
          ? `${files.length} 个版本 · 可可视化`
          : `${files.length} 个版本 · 仅存档`
      }
      tabs={files.map((f, i) => ({
        id: f.id,
        label: f.label || `v${i + 1}`,
      }))}
      activeId={active?.id ?? null}
      onChange={setActiveId}
      inspector={
        active ? (
          <>
            <dl>
              <div>
                <dt>当前版本</dt>
                <dd>{active.label || "v1"}</dd>
              </div>
              <div>
                <dt>文件名</dt>
                <dd title={active.original_name || undefined}>
                  {active.original_name || `#${active.id}`}
                </dd>
              </div>
              <div>
                <dt>型号</dt>
                <dd>{active.robot_model_name || active.robot_model_id}</dd>
              </div>
              <div>
                <dt>阶段</dt>
                <dd>{STAGE_LABEL[active.stage] || active.stage}</dd>
              </div>
              <div>
                <dt>格式</dt>
                <dd>{active.format}</dd>
              </div>
              <div>
                <dt>质量</dt>
                <dd>{QUALITY_LABEL[active.quality]}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{processStatusLabel(active.process_status)}</dd>
              </div>
              <div>
                <dt>帧率</dt>
                <dd>{active.fps ? `${active.fps} Hz` : "—"}</dd>
              </div>
              <div>
                <dt>帧数</dt>
                <dd>{active.frame_count ?? "—"}</dd>
              </div>
            </dl>
            <FileActions
              review={active.review}
              canAnnotate={!!clip.can_annotate || !!clip.can_edit}
              canEdit={!!clip.can_edit}
              canDownload={!!active.can_download}
              busy={busy}
              onReview={async (v) => {
                await api.updateRobotFile(active.id, { review: v });
                onChanged();
              }}
              onRename={async (name) => {
                await api.updateRobotFile(active.id, { original_name: name });
                onChanged();
              }}
              onDelete={async () => {
                await api.deleteClipFile("robot", active.id);
                onChanged();
              }}
              onDownload={() =>
                downloadAuth(
                  api.fileUrl("robot", active.id),
                  active.original_name || `robot-${active.id}.${active.format}`
                )
              }
              currentName={active.original_name}
            />
          </>
        ) : null
      }
    >
      {active && playable ? (
        <MotionViewer
          key={`robot-${active.id}`}
          clip={clip}
          robotModels={models}
          humanFileId={refHumanId}
          robotFileId={active.id}
          tall
          controlsOnly
        />
      ) : (
        <div className="muted" style={{ padding: "1.25rem 0.5rem" }}>
          该格式仅存档下载，不支持可视化播放（机器人仅 csv）。
        </div>
      )}
    </VersionPreviewWorkspace>
  );
}

interface Props {
  clipId: number;
  onUpdated?: () => void;
  schemes?: TaxonomySchemeDef[];
  taxNodes?: TaxonomyNode[];
}

export function ClipBrowsePanel({
  clipId,
  onUpdated,
  schemes = [],
  taxNodes = [],
}: Props) {
  const [clip, setClip] = useState<Clip | null>(null);
  const [models, setModels] = useState<RobotModel[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [localSchemes, setLocalSchemes] = useState<TaxonomySchemeDef[]>(schemes);
  const [localTax, setLocalTax] = useState<TaxonomyNode[]>(taxNodes);

  const reload = async () => {
    const [c, m] = await Promise.all([api.getClip(clipId), api.listRobotModels()]);
    setClip(c);
    setModels(m);
  };

  const reloadTaxonomies = async () => {
    setLocalTax(await api.listTaxonomies());
  };

  useEffect(() => {
    setLocalSchemes(schemes);
  }, [schemes]);
  useEffect(() => {
    setLocalTax(taxNodes);
  }, [taxNodes]);

  useEffect(() => {
    if (schemes.length && taxNodes.length) return;
    Promise.all([api.listTaxonomySchemes(), api.listTaxonomies()])
      .then(([s, t]) => {
        setLocalSchemes(s);
        setLocalTax(t);
      })
      .catch(() => undefined);
  }, [clipId]);

  useEffect(() => {
    setError("");
    setMsg("");
    setClip(null);
    reload().catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, [clipId]);

  const humanColumns = useMemo(
    () => (clip ? groupHumanByFormat(clip.human_files) : []),
    [clip]
  );
  const humanCount = clip?.human_files.length ?? 0;
  const robotGroups = useMemo(
    () => (clip ? groupRobot(clip.robot_files) : []),
    [clip]
  );
  const humanVideos = useMemo(
    () => (clip?.real_videos || []).filter((v) => (v.kind || "human") === "human"),
    [clip]
  );
  const robotVideos = useMemo(
    () => (clip?.real_videos || []).filter((v) => (v.kind || "human") !== "human"),
    [clip]
  );
  const sharedTexts = clip?.shared_texts || [];

  const uploadHumanVersion = async (format: string, file: File) => {
    if (!clip) return;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const fd = new FormData();
      fd.set("format", format);
      fd.set("quality", "medium");
      fd.set("file", file);
      await api.uploadHuman(clip.id, fd);
      await reload();
      onUpdated?.();
      setMsg(`已上传 ${format} 新版本`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };

  const uploadVideo = async (kind: VideoKind, file: File) => {
    if (!clip) return;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const fd = new FormData();
      fd.set("kind", kind);
      fd.set("quality", "medium");
      fd.set("file", file);
      await api.uploadRealVideo(clip.id, fd);
      await reload();
      onUpdated?.();
      setMsg(`已上传${VIDEO_KIND_LABEL[kind] || kind}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };

  const uploadSharedText = async (file: File) => {
    if (!clip) return;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const fd = new FormData();
      fd.set("file", file);
      await api.uploadSharedText(clip.id, fd);
      await reload();
      onUpdated?.();
      setMsg("已上传文本描述");
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };

  const afterFileChange = () => {
    void reload().then(() => onUpdated?.());
  };

  if (error && !clip) return <div className="error">{error}</div>;
  if (!clip) return <div className="muted">加载条目 #{clipId}…</div>;

  return (
    <div className="stack clip-browse-panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: "0 0 4px" }}>{clipDisplayName(clip)}</h2>
          <div className="muted" style={{ fontSize: "0.85rem" }}>
            {clip.folder_path} · #{clip.id}
            {clip.action_code ? ` · 动作ID ${clip.action_code}` : ""}
            {clip.action_version ? ` · v${clip.action_version}` : ""}
          </div>
        </div>
        <Link className="btn secondary" to={`/clips/${clip.id}`}>
          完整详情页
        </Link>
      </div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="success">{msg}</div>}

      <div className="card stack">
        <h3 style={{ margin: 0 }}>动作定义</h3>
        <div className="stack" style={{ gap: 6, fontSize: "0.9rem" }}>
          {clip.brief && (
            <div>
              <span className="muted">简释 · </span>
              {clip.brief}
            </div>
          )}
          {clip.detail_def && (
            <div>
              <span className="muted">详细定义 · </span>
              <span style={{ whiteSpace: "pre-wrap" }}>{clip.detail_def}</span>
            </div>
          )}
          {(clip.description || clip.summary) && (
            <div>
              <span className="muted">详细描述 · </span>
              <span style={{ whiteSpace: "pre-wrap" }}>{clip.description || clip.summary}</span>
            </div>
          )}
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            {clip.atomic_tag && (
              <span className="badge">
                原子：{clip.atomic_tag.code ? `${clip.atomic_tag.code} ` : ""}
                {clip.atomic_tag.name}
              </span>
            )}
            {clip.routine_label && <span className="badge">套路：{clip.routine_label}</span>}
            {clip.duel_label && <span className="badge">决斗：{clip.duel_label}</span>}
            {clip.compute_level && <span className="badge">算力：{clip.compute_level}</span>}
          </div>
        </div>
        {(clip.multimodal_overall || clip.multimodal_segment || clip.multimodal_atomic) && (
          <div className="stack" style={{ gap: 4, marginTop: 8 }}>
            <div className="muted" style={{ fontSize: "0.85rem" }}>
              多模态
            </div>
            {clip.multimodal_overall && (
              <div style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem" }}>
                整体：{clip.multimodal_overall}
              </div>
            )}
            {clip.multimodal_segment && (
              <div style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem" }}>
                分段：{clip.multimodal_segment}
              </div>
            )}
            {clip.multimodal_atomic && (
              <div style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem" }}>
                原子：{clip.multimodal_atomic}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>分类标签</h3>
        {localSchemes.length === 0 && <div className="muted">暂无分类标准</div>}
        {localSchemes.map((sch) => {
          const cur = clip.taxonomy_tags?.[sch.key];
          const canEdit = clip.can_annotate || clip.can_edit;
          return (
            <label key={sch.key}>
              {taxonomySchemeLabel(sch.key, localSchemes)}
              {canEdit ? (
                <TaxonomySelect
                  scheme={sch.key}
                  nodes={localTax.filter((n) => n.scheme === sch.key)}
                  value={cur?.id ?? ""}
                  onChange={async (id) => {
                    try {
                      setBusy(true);
                      await api.updateClip(clip.id, {
                        taxonomy_tag_ids: { [sch.key]: id === "" ? null : id },
                      });
                      await reload();
                      onUpdated?.();
                      setMsg(`已更新「${sch.name}」标签`);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "更新标签失败");
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                  canCreate={!!clip.can_edit}
                  onNodesReload={reloadTaxonomies}
                />
              ) : (
                <div>
                  {cur
                    ? `${cur.code ? cur.code + " " : ""}${cur.name}`
                    : "未标注"}
                </div>
              )}
            </label>
          );
        })}
      </div>

      {/* ===== 数据单元 · 人体（视频 + 动作数据） ===== */}
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>人体</h3>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.85rem" }}>
              视频 + 动作数据（smpl / fbx / bvh / csv …）；仅 bvh / fbx / smpl 可可视化播放。
            </p>
          </div>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {humanColumns.length} 种格式 · 共 {humanCount} 个文件
          </span>
        </div>

        <h4 style={{ margin: "4px 0 0" }}>视频</h4>
        <VideoGrid
          videos={humanVideos}
          clip={clip}
          busy={busy}
          onChanged={afterFileChange}
          emptyText="暂无真人视频"
        />
        {clip.can_upload && (
          <label className="btn secondary" style={{ cursor: "pointer", alignSelf: "flex-start" }}>
            + 上传真人视频
            <input
              type="file"
              hidden
              accept="video/*"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void uploadVideo("human", file);
              }}
            />
          </label>
        )}

        <h4 style={{ margin: "8px 0 0" }}>动作数据</h4>
        {!humanColumns.length && <div className="muted">暂无人体动作文件</div>}
        <div className="preview-workspace-stack">
          {humanColumns.map(({ format, files }) => (
            <HumanFormatWorkspace
              key={format}
              format={format}
              files={files}
              clip={clip}
              models={models}
              canUpload={!!clip.can_upload}
              busy={busy}
              onUpload={uploadHumanVersion}
              onChanged={afterFileChange}
            />
          ))}
        </div>
        {clip.can_upload && (
          <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span className="muted">新增格式：</span>
            {HUMAN_FORMAT_ORDER.map((fmt) => (
              <label key={fmt} className="btn secondary" style={{ cursor: "pointer" }}>
                + {fmt}
                <input
                  type="file"
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void uploadHumanVersion(fmt, file);
                  }}
                />
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ===== 数据单元 · 人机共享（文本描述） ===== */}
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>人机共享</h3>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.85rem" }}>
              文本描述（txt / json …）
            </p>
          </div>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            共 {sharedTexts.length} 个文件
          </span>
        </div>
        {!sharedTexts.length && <div className="muted">暂无文本描述</div>}
        {sharedTexts.map((t) => (
          <div key={t.id} className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span className="badge">{(t.format || "txt").toUpperCase()}</span>
            <span title={t.original_name || undefined}>
              {t.original_name || `text#${t.id}`}
            </span>
            <FileActions
              review={t.review}
              canAnnotate={!!clip.can_annotate || !!clip.can_edit}
              canEdit={!!clip.can_edit}
              canDownload={!!t.can_download}
              busy={busy}
              onReview={async (v) => {
                await api.updateSharedText(t.id, { review: v });
                afterFileChange();
              }}
              onRename={async (name) => {
                await api.updateSharedText(t.id, { original_name: name });
                afterFileChange();
              }}
              onDelete={async () => {
                await api.deleteClipFile("shared", t.id);
                afterFileChange();
              }}
              onDownload={() =>
                downloadAuth(api.fileUrl("shared", t.id), t.original_name || `text-${t.id}.${t.format}`)
              }
              currentName={t.original_name}
            />
          </div>
        ))}
        {clip.can_upload && (
          <label className="btn secondary" style={{ cursor: "pointer", alignSelf: "flex-start" }}>
            + 上传文本描述（txt / json）
            <input
              type="file"
              hidden
              accept=".txt,.json,.md,.yaml,.yml"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void uploadSharedText(file);
              }}
            />
          </label>
        )}
      </div>

      {!clip.human_files.some((f) => isPlayableHumanFormat(f.format)) &&
        clip.robot_files.some((f) => isPlayableRobotFormat(f.format)) && (
          <div className="card stack">
            <h3 style={{ margin: 0 }}>动作可视化</h3>
            <MotionViewer clip={clip} robotModels={models} tall />
          </div>
        )}

      {/* ===== 数据单元 · 机器人（动力学数据 + 视频） ===== */}
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>机器人</h3>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.85rem" }}>
              动力学数据（csv / json）+ 视频（motion播放 / 策略仿真 / 策略真机）
            </p>
          </div>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {robotGroups.length} 组 · 共 {clip.robot_files.length} 个文件
          </span>
        </div>

        <h4 style={{ margin: "4px 0 0" }}>动力学数据</h4>
        {!robotGroups.length && <div className="muted">暂无机器人动力学文件（可在完整详情页上传）</div>}
        <div className="preview-workspace-stack">
          {robotGroups.map(({ key, files }) => (
            <RobotGroupWorkspace
              key={key}
              groupKey={key}
              files={files}
              clip={clip}
              models={models}
              busy={busy}
              onChanged={afterFileChange}
            />
          ))}
        </div>

        <h4 style={{ margin: "8px 0 0" }}>视频</h4>
        <VideoGrid
          videos={robotVideos}
          clip={clip}
          busy={busy}
          onChanged={afterFileChange}
          emptyText="暂无机器人视频"
        />
        {clip.can_upload && (
          <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            {ROBOT_VIDEO_KINDS.map((k) => (
              <label key={k} className="btn secondary" style={{ cursor: "pointer" }}>
                + {VIDEO_KIND_LABEL[k]}
                <input
                  type="file"
                  hidden
                  accept="video/*"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void uploadVideo(k, file);
                  }}
                />
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
