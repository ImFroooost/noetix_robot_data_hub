import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { RobotStyleFields } from "./RobotStyleFields";
import type {
  ModelInstance,
  StorageFolderUploadResult,
  StorageOverview,
} from "../types";
import {
  filesFromDataTransfer,
  filesFromFileList,
  guessFolderName,
  type RelFile,
} from "../utils/folderUpload";

const MODALITIES = [
  ["tpv_video", "第三视角视频"],
  ["fpv_video", "第一视角视频"],
  ["motion", "运动数据"],
  ["text", "文本"],
  ["audio", "音频"],
  ["log", "日志"],
] as const;

type FolderAction = "upload" | "replace" | "skip";
type BatchChoice = "new" | "existing" | "";

type FolderImportDraft = {
  files: RelFile[];
  folderName: string;
  batchChoice: BatchChoice;
  batchName: string;
  ontology: string;
  modality: string;
  channel: string;
  format: string;
  robotStyle: string;
  robotVersion: string;
  personName: string;
  gender: string;
  height: string;
  actions: Record<string, FolderAction>;
};

const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function fileUnitName(file: RelFile) {
  return file.file.name.replace(/\.[^.]+$/, "") || file.file.name;
}

function stemsSameUnit(left: string, right: string) {
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (!long.startsWith(short)) return false;
  const extra = long.slice(short.length);
  if (!extra || !/^[-_]/.test(extra) || extra.length > 32) return false;
  const segs = extra.split(/[-_]+/).filter(Boolean);
  return segs.length >= 1 && segs.length <= 3;
}

function matchExistingUnit<T extends { name: string }>(
  unitName: string,
  units: T[]
) {
  return (
    units.find((unit) => unit.name === unitName) ||
    units.find((unit) => stemsSameUnit(unit.name, unitName))
  );
}

function fileExtension(file: RelFile) {
  const match = file.file.name.match(/\.([^.]+)$/);
  return match?.[1]?.toLowerCase() || "";
}

function usableFolderFiles(files: RelFile[]) {
  return files.filter(({ path, file }) => {
    if (!file.size || IGNORED_FILE_NAMES.has(file.name)) return false;
    return !path.split("/").some((part) => part.startsWith("."));
  });
}

