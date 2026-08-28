import { useEffect, useState, type FormEvent } from "react";
import { api, downloadAuth } from "../api";
import { useAuth } from "../auth";
import { FolderDropZone } from "../components/FolderDropZone";
import type { ModelAsset, RobotModel } from "../types";
import {
  HUMAN_MODEL_FORMATS,
  MODEL_CATEGORY_LABEL,
  ROBOT_MODEL_FORMATS,
} from "../types";
import {
  guessFolderName,
  zipRelFiles,
  type RelFile,
} from "../utils/folderUpload";

function ModelAssetSection({
  category,
  assets,
  isAdmin,
  busy,
  onChanged,
  onError,
}: {
  category: "human" | "robot";
  assets: ModelAsset[];
  isAdmin: boolean;
  busy: boolean;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const formats = category === "human" ? HUMAN_MODEL_FORMATS : ROBOT_MODEL_FORMATS;
  const list = assets.filter((a) => a.category === category);
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>{MODEL_CATEGORY_LABEL[category]}模型</h2>
        <span className="muted">支持格式：{formats.join(" / ")}</span>
      </div>
      {!list.length && <div className="muted">暂无{MODEL_CATEGORY_LABEL[category]}模型文件</div>}
      {!!list.length && (
        <table className="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>格式</th>
              <th>描述</th>
              <th>文件</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>
                  <span className="badge">{a.format.toUpperCase()}</span>
                </td>
                <td>{a.description || "-"}</td>
                <td className="muted" style={{ fontSize: "0.85rem" }}>
                  {a.original_name}
                </td>
                <td>
                  <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <button
                      className="secondary"
                      onClick={() =>
                        downloadAuth(
                          api.modelAssetDownloadUrl(a.id),
                          a.original_name || `${a.name}.${a.format}`
                        )
                      }
                    >
                      下载
                    </button>
                    {isAdmin && (
                      <>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={async () => {
                            const name = prompt("新名称：", a.name);
                            if (!name || !name.trim()) return;
                            try {
                              await api.updateModelAsset(a.id, { name: name.trim() });
                              onChanged();
                            } catch (e) {
                              onError(e instanceof Error ? e.message : "重命名失败");
                            }
                          }}
                        >
                          重命名
                        </button>
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={async () => {
                            if (!confirm(`确认删除模型「${a.name}」？`)) return;
                            try {
                              await api.deleteModelAsset(a.id);
                              onChanged();
                            } catch (e) {
                              onError(e instanceof Error ? e.message : "删除失败");
                            }
                          }}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {isAdmin && (
        <form
          className="row"
          style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}
          onSubmit={async (e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const el = e.currentTarget;
            const fd = new FormData(el);
            fd.set("category", category);
            try {
              await api.uploadModelAsset(fd);
              el.reset();
              onChanged();
            } catch (err) {
              onError(err instanceof Error ? err.message : "上传失败");
            }
          }}
        >
          <input name="name" placeholder="模型名称（可选，默认取文件名）" />
          <input
            name="file"
            type="file"
            required
            accept={formats.map((f) => `.${f}`).join(",") + ",.blender"}
          />
          <button type="submit" disabled={busy}>
            上传{MODEL_CATEGORY_LABEL[category]}模型
          </button>
        </form>
      )}
    </div>
  );
}

export function RobotModelsPage() {
  const { canEdit, isAdmin } = useAuth();
  const [models, setModels] = useState<RobotModel[]>([]);
  const [assets, setAssets] = useState<ModelAsset[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [folderFiles, setFolderFiles] = useState<RelFile[]>([]);
  const [folderName, setFolderName] = useState("");
  const [folderDesc, setFolderDesc] = useState("");
  const [folderJoints, setFolderJoints] = useState("");

  const reload = () =>
    Promise.all([api.listRobotModels().then(setModels), api.listModelAssets().then(setAssets)]);

  useEffect(() => {
    reload().catch((e) => setError(e.message));
  }, []);

  const onFolderPicked = (files: RelFile[]) => {
    setFolderFiles(files);
    setFolderName((prev) => prev || guessFolderName(files));
    setError("");
  };

  const onUploadFolder = async (e: FormEvent) => {
    e.preventDefault();
    if (!folderFiles.length) {
      setError("请先拖入或选择机器人资源文件夹");
      return;
    }
    if (!folderName.trim()) {
      setError("请填写型号名称");
      return;
    }
    setError("");
    setMsg("");
    setBusy(true);
    try {
      setMsg("正在打包文件夹…");
      const blob = await zipRelFiles(folderFiles);
      const fd = new FormData();
      fd.set("name", folderName.trim());
      fd.set("description", folderDesc);
      fd.set("joint_names", folderJoints);
      fd.set("package", new File([blob], `${folderName.trim() || "robot"}.zip`, { type: "application/zip" }));
      setMsg("正在上传…");
      await api.createRobotModel(fd);
      setFolderFiles([]);
      setFolderName("");
      setFolderDesc("");
      setFolderJoints("");
      setMsg("文件夹已上传并导入为机器人型号");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
      setMsg("");
    } finally {
      setBusy(false);
    }
  };

  const onCreateZip = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setError("");
    setMsg("");
    setBusy(true);
    const fd = new FormData(form);
    try {
      await api.createRobotModel(fd);
      form.reset();
      setMsg("机器人型号已通过 zip 添加");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const onCreatePath = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setError("");
    setMsg("");
    setBusy(true);
    const fd = new FormData(form);
    try {
      await api.createRobotModelFromPath(fd);
      form.reset();
      setMsg("已从项目目录导入机器人型号");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page stack">
      <div className="card stack">
        <h1>3D 模型</h1>
        <p className="muted" style={{ margin: 0 }}>
          人体模型（fbx / bvh / smpl / blender）与机器人模型（urdf / xml / fbx / blender）文件库；
          下方为机器人 URDF 可视化型号（用于动作预览）。
        </p>
        {error && <div className="error">{error}</div>}
        {msg && <div className="success">{msg}</div>}
      </div>

      <ModelAssetSection
        category="human"
        assets={assets}
        isAdmin={isAdmin}
        busy={busy}
        onChanged={() => void reload()}
        onError={setError}
      />
      <ModelAssetSection
        category="robot"
        assets={assets}
        isAdmin={isAdmin}
        busy={busy}
        onChanged={() => void reload()}
        onError={setError}
      />

      <div className="card stack">
        <h2>机器人 URDF 可视化型号</h2>
        <p className="muted">
          支持拖拽/选择文件夹、上传 zip，或填写服务器本机路径导入；用于动作数据的 3D 预览。
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>描述</th>
              <th>关节数</th>
              <th>URDF</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td>{m.description}</td>
                <td>{m.joint_names?.length || "-"}</td>
                <td className="muted" style={{ fontSize: "0.85rem" }}>
                  {m.urdf_path}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <>
          <form className="card stack" style={{ maxWidth: 720 }} onSubmit={onUploadFolder}>
            <h2>方式一：拖拽 / 选择文件夹</h2>
            <FolderDropZone
              onFiles={onFolderPicked}
              disabled={busy}
              hint="例如拖入含 urdf/ 与 meshes/ 的机器人资源目录"
            />
            <label>
              名称
              <input
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                required
                placeholder="例如 noetix_e2"
              />
            </label>
            <label>
              描述
              <textarea value={folderDesc} onChange={(e) => setFolderDesc(e.target.value)} />
            </label>
            <label>
              关节名（逗号分隔，可选）
              <input
                value={folderJoints}
                onChange={(e) => setFolderJoints(e.target.value)}
                placeholder="joint1, joint2, ..."
              />
            </label>
            <button type="submit" disabled={busy || !folderFiles.length}>
              {busy ? "处理中…" : "上传文件夹"}
            </button>
          </form>

          <form className="card stack" style={{ maxWidth: 720 }} onSubmit={onCreatePath}>
            <h2>方式二：项目目录路径导入</h2>
            <p className="muted" style={{ margin: 0 }}>
              资源已在项目 data 目录内时可用，无需经过浏览器打包。路径相对
              ./data/files 或 ./data/hub_repo。
            </p>
            <label>
              名称
              <input name="name" required placeholder="例如 noetix_e2" />
            </label>
            <label>
              相对路径
              <input
                name="path"
                required
                placeholder="import/noetix_e2"
              />
            </label>
            <label>
              描述
              <textarea name="description" />
            </label>
            <label>
              关节名（逗号分隔，可选）
              <input name="joint_names" placeholder="joint1, joint2, ..." />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? "导入中…" : "从目录导入"}
            </button>
          </form>

          <form className="card stack" style={{ maxWidth: 720 }} onSubmit={onCreateZip}>
            <h2>方式三：上传 zip</h2>
            <label>
              名称
              <input name="name" required />
            </label>
            <label>
              描述
              <textarea name="description" />
            </label>
            <label>
              关节名（逗号分隔，可选）
              <input name="joint_names" placeholder="joint1, joint2, ..." />
            </label>
            <label>
              URDF 资源包（zip）
              <input name="package" type="file" accept=".zip,application/zip" required />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? "上传中…" : "上传 zip"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
