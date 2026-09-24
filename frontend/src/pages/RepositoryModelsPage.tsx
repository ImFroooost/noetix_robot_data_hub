import { useEffect, useMemo, useState } from "react";
import { api, downloadAuth } from "../api";
import { useAuth } from "../auth";
import { FolderDropZone } from "../components/FolderDropZone";
import { ModelFilePreview, modelPreviewKind } from "../components/ModelFilePreview";
import type { ModelInstance, ModelRepositoryOverview } from "../types";
import { INDEX_UPDATED_EVENT } from "../storageOverviewCache";
import { useUndo } from "../undo/UndoContext";
import { zipRelFiles, type RelFile } from "../utils/folderUpload";

function defaultDescriptionFile(instance: ModelInstance | null) {
  if (!instance) return null;
  const rel = String(instance.meta?.default_description_file || "").trim();
  if (!rel) return null;
  return (
    instance.files.find(
      (item) => item.kind === "standard_description" && item.relative_path === rel
    ) || null
  );
}

const KIND_LABEL: Record<string, string> = {
  fbx: "FBX",
  bvh: "BVH",
  smpl: "SMPL",
  blend: "Blender",
  standard_description: "标准机器人描述",
};

export function RepositoryModelsPage() {
  const { hasPerm, isAdmin } = useAuth();
  const { execute } = useUndo();
  const canUpload = hasPerm("upload");
  const canDelete = !!isAdmin;
  const [data, setData] = useState<ModelRepositoryOverview | null>(null);
  const [ontology, setOntology] = useState<"human" | "robot">("human");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [kind, setKind] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<RelFile[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
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

  useEffect(() => {
    const onIndexUpdated = () => {
      load().catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
    };
    window.addEventListener(INDEX_UPDATED_EVENT, onIndexUpdated);
    return () => window.removeEventListener(INDEX_UPDATED_EVENT, onIndexUpdated);
  }, []);

  const instances = useMemo(
    () => (data?.instances || []).filter((item) => item.ontology === ontology),
    [data, ontology]
  );
  const selected =
    data?.instances.find((item) => item.key === selectedKey) || instances[0] || null;
  const kinds = data?.kinds?.[ontology] || [];
  const previewFile =
    selected?.files.find((item) => item.id === previewId) || null;

  useEffect(() => {
    const fallback = defaultDescriptionFile(selected);
    if (fallback) {
      setKind("standard_description");
      setPreviewId(fallback.id);
      return;
    }
    const preferred =
      (selected &&
        kinds.find((item) => selected.files.some((file) => file.kind === item))) ||
      kinds[0] ||
      "";
    setKind(preferred);
    setPreviewId(null);
  }, [selected?.key, ontology, kinds.join("|")]);

  const switchOntology = (next: "human" | "robot") => {
    setOntology(next);
    setSelectedKey(data?.instances.find((item) => item.ontology === next)?.key || null);
    setFile(null);
    setFolderFiles([]);
    setPreviewId(null);
  };

  const createInstance = async () => {
    const name = prompt(`新建${ontology === "human" ? "人体" : "机器人"}实例名称：`);
    if (!name?.trim()) return;
    const instanceName = name.trim();
    try {
      await execute({
        label: `新建模型实例 ${instanceName}`,
        do: async () => {
          const result = await api.storageCreateModelInstance(ontology, instanceName);
          await load();
          setSelectedKey(result.key);
          setMessage(`已创建实例 ${result.name}`);
        },
        undo: async () => {
          await api.storageDeleteModelInstance(ontology, instanceName);
        },
      });
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
      let uploadedPath = "";
      await execute({
        label: `上传模型到 ${selected.name}`,
        do: async () => {
          const result = (await api.storageUploadModel(form)) as {
            validation?: Record<string, number>;
            path?: string;
          };
          uploadedPath = result.path || "";
          await load();
          setFile(null);
          setFolderFiles([]);
          setMessage(
            result.validation
              ? `标准描述结构校验通过：meshes ${result.validation.meshes}，mjcf ${result.validation.mjcf}，urdf ${result.validation.urdf}`
              : "模型文件已上传"
          );
        },
        undo: async () => {
          if (uploadedPath) await api.storageDeleteModelFile(uploadedPath);
        },
      });
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
              onClick={() => {
                setSelectedKey(instance.key);
                const fallback = defaultDescriptionFile(instance);
                if (!fallback) return;
                setKind("standard_description");
                setPreviewId(fallback.id);
              }}
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
                        setPreviewId(
                          item === "standard_description"
                            ? defaultDescriptionFile(selected)?.id || null
                            : null
                        );
                      }}
                    >
                      {KIND_LABEL[item] || item}
                      <small>{count ? `${count} 个文件` : "缺省"}</small>
                    </button>
                  );
                })}
              </div>

              <div className="storage-model-browse">
                <section className="card stack storage-model-files">
                  <h3 style={{ margin: 0 }}>{KIND_LABEL[kind] || kind}</h3>
                  <p className="muted" style={{ margin: 0 }}>
                    点击文件即可在右侧预览网格、URDF、MJCF、FBX 或 BVH
                  </p>
                  {selected.files
                    .filter((item) => item.kind === kind)
                    .map((item) => {
                      const isDesc =
                        item.kind === "standard_description" &&
                        /\.(xml|urdf)$/i.test(item.name);
                      const isDefault =
                        String(selected.meta?.default_description_file || "") ===
                        item.relative_path;
                      return (
                      <div
                        key={item.id}
                        className={`row storage-model-file ${
                          previewId === item.id ? "is-selected" : ""
                        }`}
                        onClick={() => setPreviewId(item.id)}
                      >
                        <span title={item.relative_path}>{item.relative_path}</span>
                        <span className="muted">{(item.size / 1024).toFixed(1)} KB</span>
                        {modelPreviewKind(item) !== "unsupported" && (
                          <span className="muted">可预览</span>
                        )}
                        {isDefault && (
                          <span className="storage-model-default-badge">默认</span>
                        )}
                        {canUpload && isDesc && !isDefault && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={async (event) => {
                              event.stopPropagation();
                              try {
                                await api.storageUpdateModelInstance(
                                  selected.ontology,
                                  selected.name,
                                  { default_description_file: item.relative_path }
                                );
                                await load();
                                setMessage(`已将 ${item.name} 设为默认描述文件`);
                              } catch (e) {
                                setError(e instanceof Error ? e.message : "设置失败");
                              }
                            }}
                          >
                            设为默认
                          </button>
                        )}
                        {canUpload && isDesc && isDefault && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={async (event) => {
                              event.stopPropagation();
                              try {
                                await api.storageUpdateModelInstance(
                                  selected.ontology,
                                  selected.name,
                                  { default_description_file: "" }
                                );
                                await load();
                                setMessage("已取消默认描述文件");
                              } catch (e) {
                                setError(e instanceof Error ? e.message : "取消失败");
                              }
                            }}
                          >
                            取消默认
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary"
                          onClick={(event) => {
                            event.stopPropagation();
                            downloadAuth(api.storageFileUrl(item.path, true), item.name);
                          }}
                        >
                          下载
                        </button>
                        {canDelete && kind !== "standard_description" && (
                          <button
                            type="button"
                            className="danger"
                            onClick={async (event) => {
                              event.stopPropagation();
                              if (!confirm(`确认删除 ${item.relative_path}？`)) return;
                              try {
                                await api.storageDeleteModelFile(item.path);
                                if (previewId === item.id) setPreviewId(null);
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
                      );
                    })}
                  {!selected.files.some((item) => item.kind === kind) && (
                    <div className="muted">该实例尚未上传此类模型数据</div>
                  )}
                </section>
                <section className="card stack storage-model-preview">
                  <h3 style={{ margin: 0 }}>可视化</h3>
                  {previewFile && selected ? (
                    <>
                      <span className="muted">{previewFile.relative_path}</span>
                      <ModelFilePreview file={previewFile} instance={selected} />
                    </>
                  ) : (
                    <div className="storage-preview-empty">
                      请在左侧选择一个模型文件进行可视化
                    </div>
                  )}
                </section>
              </div>

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