export function FolderBatchImport({
  onImported,
  onError,
  onMessage,
}: {
  onImported: (batchName: string, sessionId?: string) => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [folderDraft, setFolderDraft] = useState<FolderImportDraft | null>(null);
  const [folderResult, setFolderResult] = useState<StorageFolderUploadResult | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState("");
  const [draggingFolder, setDraggingFolder] = useState(false);
  const [robotInstances, setRobotInstances] = useState<ModelInstance[]>([]);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const needRobotStyles = !!folderDraft && folderDraft.ontology === "robot";

  useEffect(() => {
    if (!needRobotStyles) return;
    let cancelled = false;
    api
      .storageModels()
      .then((data) => {
        if (cancelled) return;
        setRobotInstances(data.instances.filter((item) => item.ontology === "robot"));
      })
      .catch((e) => {
        if (!cancelled) setFolderError(e instanceof Error ? e.message : "机器人款式加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [needRobotStyles]);

  const nextAvailableBatchName = (base: string, batches: StorageOverview["batches"]) => {
    const names = new Set(batches.map((item) => item.name));
    if (!names.has(base)) return base;
    let index = 2;
    while (names.has(`${base}_${index}`)) index += 1;
    return `${base}_${index}`;
  };

  const openFolderImport = async (rawFiles: RelFile[]) => {
    const roots = new Set(
      rawFiles
        .map((item) => item.path.split("/").filter(Boolean)[0])
        .filter(Boolean)
    );
    if (roots.size > 1) {
      onError("一次只能导入一个文件夹，请重新拖入");
      return;
    }
    const files = usableFolderFiles(rawFiles);
    if (!files.length) {
      onError("文件夹为空，或仅包含隐藏文件和空文件");
      return;
    }
    const storage = await api.storageOverview();
    setOverview(storage);
    const folderName = guessFolderName(rawFiles);
    const batchExists = storage.batches.some((item) => item.name === folderName);
    const extensions = Array.from(
      new Set(files.map(fileExtension).filter(Boolean))
    );
    setFolderResult(null);
    setFolderError("");
    setFolderDraft({
      files,
      folderName,
      batchChoice: batchExists ? "" : "new",
      batchName: batchExists ? nextAvailableBatchName(folderName, storage.batches) : folderName,
      ontology: "human",
      modality: "motion",
      channel: "rgb",
      format: extensions.length === 1 ? extensions[0] : "csv",
      robotStyle: "",
      robotVersion: "",
      personName: "",
      gender: "",
      height: "",
      actions: {},
    });
  };

  const createBatch = async () => {
    const name = prompt("新数据批次名称：");
    if (!name?.trim()) return;
    try {
      await api.storageCreateBatch(name.trim());
      onMessage(`已创建批次 ${name.trim()}`);
      onImported(name.trim());
    } catch (e) {
      onError(e instanceof Error ? e.message : "创建失败");
    }
  };

  const handleFolderDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingFolder(false);
    try {
      await openFolderImport(await filesFromDataTransfer(event.dataTransfer));
    } catch (e) {
      onError(e instanceof Error ? e.message : "无法读取拖入的文件夹");
    }
  };

  const folderRows = useMemo(() => {
    if (!folderDraft) return [];
    const targetBatch =
      folderDraft.batchChoice === "existing"
        ? folderDraft.folderName
        : folderDraft.batchName.trim();
    const existingUnits =
      overview?.batches.find((item) => item.name === targetBatch)?.units || [];
    const seenUnits = new Set<string>();
    return folderDraft.files.map((relFile) => {
      const unitName = fileUnitName(relFile);
      const matchedName =
        [...seenUnits].find((name) => stemsSameUnit(name, unitName)) || unitName;
      const duplicate = seenUnits.has(matchedName);
      seenUnits.add(matchedName);
      const existingConflict = matchExistingUnit(unitName, existingUnits)
        ?.files.some(
          (item) =>
            item.ontology === folderDraft.ontology &&
            item.modality === folderDraft.modality &&
            item.channel ===
              (folderDraft.modality === "fpv_video" ? folderDraft.channel : "") &&
            item.format === folderDraft.format &&
            item.name === relFile.file.name
        );
      const defaultAction: FolderAction = duplicate || existingConflict ? "skip" : "upload";
      return {
        relFile,
        unitName,
        duplicate,
        existingConflict: !!existingConflict,
        action: folderDraft.actions[relFile.path] || defaultAction,
      };
    });
  }, [folderDraft, overview]);

  const folderExtensions = useMemo(
    () =>
      folderDraft
        ? Array.from(new Set(folderDraft.files.map(fileExtension).filter(Boolean)))
        : [],
    [folderDraft]
  );

  const updateFolderDraft = (patch: Partial<FolderImportDraft>) => {
    setFolderDraft((current) => (current ? { ...current, ...patch } : null));
    setFolderResult(null);
    setFolderError("");
  };

  const submitFolderImport = async () => {
    if (!folderDraft) return;
    const targetBatch =
      folderDraft.batchChoice === "existing"
        ? folderDraft.folderName
        : folderDraft.batchName.trim();
    if (!folderDraft.batchChoice) {
      setFolderError("请选择修改名称创建新批次，或添加至现有批次");
      return;
    }
    if (!targetBatch || !folderDraft.format.trim()) {
      setFolderError("批次名称和格式不能为空");
      return;
    }

    setFolderBusy(true);
    setFolderError("");
    setFolderResult(null);
    try {
      const form = new FormData();
      form.set("ontology", folderDraft.ontology);
      form.set("modality", folderDraft.modality);
      form.set(
        "channel",
        folderDraft.modality === "fpv_video" ? folderDraft.channel : ""
      );
      form.set("format", folderDraft.format.trim());
      form.set("batch", targetBatch);
      form.set("actions", JSON.stringify(folderRows.map((row) => row.action)));
      form.set(
        "annotation",
        JSON.stringify(
          folderDraft.ontology === "robot"
            ? {
                robot_style: folderDraft.robotStyle,
                robot_version: folderDraft.robotVersion,
              }
            : {
                person_name: folderDraft.personName.trim(),
                gender: folderDraft.gender,
                height: folderDraft.height.trim(),
              }
        )
      );
      folderRows.forEach((row) =>
        form.append("files", row.relFile.file, row.relFile.file.name)
      );
      const result = await api.storageUploadFolder(form);
      setFolderResult(result);
      onImported(targetBatch, result.upload_session_id || undefined);
      if (!result.failed) {
        onMessage(
          `文件夹导入完成：上传 ${result.uploaded}，替换 ${result.replaced}，跳过 ${result.skipped}`
        );
      }
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : "文件夹导入失败");
    } finally {
      setFolderBusy(false);
    }
  };

  return (
    <>
      <div
        className={`storage-batch-drop ${draggingFolder ? "dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDraggingFolder(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDraggingFolder(false);
          }
        }}
        onDrop={(event) => void handleFolderDrop(event)}
      >
        <button
          type="button"
          className="storage-batch-create"
          onClick={() => void createBatch()}
        >
          <strong>＋ 新建批次</strong>
          <span>点击创建空批次</span>
        </button>
        <div className="storage-batch-drop-hint">或将文件夹拖到这里批量导入</div>
        <button
          type="button"
          className="storage-batch-folder-pick secondary"
          onClick={() => folderInputRef.current?.click()}
        >
          选择文件夹
        </button>
        <input
          ref={folderInputRef}
          type="file"
          multiple
          hidden
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(event) => {
            void openFolderImport(filesFromFileList(event.target.files));
            event.target.value = "";
          }}
        />
      </div>

      {folderDraft &&
        createPortal(
        <div
          className="storage-modal-backdrop"
          onClick={() => {
            if (!folderBusy) setFolderDraft(null);
          }}
        >
          <div
            className={`storage-modal storage-folder-import-modal card stack ${
              folderResult ? "completed" : ""
            }`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="storage-folder-import-title">
              <div>
                <h3>导入文件夹批次</h3>
                <span className="muted">
                  {folderDraft.folderName} · {folderDraft.files.length} 个文件
                </span>
              </div>
              <button
                type="button"
                className="secondary"
                disabled={folderBusy}
                onClick={() => setFolderDraft(null)}
              >
                关闭
              </button>
            </div>

            {(overview?.batches || []).some(
              (item) => item.name === folderDraft.folderName
            ) && (
              <section className="storage-folder-conflict-choice">
                <strong>批次“{folderDraft.folderName}”已存在</strong>
                <label className="row">
                  <input
                    type="radio"
                    name="folder-batch-choice"
                    checked={folderDraft.batchChoice === "new"}
                    onChange={() =>
                      updateFolderDraft({
                        batchChoice: "new",
                        batchName: nextAvailableBatchName(
                          folderDraft.folderName,
                          overview?.batches || []
                        ),
                        actions: {},
                      })
                    }
                  />
                  修改名称，创建新批次
                </label>
                <label className="row">
                  <input
                    type="radio"
                    name="folder-batch-choice"
                    checked={folderDraft.batchChoice === "existing"}
                    onChange={() =>
                      updateFolderDraft({
                        batchChoice: "existing",
                        actions: {},
                      })
                    }
                  />
                  添加至现有批次
                </label>
              </section>
            )}

            {folderDraft.batchChoice === "new" && (
              <label>
                新批次名称
                <input
                  value={folderDraft.batchName}
                  onChange={(event) =>
                    updateFolderDraft({
                      batchName: event.target.value,
                      actions: {},
                    })
                  }
                />
                {(overview?.batches || []).some(
                  (item) => item.name === folderDraft.batchName.trim()
                ) && (
                  <span className="muted">
                    名称「{folderDraft.batchName.trim()}」已存在，将添加到该批次
                  </span>
                )}
              </label>
            )}

            <div className="storage-folder-fields">
              <label>
                本体
                <select
                  value={folderDraft.ontology}
                  onChange={(event) =>
                    updateFolderDraft({
                      ontology: event.target.value,
                      actions: {},
                    })
                  }
                >
                  <option value="human">人体</option>
                  <option value="robot">机器人</option>
                </select>
              </label>
              <label>
                模态
                <select
                  value={folderDraft.modality}
                  onChange={(event) =>
                    updateFolderDraft({
                      modality: event.target.value,
                      actions: {},
                    })
                  }
                >
                  {MODALITIES.map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {folderDraft.modality === "fpv_video" && (
                <label>
                  第一视角类型
                  <select
                    value={folderDraft.channel}
                    onChange={(event) =>
                      updateFolderDraft({
                        channel: event.target.value,
                        actions: {},
                      })
                    }
                  >
                    <option value="rgb">RGB</option>
                    <option value="depth">Depth</option>
                  </select>
                </label>
              )}
              <label>
                格式
                <input
                  value={folderDraft.format}
                  onChange={(event) =>
                    updateFolderDraft({
                      format: event.target.value,
                      actions: {},
                    })
                  }
                  placeholder="csv / mp4 / json…"
                />
              </label>
              {folderDraft.ontology === "robot" && (
                <RobotStyleFields
                  instances={robotInstances}
                  style={folderDraft.robotStyle}
                  version={folderDraft.robotVersion}
                  onChange={(robotStyle, robotVersion) =>
                    updateFolderDraft({ robotStyle, robotVersion })
                  }
                />
              )}
              {folderDraft.ontology === "human" && (
                <>
                  <label>
                    姓名
                    <input
                      value={folderDraft.personName}
                      placeholder="采集对象姓名"
                      onChange={(event) =>
                        updateFolderDraft({ personName: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    性别
                    <select
                      value={folderDraft.gender}
                      onChange={(event) =>
                        updateFolderDraft({ gender: event.target.value })
                      }
                    >
                      <option value="">未填写</option>
                      <option value="男">男</option>
                      <option value="女">女</option>
                    </select>
                  </label>
                  <label>
                    身高（cm）
                    <input
                      type="number"
                      min="50"
                      max="250"
                      step="0.1"
                      value={folderDraft.height}
                      placeholder="厘米"
                      onChange={(event) =>
                        updateFolderDraft({ height: event.target.value })
                      }
                    />
                  </label>
                </>
              )}
            </div>
            {folderExtensions.length > 1 && (
              <div className="storage-folder-format-warning">
                检测到多种扩展名：{folderExtensions.join("、")}。这些文件将统一按“
                {folderDraft.format || "未填写"}”格式归档。
              </div>
            )}

            <div className="storage-folder-summary">
              将导入 {folderRows.filter((row) => row.action !== "skip").length} 个，
              跳过 {folderRows.filter((row) => row.action === "skip").length} 个
            </div>
            <div className="storage-folder-file-list">
              {folderRows.map((row) => (
                <div className="storage-folder-file-row" key={row.relFile.path}>
                  <div>
                    <strong>{row.unitName}</strong>
                    <small title={row.relFile.path}>{row.relFile.path}</small>
                  </div>
                  {row.duplicate ? (
                    <span className="storage-folder-status warning">
                      数据单元名重复，跳过
                    </span>
                  ) : row.existingConflict ? (
                    <select
                      value={row.action}
                      disabled={folderBusy}
                      onChange={(event) =>
                        updateFolderDraft({
                          actions: {
                            ...folderDraft.actions,
                            [row.relFile.path]: event.target.value as FolderAction,
                          },
                        })
                      }
                    >
                      <option value="skip">已有文件：跳过</option>
                      <option value="replace">已有文件：替换</option>
                    </select>
                  ) : (
                    <span className="storage-folder-status">新文件</span>
                  )}
                </div>
              ))}
            </div>

            {folderBusy && (
              <div className="stack">
                <span>正在上传 {folderDraft.files.length} 个文件，请勿关闭…</span>
                <progress className="storage-folder-progress" />
              </div>
            )}
            {folderError && <div className="error">{folderError}</div>}
            {folderResult && (
              <div
                className={`storage-folder-result ${
                  folderResult.failed ? "error" : "success"
                }`}
              >
                上传 {folderResult.uploaded}，替换 {folderResult.replaced}，跳过{" "}
                {folderResult.skipped}，失败 {folderResult.failed}
                {!!folderResult.failed && (
                  <ul>
                    {folderResult.items
                      .filter((item) => item.status === "failed")
                      .map((item) => (
                        <li key={`${item.name}-${item.detail}`}>
                          {item.name}：{item.detail}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}
            <div className="row storage-folder-actions">
              <button
                type="button"
                className="secondary"
                disabled={folderBusy}
                onClick={() => setFolderDraft(null)}
              >
                {folderResult ? "完成" : "取消"}
              </button>
              {!folderResult && (
                <button
                  type="button"
                  disabled={
                    folderBusy ||
                    !folderDraft.batchChoice ||
                    !folderRows.some((row) => row.action !== "skip")
                  }
                  onClick={() => void submitFolderImport()}
                >
                  {folderBusy
                    ? "正在导入…"
                    : folderDraft.batchChoice === "new" &&
                        (overview?.batches || []).some(
                          (item) => item.name === folderDraft.batchName.trim()
                        )
                      ? "添加到现有批次"
                      : "开始导入"}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
