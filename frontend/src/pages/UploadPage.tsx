import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import type { RobotModel, RobotStage } from "../types";
import { STAGE_LABEL } from "../types";

export function UploadPage() {
  const { canEdit } = useAuth();
  const nav = useNavigate();
  const [models, setModels] = useState<RobotModel[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listRobotModels().then(setModels).catch(() => undefined);
  }, []);

  if (!canEdit) {
    return <div className="page error">没有上传权限</div>;
  }

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = e.currentTarget;
    const fd = new FormData(form);
    try {
      const tags = String(fd.get("tags") || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const clip = await api.createClip({
        category: fd.get("category"),
        subcategory: fd.get("subcategory"),
        summary: fd.get("summary"),
        description: fd.get("description"),
        tags,
        duration_sec: fd.get("duration_sec") ? Number(fd.get("duration_sec")) : null,
      });

      const humanFiles = form.querySelectorAll<HTMLInputElement>('input[name="human_file"]');
      const humanFormats = form.querySelectorAll<HTMLInputElement>('input[name="human_format"]');
      const humanQualities = form.querySelectorAll<HTMLSelectElement>('select[name="human_quality"]');
      for (let i = 0; i < humanFiles.length; i++) {
        const file = humanFiles[i].files?.[0];
        const format = humanFormats[i]?.value;
        if (!file || !format) continue;
        const hfd = new FormData();
        hfd.set("format", format);
        hfd.set("quality", humanQualities[i]?.value || "medium");
        hfd.set("file", file);
        await api.uploadHuman(clip.id, hfd);
      }

      // 人体 · 真人视频
      const humanVideo = (form.elements.namedItem("human_video") as HTMLInputElement)?.files?.[0];
      if (humanVideo) {
        const vfd = new FormData();
        vfd.set("kind", "human");
        vfd.set("quality", "medium");
        vfd.set("file", humanVideo);
        await api.uploadRealVideo(clip.id, vfd);
      }

      // 人机共享 · 文本描述
      const sharedInput = form.elements.namedItem("shared_file") as HTMLInputElement;
      for (const file of Array.from(sharedInput?.files || [])) {
        const sfd = new FormData();
        sfd.set("file", file);
        await api.uploadSharedText(clip.id, sfd);
      }

      const robotFile = (form.elements.namedItem("robot_file") as HTMLInputElement)?.files?.[0];
      const robotModelId = fd.get("robot_model_id");
      const stage = fd.get("stage") as RobotStage;
      if (robotFile && robotModelId) {
        const rfd = new FormData();
        rfd.set("robot_model_id", String(robotModelId));
        rfd.set("stage", stage || "retarget");
        rfd.set("format", String(fd.get("robot_format") || "csv"));
        rfd.set("quality", String(fd.get("robot_quality") || "medium"));
        rfd.set("file", robotFile);
        await api.uploadRobot(clip.id, rfd);
      }

      // 机器人 · 视频（motion播放 / 策略仿真 / 策略真机）
      const robotVideo = (form.elements.namedItem("robot_video") as HTMLInputElement)?.files?.[0];
      if (robotVideo) {
        const vfd = new FormData();
        vfd.set("kind", String(fd.get("robot_video_kind") || "robot_motion"));
        vfd.set("quality", "medium");
        vfd.set("file", robotVideo);
        await api.uploadRealVideo(clip.id, vfd);
      }

      nav(`/clips/${clip.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <form className="card stack" style={{ maxWidth: 720 }} onSubmit={onSubmit}>
        <h1>新建动作条目</h1>
        <p className="muted">可先创建元数据并上传人体/机器人文件；机器人数据可缺省，稍后在详情页补充。</p>
        <label>
          动作大类
          <input name="category" required />
        </label>
        <label>
          动作子类
          <input name="subcategory" />
        </label>
        <label>
          语言概括
          <input name="summary" required />
        </label>
        <label>
          语言详细描述
          <textarea name="description" />
        </label>
        <label>
          标签（逗号分隔）
          <input name="tags" placeholder="走路, 室内" />
        </label>
        <label>
          时长（秒，可选；上传后也可由解析结果回填）
          <input name="duration_sec" type="number" step="0.001" />
        </label>

        <h2>人体 · 视频（可选）</h2>
        <label>
          真人视频
          <input name="human_video" type="file" accept="video/*" />
        </label>

        <h2>人体 · 动作数据（smpl / fbx / bvh / csv…）</h2>
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="row" key={i}>
            <label>
              格式
              <input
              name="human_format"
              placeholder={i === 0 ? "bvh" : "csv/fbx/tak…"}
            />
            </label>
            <label>
              质量
              <select name="human_quality" defaultValue="medium">
                <option value="high">高</option>
                <option value="medium">中</option>
                <option value="low">低</option>
              </select>
            </label>
            <label>
              文件
              <input name="human_file" type="file" />
            </label>
          </div>
        ))}

        <h2>人机共享 · 文本描述（txt / json，可多选）</h2>
        <label>
          文本文件
          <input name="shared_file" type="file" accept=".txt,.json,.md,.yaml,.yml" multiple />
        </label>

        <h2>机器人 · 动力学数据（csv / json，可选）</h2>
        <label>
          型号
          <select name="robot_model_id">
            <option value="">暂不上传</option>
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
          <input name="robot_format" defaultValue="csv" />
        </label>
        <label>
          质量
          <select name="robot_quality" defaultValue="medium">
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
        </label>
        <label>
          文件
          <input name="robot_file" type="file" />
        </label>

        <h2>机器人 · 视频（可选）</h2>
        <label>
          视频类型
          <select name="robot_video_kind" defaultValue="robot_motion">
            <option value="robot_motion">motion播放</option>
            <option value="robot_policy_sim">策略仿真</option>
            <option value="robot_policy_real">策略真机</option>
          </select>
        </label>
        <label>
          机器人视频
          <input name="robot_video" type="file" accept="video/*" />
        </label>

        {error && <div className="error">{error}</div>}
        <button disabled={busy}>{busy ? "提交中…" : "创建并上传"}</button>
      </form>
    </div>
  );
}
