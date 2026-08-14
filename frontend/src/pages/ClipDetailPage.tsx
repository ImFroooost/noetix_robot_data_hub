import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, downloadAuth } from "../api";
import { useAuth } from "../auth";
import { MotionViewer } from "../components/MotionViewer";
import type { Clip, Quality, RobotModel, RobotStage } from "../types";
import { QUALITY_LABEL, STAGE_LABEL, processStatusLabel } from "../types";

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

  const saveMeta = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    try {
      const updated = await api.updateClip(clipId, {
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
      setClip(updated);
      setMsg("已保存元数据");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  };

  const uploadHuman = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await api.uploadHuman(clipId, fd);
    e.currentTarget.reset();
    await reload();
    setMsg("人体文件已上传，正在预处理…");
  };

  const uploadRobot = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await api.uploadRobot(clipId, fd);
    e.currentTarget.reset();
    await reload();
    setMsg("机器人文件已上传，正在预处理…");
  };

  if (!clip) {
    return <div className="page muted">{error || "加载中…"}</div>;
  }

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
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            />
          </label>
          <label>
            动作子类
            <input
              value={form.subcategory}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, subcategory: e.target.value })}
            />
          </label>
          <label>
            语言概括
            <input
              value={form.summary}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
            />
          </label>
          <label>
            语言详细描述
            <textarea
              value={form.description}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <label>
            标签（逗号分隔）
            <input
              value={form.tags}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
            />
          </label>
          <label>
            时长（秒，对齐基准）
            <input
              value={form.duration_sec}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, duration_sec: e.target.value })}
            />
          </label>
          {canEdit && <button type="submit">保存</button>}
          {canEdit && (
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
          <div className="card stack">
            <h2>人体动捕文件</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>格式</th>
                  <th>帧率</th>
                  <th>帧数</th>
                  <th>质量</th>
                  <th>状态</th>
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
                      {canEdit ? (
                        <select
                          value={f.quality}
                          onChange={async (e) => {
                            await api.updateHumanFile(f.id, {
                              quality: e.target.value as Quality,
                            });
                            await reload();
                          }}
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
                    <td>{processStatusLabel(f.process_status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canEdit && (
              <form className="stack" onSubmit={uploadHuman}>
                <h3>补充人体文件</h3>
                <label>
                  格式
                  <input name="format" placeholder="bvh/fbx/csv/ser.pkl/pkl" required />
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

          <div className="card stack">
            <h2>机器人数据</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>型号</th>
                  <th>阶段</th>
                  <th>格式</th>
                  <th>帧率</th>
                  <th>质量</th>
                  <th>状态</th>
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
                      {canEdit ? (
                        <select
                          value={f.quality}
                          onChange={async (e) => {
                            await api.updateRobotFile(f.id, {
                              quality: e.target.value as Quality,
                            });
                            await reload();
                          }}
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
                    <td>{processStatusLabel(f.process_status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canEdit && (
              <form className="stack" onSubmit={uploadRobot}>
                <h3>补充机器人文件</h3>
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
          </div>
        </div>
      </div>
    </div>
  );
}
