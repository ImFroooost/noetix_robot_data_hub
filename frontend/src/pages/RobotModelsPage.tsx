import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { FolderDropZone } from "../components/FolderDropZone";
import type { RobotModel } from "../types";
import {
  guessFolderName,
  zipRelFiles,
  type RelFile,
} from "../utils/folderUpload";

export function RobotModelsPage() {
  const { canEdit } = useAuth();
  const [models, setModels] = useState<RobotModel[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [folderFiles, setFolderFiles] = useState<RelFile[]>([]);
  const [folderName, setFolderName] = useState("");
  const [folderDesc, setFolderDesc] = useState("");
  const [folderJoints, setFolderJoints] = useState("");

  const reload = () => api.listRobotModels().then(setModels);

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
      setMsg("已从本机目录导入机器人型号");
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
        <h1>机器人型号</h1>
        <p className="muted">
          支持拖拽/选择文件夹、上传 zip，或填写服务器本机路径导入。
        </p>
        {error && <div className="error">{error}</div>}
        {msg && <div className="success">{msg}</div>}
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
            <h2>方式二：本机目录路径导入</h2>
            <p className="muted" style={{ margin: 0 }}>
              资源已在服务器本机磁盘时可用，无需经过浏览器打包。
            </p>
            <label>
              名称
              <input name="name" required placeholder="例如 noetix_e2" />
            </label>
            <label>
              本机目录绝对路径
              <input
                name="path"
                required
                placeholder="/home/noetix/.../robot/noetix_e2"
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
