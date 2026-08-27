import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, downloadAuth } from "../api";
import { useAuth } from "../auth";
import { MotionViewer } from "../components/MotionViewer";
import type { Clip, Quality, RobotModel, RobotStage, ReviewValue } from "../types";
import {
  QUALITY_LABEL,
  REVIEW_OPTIONS,
  ROBOT_VIDEO_KINDS,
  STAGE_LABEL,
  VIDEO_KIND_LABEL,
  processStatusLabel,
} from "../types";

function ReviewCell({
  value,
  canAnnotate,
  onChange,
}: {
  value: string | undefined;
  canAnnotate: boolean;
  onChange: (v: ReviewValue) => void;
}) {
  const cur = (value || "") as ReviewValue;
  if (!canAnnotate) {
    return <span>{REVIEW_OPTIONS.find((o) => o.value === cur)?.label || "未评价"}</span>;
  }
  return (
    <select value={cur} onChange={(e) => onChange(e.target.value as ReviewValue)}>
      {REVIEW_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function ClipDetailPage() {
  const { id } = useParams();
  const clipId = Number(id);
  const { canEdit } = useAuth();
  const nav = useNavigate();
  const [clip, setClip] = useState<Clip | null>(null);
  const [models, setModels] = useState<RobotModel[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({
    category: "",
    subcategory: "",
    summary: "",
    description: "",
    tags: "",
    duration_sec: "",
  });

  const reload = async () => {
    const [c, m] = await Promise.all([api.getClip(clipId), api.listRobotModels()]);
    setClip(c);
    setModels(m);
    setForm({
      category: c.category,
      subcategory: c.subcategory,
      summary: c.summary,
      description: c.description,
      tags: (c.tags || []).join(", "),
      duration_sec: c.duration_sec != null ? String(c.duration_sec) : "",
    });
  };

  useEffect(() => {
    reload().catch((e) => setError(e.message));
  }, [clipId]);

  const wrap = async (fn: () => Promise<void>, okMsg?: string) => {
    setMsg("");
    setError("");
    try {
      await fn();
      await reload();
      if (okMsg) setMsg(okMsg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  };

  const renameFile = (
    kind: "human" | "robot" | "video" | "shared",
    fileId: number,
    currentName: string
  ) => {
    const name = prompt("新文件名：", currentName || "");
    if (!name || !name.trim()) return;
    const body = { original_name: name.trim() };
    void wrap(async () => {
      if (kind === "human") await api.updateHumanFile(fileId, body);
      else if (kind === "robot") await api.updateRobotFile(fileId, body);
      else if (kind === "video") await api.updateRealVideo(fileId, body);
      else await api.updateSharedText(fileId, body);
    }, "已重命名");
  };

  const deleteFile = (kind: "human" | "robot" | "video" | "shared", fileId: number) => {
    if (!confirm("确认删除该文件？")) return;
    void wrap(async () => {
      await api.deleteClipFile(kind, fileId);
    }, "已删除");
  };

  const saveMeta = async (e: FormEvent) => {
    e.preventDefault();
    await wrap(async () => {
      await api.updateClip(clipId, {
        category: form.category,
        subcategory: form.subcategory,
        summary: form.summary,
        description: form.description,
        tags: form.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        duration_sec: form.duration_sec ? Number(form.duration_sec) : null,
      });
    }, "已保存元数据");
  };

  const uploadHuman = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const fd = new FormData(el);
    await wrap(async () => {
      await api.uploadHuman(clipId, fd);
      el.reset();
    }, "人体文件已上传，正在预处理…");
  };

  const uploadRobot = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const fd = new FormData(el);
    await wrap(async () => {
      await api.uploadRobot(clipId, fd);
      el.reset();
    }, "机器人文件已上传，正在预处理…");
  };

  const uploadVideo = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const fd = new FormData(el);
    await wrap(async () => {
      await api.uploadRealVideo(clipId, fd);
      el.reset();
    }, "视频已上传");
  };

  const uploadShared = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const fd = new FormData(el);
    await wrap(async () => {
      await api.uploadSharedText(clipId, fd);
      el.reset();
    }, "文本描述已上传");
  };

  if (!clip) {
    return <div className="page muted">{error || "加载中…"}</div>;
  }

  const canAnn = !!clip.can_annotate || !!clip.can_edit || canEdit;
  const canEditClip = !!clip.can_edit || canEdit;
  const canUpload = !!clip.can_upload || canEdit;
  const humanVideos = (clip.real_videos || []).filter((v) => (v.kind || "human") === "human");
  const robotVideos = (clip.real_videos || []).filter((v) => (v.kind || "human") !== "human");
  const sharedTexts = clip.shared_texts || [];

  return (
    <div className="page stack">
      <div className="row">
        <Link className="btn secondary" to="/">
          ← 返回检索
        </Link>
        <h1 style={{ margin: 0 }}>
          #{clip.id} {clip.summary || "未命名动作"}
        </h1>
      </div>
      {error && <div className="error">{error}</div>}
      {msg && <div className="success">{msg}</div>}

      <div className="card">
        <h2>可视化</h2>
        <MotionViewer clip={clip} robotModels={models} />
      </div>

      <div className="grid-2">
        <form className="card stack" onSubmit={saveMeta}>
          <h2>元数据</h2>
          <label>
            动作大类
            <input
              value={form.category}
              disabled={!canEditClip}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            />
          </label>
          <label>
            动作子类
            <input
              value={form.subcategory}
              disabled={!canEditClip}
              onChange={(e) => setForm({ ...form, subcategory: e.target.value })}
            />
          </label>
          <label>
            语言概括
            <input
              value={form.summary}
              disabled={!canEditClip}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
            />
          </label>
          <label>
            语言详细描述
            <textarea
              value={form.description}
              disabled={!canEditClip}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <label>
            标签（逗号分隔）
            <input
              value={form.tags}
              disabled={!canEditClip}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
            />
          </label>
          <label>
            时长（秒，对齐基准）
            <input
              value={form.duration_sec}
              disabled={!canEditClip}
              onChange={(e) => setForm({ ...form, duration_sec: e.target.value })}
            />
          </label>
          {canEditClip && <button type="submit">保存</button>}
          {canEditClip && (
            <button
              type="button"
              className="danger"
              onClick={async () => {
                if (!confirm("确认删除该条目？")) return;
                await api.deleteClip(clipId);
                nav("/");
              }}
            >
              删除条目
            </button>
          )}
        </form>

        <div className="stack">
          {/* ===== 人体：视频 + 动作数据 ===== */}
          <div className="card stack">
            <h2>人体</h2>
            <h3 style={{ margin: 0 }}>视频</h3>
            {!humanVideos.length && <div className="muted">暂无真人视频</div>}
            {humanVideos.map((v) => (
              <div key={v.id} className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    downloadAuth(api.fileUrl("video", v.id), v.original_name || `video-${v.id}.mp4`)
                  }
                >
                  {v.original_name || `video#${v.id}`}
                </button>
                <ReviewCell
                  value={v.review}
                  canAnnotate={canAnn}
                  onChange={(val) =>
                    void wrap(async () => {
                      await api.updateRealVideo(v.id, { review: val });
                    })
                  }
                />
                {canEditClip && (
                  <>
                    <button type="button" className="secondary" onClick={() => renameFile("video", v.id, v.original_name)}>
                      重命名
                    </button>
                    <button type="button" className="danger" onClick={() => deleteFile("video", v.id)}>
                      删除
                    </button>
                  </>
                )}
              </div>
            ))}
            {canUpload && (
              <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={uploadVideo}>
                <input type="hidden" name="kind" value="human" />
                <input name="file" type="file" accept="video/*" required />
                <button type="submit">上传真人视频</button>
              </form>
            )}

            <h3 style={{ margin: "8px 0 0" }}>动作数据</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>格式</th>
                  <th>帧率</th>
                  <th>帧数</th>
                  <th>质量</th>
                  <th>数据评价</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {clip.human_files.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          downloadAuth(api.fileUrl("human", f.id), f.original_name || f.format)
                        }
                      >
                        {f.format}
                      </button>
                    </td>
                    <td>{f.fps ?? "-"}</td>
                    <td>{f.frame_count ?? "-"}</td>
                    <td>
                      {canAnn ? (
                        <select
                          value={f.quality}
                          onChange={(e) =>
                            void wrap(async () => {
                              await api.updateHumanFile(f.id, {
                                quality: e.target.value as Quality,
                              });
                            })
                          }
                        >
                          {(["high", "medium", "low"] as const).map((q) => (
                            <option key={q} value={q}>
                              {QUALITY_LABEL[q]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={`badge ${f.quality}`}>{QUALITY_LABEL[f.quality]}</span>
                      )}
                    </td>
                    <td>
                      <ReviewCell
                        value={f.review}
                        canAnnotate={canAnn}
                        onChange={(val) =>
                          void wrap(async () => {
                            await api.updateHumanFile(f.id, { review: val });
                          })
                        }
                      />
                    </td>
                    <td>{processStatusLabel(f.process_status)}</td>
                    <td>
                      {canEditClip && (
                        <span className="row" style={{ gap: 4 }}>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => renameFile("human", f.id, f.original_name)}
                          >
                            重命名
                          </button>
                          <button type="button" className="danger" onClick={() => deleteFile("human", f.id)}>
                            删除
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canUpload && (
              <form className="stack" onSubmit={uploadHuman}>
                <h4 style={{ margin: 0 }}>补充人体动作文件</h4>
                <label>
                  格式
                  <input name="format" placeholder="smpl/fbx/bvh/csv…" required />
                </label>
                <label>
                  质量
                  <select name="quality" defaultValue="medium">
                    <option value="high">高</option>
                    <option value="medium">中</option>
                    <option value="low">低</option>
                  </select>
                </label>
                <label>
                  文件
                  <input name="file" type="file" required />
                </label>
                <button type="submit">上传</button>
              </form>
            )}
          </div>

          {/* ===== 人机共享：文本描述 ===== */}
          <div className="card stack">
            <h2>人机共享</h2>
            <h3 style={{ margin: 0 }}>文本描述（txt / json …）</h3>
            {!sharedTexts.length && <div className="muted">暂无文本描述</div>}
            {sharedTexts.map((t) => (
              <div key={t.id} className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <span className="badge">{(t.format || "txt").toUpperCase()}</span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    downloadAuth(api.fileUrl("shared", t.id), t.original_name || `text-${t.id}.${t.format}`)
                  }
                >
                  {t.original_name || `text#${t.id}`}
                </button>
                <ReviewCell
                  value={t.review}
                  canAnnotate={canAnn}
                  onChange={(val) =>
                    void wrap(async () => {
                      await api.updateSharedText(t.id, { review: val });
                    })
                  }
                />
                {canEditClip && (
                  <>
                    <button type="button" className="secondary" onClick={() => renameFile("shared", t.id, t.original_name)}>
                      重命名
                    </button>
                    <button type="button" className="danger" onClick={() => deleteFile("shared", t.id)}>
                      删除
                    </button>
                  </>
                )}
              </div>
            ))}
            {canUpload && (
              <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={uploadShared}>
                <input name="file" type="file" accept=".txt,.json,.md,.yaml,.yml" required />
                <button type="submit">上传文本描述</button>
              </form>
            )}
          </div>

          {/* ===== 机器人：动力学数据 + 视频 ===== */}
          <div className="card stack">
            <h2>机器人</h2>
            <h3 style={{ margin: 0 }}>动力学数据（csv / json）</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>型号</th>
                  <th>阶段</th>
                  <th>格式</th>
                  <th>帧率</th>
                  <th>质量</th>
                  <th>数据评价</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {clip.robot_files.map((f) => (
                  <tr key={f.id}>
                    <td>{f.robot_model_name}</td>
                    <td>{STAGE_LABEL[f.stage]}</td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          downloadAuth(api.fileUrl("robot", f.id), f.original_name || f.format)
                        }
                      >
                        {f.format}
                      </button>
                    </td>
                    <td>{f.fps ?? "-"}</td>
                    <td>
                      {canAnn ? (
                        <select
                          value={f.quality}
                          onChange={(e) =>
                            void wrap(async () => {
                              await api.updateRobotFile(f.id, {
                                quality: e.target.value as Quality,
                              });
                            })
                          }
                        >
                          {(["high", "medium", "low"] as const).map((q) => (
                            <option key={q} value={q}>
                              {QUALITY_LABEL[q]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={`badge ${f.quality}`}>{QUALITY_LABEL[f.quality]}</span>
                      )}
                    </td>
                    <td>
                      <ReviewCell
                        value={f.review}
                        canAnnotate={canAnn}
                        onChange={(val) =>
                          void wrap(async () => {
                            await api.updateRobotFile(f.id, { review: val });
                          })
                        }
                      />
                    </td>
                    <td>{processStatusLabel(f.process_status)}</td>
                    <td>
                      {canEditClip && (
                        <span className="row" style={{ gap: 4 }}>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => renameFile("robot", f.id, f.original_name)}
                          >
                            重命名
                          </button>
                          <button type="button" className="danger" onClick={() => deleteFile("robot", f.id)}>
                            删除
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canUpload && (
              <form className="stack" onSubmit={uploadRobot}>
                <h4 style={{ margin: 0 }}>补充机器人动力学文件</h4>
                <label>
                  型号
                  <select name="robot_model_id" required>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  阶段
                  <select name="stage" defaultValue="retarget">
                    {(["retarget", "polish", "refine", "real"] as RobotStage[]).map((s) => (
                      <option key={s} value={s}>
                        {STAGE_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  格式
                  <input name="format" defaultValue="csv" />
                </label>
                <label>
                  质量
                  <select name="quality" defaultValue="medium">
                    <option value="high">高</option>
                    <option value="medium">中</option>
                    <option value="low">低</option>
                  </select>
                </label>
                <label>
                  文件
                  <input name="file" type="file" required />
                </label>
                <button type="submit">上传</button>
              </form>
            )}

            <h3 style={{ margin: "8px 0 0" }}>视频（motion播放 / 策略仿真 / 策略真机）</h3>
            {!robotVideos.length && <div className="muted">暂无机器人视频</div>}
            {robotVideos.map((v) => (
              <div key={v.id} className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <span className="badge">{VIDEO_KIND_LABEL[v.kind] || v.kind}</span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    downloadAuth(api.fileUrl("video", v.id), v.original_name || `video-${v.id}.mp4`)
                  }
                >
                  {v.original_name || `video#${v.id}`}
                </button>
                {canAnn && (
                  <select
                    value={v.kind}
                    onChange={(e) =>
                      void wrap(async () => {
                        await api.updateRealVideo(v.id, { kind: e.target.value });
                      })
                    }
                  >
                    {ROBOT_VIDEO_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {VIDEO_KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                )}
                <ReviewCell
                  value={v.review}
                  canAnnotate={canAnn}
                  onChange={(val) =>
                    void wrap(async () => {
                      await api.updateRealVideo(v.id, { review: val });
                    })
                  }
                />
                {canEditClip && (
                  <>
                    <button type="button" className="secondary" onClick={() => renameFile("video", v.id, v.original_name)}>
                      重命名
                    </button>
                    <button type="button" className="danger" onClick={() => deleteFile("video", v.id)}>
                      删除
                    </button>
                  </>
                )}
              </div>
            ))}
            {canUpload && (
              <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={uploadVideo}>
                <select name="kind" defaultValue="robot_motion">
                  {ROBOT_VIDEO_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {VIDEO_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
                <input name="file" type="file" accept="video/*" required />
                <button type="submit">上传机器人视频</button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
