import { useEffect, useMemo, useState } from "react";
import { api, downloadAuth } from "../api";
import { useAuth } from "../auth";
import { FolderDropZone } from "../components/FolderDropZone";
import type { ModelInstance, ModelRepositoryOverview } from "../types";
import { zipRelFiles, type RelFile } from "../utils/folderUpload";

const KIND_LABEL: Record<string, string> = {
  fbx: "FBX",
  bvh: "BVH",
  smpl: "SMPL",
  blend: "Blender",
  standard_description: "标准机器人描述",
};

export function RepositoryModelsPage() {
  const { isAdmin, hasPerm } = useAuth();
  const canUpload = isAdmin || hasPerm("upload");
  const canDelete = isAdmin || hasPerm("edit");
  const [data, setData] = useState<ModelRepositoryOverview | null>(null);
  const [ontology, setOntology] = useState<"human" | "robot">("human");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [kind, setKind] = useState("fbx");
  const [file, setFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<RelFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = async () => {
    const result = await api.storageModels();
    setData(result);
    setSelectedKey((current) => {
      if (current && result.instances.some((item) => item.key === current)) return current;
      return result.instances.find((item) => item.ontology === ontology)?.key || null;
    });
  };

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);

  const instances = useMemo(
    () => (data?.instances || []).filter((item) => item.ontology === ontology),
    [data, ontology]
  );
  const selected =
    data?.instances.find((item) => item.key === selectedKey) || instances[0] || null;
  const kinds = data?.kinds?.[ontology] || [];

  useEffect(() => {
    if (!kinds.includes(kind)) setKind(kinds[0] || "");
  }, [ontology, data]);

  const switchOntology = (next: "human" | "robot") => {
    setOntology(next);
    setSelectedKey(data?.instances.find((item) => item.ontology === next)?.key || null);
    setFile(null);
    setFolderFiles([]);
  };

  const createInstance = async () => {
    const name = prompt(`新建${ontology === "human" ? "人体" : "机器人"}实例名称：`);
    if (!name?.trim()) return;
    try {
      const result = await api.storageCreateModelInstance(ontology, name.trim());
      await load();
      setSelectedKey(result.key);
      setMessage(`已创建实例 ${result.name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    }
  };

  const upload = async () => {
    if (!selected || !kind) {
      setError("请先选择或创建模型实例");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      let uploadFile = file;
      if (kind === "standard_description" && folderFiles.length) {
        const blob = await zipRelFiles(folderFiles);
        uploadFile = new File([blob], `${selected.name}_standard_description.zip`, {
          type: "application/zip",
        });
      }
      if (!uploadFile) {
        setError(
          kind === "standard_description"
            ? "请选择包含 meshes、mjcf、urdf 的文件夹或 zip"
            : "请选择模型文件"
        );
        return;
      }
      const form = new FormData();
      form.set("ontology", ontology);
      form.set("instance", selected.name);
      form.set("kind", kind);
      form.set("file", uploadFile);
      const result = (await api.storageUploadModel(form)) as {
        validation?: Record<string, number>;
      };
      await load();
      setFile(null);
      setFolderFiles([]);
      setMessage(
        result.validation
          ? `标准描述结构校验通过：meshes ${result.validation.meshes}，mjcf ${result.validation.mjcf}，urdf ${result.validation.urdf}`
          : "模型文件已上传"
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page stack storage-model-page">
      <div className="card row storage-model-tabs">
        <button
          type="button"
          className={ontology === "human" ? "active" : "secondary"}
          onClick={() => switchOntology("human")}
        >
          人体模型
        </button>
        <button
          type="button"
          className={ontology === "robot" ? "active" : "secondary"}
          onClick={() => switchOntology("robot")}
        >
          机器人模型
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <div className="storage-model-workspace">
        <aside className="card storage-model-instances stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>
              {ontology === "human" ? "人体" : "机器人"}实例
            </h3>
            {canUpload && (
              <button type="button" className="storage-circle-add" onClick={() => void createInstance()}>
                +
              </button>
            )}
          </div>
          {instances.map((instance) => (
            <button
              type="button"
              key={instance.key}
              className={selected?.key === instance.key ? "active" : "secondary"}
              onClick={() => setSelectedKey(instance.key)}
            >
              {instance.name}
              <small>{instance.files.length} 个文件</small>
            </button>
          ))}
          {!instances.length && <div className="muted">暂无实例，请点击 + 新建</div>}
        </aside>

        <main className="card stack storage-model-detail">
          {!selected && <div className="storage-preview-empty">请选择或创建一个实例</div>}
          {selected && (
            <>
              <div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <h2 style={{ margin: 0 }}>{selected.name}</h2>
                  {canDelete && (
                    <button
                      type="button"
                      className="danger"
                      onClick={async () => {
                        if (!confirm(`确认删除实例「${selected.name}」及其全部模型文件？`)) return;
                        try {
                          await api.storageDeleteModelInstance(
                            selected.ontology,
                            selected.name
                          );
                          setSelectedKey(null);
                          await load();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "删除失败");
                        }
                      }}
                    >
                      删除实例
                    </button>
                  )}
                </div>
                <span className="muted">
                  已有类型：{selected.kinds.map((item) => KIND_LABEL[item] || item).join("、") || "暂无"}
                </span>
              </div>

              <div className="storage-model-kind-grid">
                {kinds.map((item) => {
                  const count = selected.files.filter((f) => f.kind === item).length;
                  return (
                    <button
                      type="button"
                      key={item}
                      className={kind === item ? "active" : "secondary"}
                      onClick={() => {
                        setKind(item);
                        setFile(null);
                        setFolderFiles([]);
                      }}
                    >
                      {KIND_LABEL[item] || item}
                      <small>{count ? `${count} 个文件` : "缺省"}</small>
                    </button>
                  );
                })}
              </div>

              <section className="card stack">
                <h3 style={{ margin: 0 }}>{KIND_LABEL[kind] || kind}</h3>
                {selected.files
                  .filter((item) => item.kind === kind)
                  .map((item) => (
                    <div key={item.id} className="row storage-model-file">
                      <span>{item.relative_path}</span>
                      <span className="muted">{(item.size / 1024).toFixed(1)} KB</span>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          downloadAuth(api.storageFileUrl(item.path, true), item.name)
                        }
                      >
                        下载
                      </button>
                      {canDelete && kind !== "standard_description" && (
                        <button
                          type="button"
                          className="danger"
                          onClick={async () => {
                            if (!confirm(`确认删除 ${item.relative_path}？`)) return;
                            try {
                              await api.storageDeleteModelFile(item.path);
                              await load();
                            } catch (e) {
                              setError(e instanceof Error ? e.message : "删除失败");
                            }
                          }}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  ))}
                {!selected.files.some((item) => item.kind === kind) && (
                  <div className="muted">该实例尚未上传此类模型数据</div>
                )}
              </section>

              {canUpload && (
                <section className="card stack">
                  <h3 style={{ margin: 0 }}>上传到当前实例</h3>
                  {kind === "standard_description" ? (
                    <>
                      <div className="storage-standard-help">
                        必须严格包含以下三级目录，系统会在写入前检查：
                        <pre>{`${selected.name}/\n├── meshes/   （网格文件）\n├── mjcf/     （至少一个 XML）\n└── urdf/     （至少一个 URDF）`}</pre>
                      </div>
                      <FolderDropZone
                        onFiles={setFolderFiles}
                        disabled={busy}
                        hint="拖入或选择 standard_description 文件夹"
                      />
                      <label>
                        或上传 zip
                        <input
                          type="file"
                          accept=".zip,application/zip"
                          onChange={(e) => setFile(e.target.files?.[0] || null)}
                        />
                      </label>
                    </>
                  ) : (
                    <label>
                      模型文件
                      <input
                        type="file"
                        onChange={(e) => setFile(e.target.files?.[0] || null)}
                      />
                    </label>
                  )}
                  <button type="button" disabled={busy} onClick={() => void upload()}>
                    {busy ? "检查并上传中…" : "检查结构并上传"}
                  </button>
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
