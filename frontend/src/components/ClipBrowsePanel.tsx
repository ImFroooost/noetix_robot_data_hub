import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, getToken } from "../api";
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
  STAGE_LABEL,
  VIDEO_KIND_LABEL,
  clipDisplayName,
  isPlayableHumanFormat,
  isPlayableRobotFormat,
  processStatusLabel,
  taxonomySchemeLabel,
  type VideoKind,
} from "../types";

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
}: {
  format: string;
  files: HumanFile[];
  clip: Clip;
  models: RobotModel[];
  canUpload: boolean;
  busy: boolean;
  onUpload: (format: string, file: File) => void;
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
}: {
  groupKey: string;
  files: RobotFile[];
  clip: Clip;
  models: RobotModel[];
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

      {/* 人体：每格式一块工作区 · Tab 切换单预览 */}
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>人体数据</h3>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.85rem" }}>
              每种格式一块工作区；仅 bvh / fbx / smpl 可可视化播放，其余格式仅存档。
            </p>
          </div>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {humanColumns.length} 种格式 · 共 {humanCount} 个文件
          </span>
        </div>
        {!humanColumns.length && <div className="muted">暂无人体文件</div>}
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

      {!clip.human_files.some((f) => isPlayableHumanFormat(f.format)) &&
        clip.robot_files.some((f) => isPlayableRobotFormat(f.format)) && (
          <div className="card stack">
            <h3 style={{ margin: 0 }}>动作可视化</h3>
            <MotionViewer clip={clip} robotModels={models} tall />
          </div>
        )}

      {/* 机器人：每组工作区 · Tab + 单预览 */}
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>机器人数据</h3>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.85rem" }}>
              按型号/阶段/格式分块；仅 csv 可可视化播放，其余格式仅存档。
            </p>
          </div>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {robotGroups.length} 组 · 共 {clip.robot_files.length} 个文件
          </span>
        </div>
        {!robotGroups.length && <div className="muted">暂无机器人文件</div>}
        <div className="preview-workspace-stack">
          {robotGroups.map(({ key, files }) => (
            <RobotGroupWorkspace
              key={key}
              groupKey={key}
              files={files}
              clip={clip}
              models={models}
            />
          ))}
        </div>
      </div>

      {/* 视频：真人 / 机器人 motion */}
      <div className="card stack">
        <h3 style={{ margin: 0 }}>视频</h3>
        {!clip.real_videos.length && <div className="muted">暂无视频</div>}
        <div className="real-video-grid">
          {clip.real_videos.map((v) => (
            <figure key={v.id} className="real-video-card">
              <AuthVideo fileId={v.id} />
              <figcaption>
                <span title={v.original_name || undefined}>
                  {v.original_name || `video#${v.id}`}
                </span>
                <span className="muted">
                  {VIDEO_KIND_LABEL[(v.kind || "human") as VideoKind] || v.kind} ·{" "}
                  {QUALITY_LABEL[v.quality]}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}
