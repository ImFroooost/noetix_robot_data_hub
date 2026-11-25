import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { fetchStorageOverview, invalidateStorageOverview } from "../storageOverviewCache";
import { useUndo } from "../undo/UndoContext";
import { undoUploadSession } from "../undo/storageMeta";
import { DEFAULT_HUMAN_MODEL, HumanModelFields, resolveHumanModelName } from "./HumanModelFields";
import { MotionKindFields } from "./MotionKindFields";
import { RobotStyleFields } from "./RobotStyleFields";
import { TaxonomyTagPicker } from "./TaxonomyTagPicker";
import type {
  ModelInstance,
  StorageFolderUploadResult,
  StorageOverview,
  TaxonomyNode,
  TaxonomySchemeDef,
  ZipImportJob,
} from "../types";
import {
  compactTaxonomyTagIds,
  DEFAULT_MOTION_KIND,
  isMotionModality,
  isSmplFormat,
  needsManualCsvFps,
  parseCsvFps,
  resolveMotionKind,
  type MotionKind,
} from "../types";
import {
  detectFolderMergeableC3dPairs,
  filesFromDataTransfer,
  filesFromFileList,
  folderNameFromZip,
  formatFromFileName,
  guessFolderName,
  inspectZipForImport,
  type RelFile,
} from "../utils/folderUpload";
import { planClipUnits, planFollowedPaths } from "../utils/motionUnits";

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

function resolveImportTarget(
  choice: BatchChoice,
  folderName: string,
  batchName: string,
  repairBatch: string
) {
  const repair = repairBatch.trim();
  if (repair) return { batch: repair, existing: true };
  if (choice === "existing") return { batch: folderName, existing: true };
  return { batch: batchName.trim(), existing: false };
}

function isGatewayTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /gateway time-?out|504|timed out/i.test(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollZipJob(
  jobId: string,
  onProgress: (job: ZipImportJob) => void
): Promise<StorageFolderUploadResult> {
  let misses = 0;
  for (;;) {
    try {
      const job = await api.storageUploadZipJob(jobId);
      misses = 0;
      onProgress(job);
      if (job.status === "done") {
        if (!job.result) throw new Error("导入已完成，但没有返回结果");
        return job.result;
      }
      if (job.status === "failed") throw new Error(job.detail || "Zip 导入失败");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /无法连接|接口不存在|Failed to fetch/.test(message);
      if (!retryable) throw error;
      misses += 1;
      if (misses >= 5) {
        throw new Error("导入任务已中断。请到批次里确认文件，不要直接重新导入。");
      }
    }
    await sleep(1500);
  }
}

function validateFileVersion(
  target: { batch: string; existing: boolean },
  repairBatch: string,
  fileVersion: string,
  batches: { name: string }[]
) {
  const version = target.existing ? fileVersion.trim() : "";
  if (repairBatch.trim() && !version) return "请填写文件版本名";
  if (version && !batches.some((item) => item.name === target.batch)) {
    return "找不到要修复的批次";
  }
  return "";
}

type C3dMergePromptState = {
  sourceLabel: string;
  pairCount: number;
  sampleNames: string[];
  resolve: (choice: boolean | null) => void;
};

type ZipImportDraft = {
  file: File | null;
  localPath: string;
  folderName: string;
  batchChoice: BatchChoice;
  batchName: string;
  ontology: string;
  modality: string;
  channel: string;
  robotStyle: string;
  robotVersion: string;
  humanModel: string;
  humanModelFile: string;
  personName: string;
  gender: string;
  height: string;
  fps: string;
  motionKind: MotionKind;
  replace: boolean;
  followPaths: boolean;
  repairBatch: string;
  fileVersion: string;
  mergeC3d: boolean;
  mergeablePairCount: number;
  samplePairs: string[];
};

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
  humanModel: string;
  humanModelFile: string;
  personName: string;
  gender: string;
  height: string;
  fps: string;
  motionKind: MotionKind;
  actions: Record<string, FolderAction>;
  replace: boolean;
  followPaths: boolean;
  repairBatch: string;
  fileVersion: string;
  mergeC3d: boolean;
  mergeablePairs: Array<{ fbxRel: string; c3dRel: string }>;
};

const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function normalizeUnitStem(name: string) {
  const cleaned = name
    .replace(
      /(?:[\s._-]+|\.[A-Za-z0-9]{1,8}[\s._-]*)(?:skeleton|rigid[\s._-]*bod(?:y|ies)|marker|merged).*$/i,
      ""
    )
    .replace(/[ .\t_]+$/, "");
  return cleaned || name;
}

function fileUnitName(file: RelFile) {
  const stem = file.file.name.replace(/\.[^.]+$/, "") || file.file.name;
  const dir = file.path.split("/").slice(0, -1).join("/");
  if (dir) {
    return normalizeUnitStem((dir + "/" + stem).replace(/\//g, "_")) || (dir + "_" + stem).replace(/\//g, "_");
  }
  return normalizeUnitStem(stem);
}

function stemsSameUnit(left: string, right: string) {
  const a = normalizeUnitStem(left);
  const b = normalizeUnitStem(right);
  return Boolean(a) && a === b;
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
  return formatFromFileName(file.file.name);
}

export function UploadTaxonomyFields({
  schemes,
  nodes,
  value,
  onChange,
  canCreate,
  onNodesReload,
  disabled,
}: {
  schemes: TaxonomySchemeDef[];
  nodes: TaxonomyNode[];
  value: Record<string, number | number[] | "">;
  onChange: (next: Record<string, number[]>) => void;
  canCreate?: boolean;
  onNodesReload?: () => Promise<void> | void;
  disabled?: boolean;
}) {
  return (
    <TaxonomyTagPicker
      schemes={schemes}
      nodes={nodes}
      value={value}
      disabled={disabled}
      canCreate={canCreate}
      onNodesReload={onNodesReload}
      onChange={(scheme, ids) =>
        onChange({ ...compactTaxonomyTagIds(value), [scheme]: ids })
      }
    />
  );
}

function usableFolderFiles(files: RelFile[]) {
  return files.filter(({ path, file }) => {
    if (!file.size || IGNORED_FILE_NAMES.has(file.name)) return false;
    return !path.split("/").some((part) => part.startsWith("."));
  });
}

function FileVersionFields({
  batches,
  repairBatch,
  fileVersion,
  batchChoice,
  disabled,
  onRepairBatch,
  onFileVersion,
}: {
  batches: { name: string }[];
  repairBatch: string;
  fileVersion: string;
  batchChoice: BatchChoice;
  disabled: boolean;
  onRepairBatch: (value: string) => void;
  onFileVersion: (value: string) => void;
}) {
  const enabled = Boolean(repairBatch.trim()) || batchChoice === "existing";
  return (
    <div className="storage-folder-format-warning">
      <strong>文件版本</strong>
      <label>
        修复到已有批次
        <select
          value={repairBatch}
          disabled={disabled}
          onChange={(event) => onRepairBatch(event.target.value)}
        >
          <option value="">不指定（沿用上面的批次选择）</option>
          {batches.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        文件版本名
        <input
          value={fileVersion}
          disabled={disabled || !enabled}
          placeholder={
            enabled ? "例如 第一次修复版；留空表示原版" : "先选择已有批次后再填写"
          }
          onChange={(event) => onFileVersion(event.target.value)}
        />
      </label>
      <small>
        填写版本名后，这些文件会作为该批次的这个版本保存，原版仍留在原地。查看数据单元时默认显示最新版本；这个版本里没有的文件会沿用更早的版本。
      </small>
    </div>
  );
}

export function FolderBatchImport({
  schemes,
  nodes,
  canCreateTaxonomy,
  onNodesReload,
  taxonomyTagIds,
  onTaxonomyTagIdsChange,
  showInlinePreset = false,
  layout = "pane",
  onImported,
  onError,
  onMessage,
}: {
  schemes: TaxonomySchemeDef[];
  nodes: TaxonomyNode[];
  canCreateTaxonomy?: boolean;
  onNodesReload?: () => Promise<void> | void;
  taxonomyTagIds: Record<string, number | number[] | "">;
  onTaxonomyTagIdsChange: (next: Record<string, number[]>) => void;
  showInlinePreset?: boolean;
  layout?: "pane" | "dock";
  onImported: (batchName: string, sessionId?: string) => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const { execute } = useUndo();
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [folderDraft, setFolderDraft] = useState<FolderImportDraft | null>(null);
  const [zipDraft, setZipDraft] = useState<ZipImportDraft | null>(null);
  const [folderResult, setFolderResult] = useState<StorageFolderUploadResult | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState<ZipImportJob | null>(null);
  const [folderError, setFolderError] = useState("");
  const [fileFilter, setFileFilter] = useState<"all" | "new" | "skipped">("all");
  const [localZipPath, setLocalZipPath] = useState("");
  const [draggingFolder, setDraggingFolder] = useState(false);
  const [robotInstances, setRobotInstances] = useState<ModelInstance[]>([]);
  const [humanInstances, setHumanInstances] = useState<ModelInstance[]>([]);
  const [c3dMergePrompt, setC3dMergePrompt] = useState<C3dMergePromptState | null>(null);
  const [inspectingText, setInspectingText] = useState("");
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const taxonomyPayload = compactTaxonomyTagIds(taxonomyTagIds);

  const askMergeC3dChoice = (params: {
    sourceLabel: string;
    pairCount: number;
    sampleNames: string[];
  }): Promise<boolean | null> =>
    new Promise((resolve) => {
      setC3dMergePrompt({ ...params, resolve });
    });

  const answerMergeC3dChoice = (choice: boolean | null) => {
    setC3dMergePrompt((current) => {
      if (current) current.resolve(choice);
      return null;
    });
  };

  const needRobotStyles =
    (!!folderDraft && folderDraft.ontology === "robot") ||
    (!!zipDraft && zipDraft.ontology === "robot");
  const needHumanModels =
    (!!folderDraft &&
      folderDraft.ontology === "human" &&
      (isSmplFormat(folderDraft.format) ||
        folderDraft.files.some((item) => isSmplFormat("", item.file.name)))) ||
    (!!zipDraft && zipDraft.ontology === "human" && zipDraft.modality === "motion");

  useEffect(() => {
    if (!needRobotStyles && !needHumanModels) return;
    let cancelled = false;
    api
      .storageModels({ quiet: true })
      .then((data) => {
        if (cancelled) return;
        if (needRobotStyles) {
          setRobotInstances(data.instances.filter((item) => item.ontology === "robot"));
        }
        if (needHumanModels) {
          setHumanInstances(data.instances.filter((item) => item.ontology === "human"));
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setFolderError(
            e instanceof Error
              ? e.message
              : needRobotStyles
                ? "机器人款式加载失败"
                : "人体模型加载失败"
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [needRobotStyles, needHumanModels]);

  const nextAvailableBatchName = (base: string, batches: StorageOverview["batches"]) => {
    const names = new Set(batches.map((item) => item.name));
    if (!names.has(base)) return base;
    let index = 2;
    while (names.has(`${base}_${index}`)) index += 1;
    return `${base}_${index}`;
  };

  const openZipImport = async (file: File | null, localPath = "") => {
    const cleanLocal = localPath.trim();
    const folderName = folderNameFromZip(file?.name || cleanLocal);
    if (!folderName) {
      onError("请选择 zip 或填写服务器路径");
      return;
    }
    setInspectingText("正在检查文件中的 FBX 与 C3D 数据…");
    let mergeablePairCount = 0;
    let samplePairs: string[] = [];
    try {
      if (file) {
        try {
          const inspected = await inspectZipForImport(file);
          mergeablePairCount = inspected.mergeablePairs.length;
          samplePairs = inspected.mergeablePairs
            .slice(0, 5)
            .map((p) => (p.fbxRel.split("/").pop() || p.fbxRel).replace(/\.fbx$/i, ""));
        } catch {
          // If browser zip inspection cannot read central dir, proceed without blocking
        }
      } else if (cleanLocal) {
        const inspected = await api.storageInspectImportPath(cleanLocal);
        mergeablePairCount = inspected.mergeable_c3d_fbx_count || 0;
        samplePairs = inspected.sample_pairs || [];
      }
    } catch (e) {
      setInspectingText("");
      onError(e instanceof Error ? e.message : "无法读取指定路径");
      return;
    }
    const storage = await fetchStorageOverview({}, true);
    setInspectingText("");
    setOverview(storage);

    let mergeC3d = false;
    if (mergeablePairCount > 0) {
      const choice = await askMergeC3dChoice({
        sourceLabel: file?.name || cleanLocal,
        pairCount: mergeablePairCount,
        sampleNames: samplePairs,
      });
      if (choice === null) return;
      mergeC3d = choice;
    }

    const batchExists = storage.batches.some((item) => item.name === folderName);
    setFolderResult(null);
    setFolderError("");
    setZipDraft({
      file,
      localPath: cleanLocal,
      folderName,
      batchChoice: batchExists ? "existing" : "new",
      batchName: batchExists ? nextAvailableBatchName(folderName, storage.batches) : folderName,
      ontology: "human",
      modality: "motion",
      channel: "rgb",
      robotStyle: "",
      robotVersion: "",
      humanModel: DEFAULT_HUMAN_MODEL,
      humanModelFile: "",
      personName: "",
      gender: "",
      height: "",
      fps: "30",
      motionKind: DEFAULT_MOTION_KIND,
      replace: false,
      followPaths: false,
      repairBatch: "",
      fileVersion: "",
      mergeC3d,
      mergeablePairCount,
      samplePairs,
    });
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
    const folderName = guessFolderName(rawFiles);
    setInspectingText("正在检查文件夹中的 FBX 与 C3D 数据…");
    let mergeablePairs: Array<{ fbxRel: string; c3dRel: string }> = [];
    let storage: StorageOverview;
    try {
      const [detectedPairs, fetchedStorage] = await Promise.all([
        detectFolderMergeableC3dPairs(
          files.map((item) => ({ rel: item.path, file: item.file }))
        ),
        fetchStorageOverview({}, true),
      ]);
      mergeablePairs = detectedPairs;
      storage = fetchedStorage;
    } finally {
      setInspectingText("");
    }
    setOverview(storage);

    let mergeC3d = false;
    if (mergeablePairs.length > 0) {
      const sampleNames = mergeablePairs
        .slice(0, 5)
        .map((p) => (p.fbxRel.split("/").pop() || p.fbxRel).replace(/\.fbx$/i, ""));
      const choice = await askMergeC3dChoice({
        sourceLabel: folderName,
        pairCount: mergeablePairs.length,
        sampleNames,
      });
      if (choice === null) return;
      mergeC3d = choice;
    }

    const batchExists = storage.batches.some((item) => item.name === folderName);
    setFolderResult(null);
    setFolderError("");
    setFolderDraft({
      files,
      folderName,
      batchChoice: batchExists ? "existing" : "new",
      batchName: batchExists ? nextAvailableBatchName(folderName, storage.batches) : folderName,
      ontology: "human",
      modality: "motion",
      channel: "rgb",
      format: "",
      robotStyle: "",
      robotVersion: "",
      humanModel: DEFAULT_HUMAN_MODEL,
      humanModelFile: "",
      personName: "",
      gender: "",
      height: "",
      fps: "30",
      motionKind: DEFAULT_MOTION_KIND,
      actions: {},
      replace: false,
      followPaths: false,
      repairBatch: "",
      fileVersion: "",
      mergeC3d,
      mergeablePairs,
    });
  };

  const createBatch = async () => {
    const name = prompt("新数据批次名称：");
    if (!name?.trim()) return;
    const batchName = name.trim();
    try {
      await execute({
        label: `新建批次 ${batchName}`,
        do: async () => {
          await api.storageCreateBatch(batchName, {
            taxonomy_tag_ids: taxonomyPayload,
          });
          onMessage(`已创建批次 ${batchName}`);
          invalidateStorageOverview();
          onImported(batchName);
        },
        undo: async () => {
          await api.storageDeleteBatch(batchName);
        },
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "创建失败");
    }
  };

  const handleFolderDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingFolder(false);
    try {
      const dropped = Array.from(event.dataTransfer.files || []);
      const zips = dropped.filter((item) => /\.zip$/i.test(item.name));
      if (zips.length === 1 && dropped.length === 1) {
        await openZipImport(zips[0]);
        return;
      }
      await openFolderImport(await filesFromDataTransfer(event.dataTransfer));
    } catch (e) {
      onError(e instanceof Error ? e.message : "无法读取拖入的文件夹或 zip");
    }
  };

  const updateZipDraft = (patch: Partial<ZipImportDraft>) => {
    setZipDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const submitZipImport = async () => {
    if (!zipDraft) return;
    const target = resolveImportTarget(
      zipDraft.batchChoice,
      zipDraft.folderName,
      zipDraft.batchName,
      zipDraft.repairBatch
    );
    const targetBatch = target.batch;
    const fileVersion = target.existing ? zipDraft.fileVersion.trim() : "";
    if (!zipDraft.batchChoice && !zipDraft.repairBatch.trim()) {
      setFolderError("请选择修改名称创建新批次，或添加至现有批次");
      return;
    }
    if (!targetBatch) {
      setFolderError("批次名称不能为空");
      return;
    }
    const versionError = validateFileVersion(
      target,
      zipDraft.repairBatch,
      zipDraft.fileVersion,
      overview?.batches || []
    );
    if (versionError) {
      setFolderError(versionError);
      return;
    }
    setFolderBusy(true);
    setFolderError("");
    setFolderResult(null);
    try {
      const form = new FormData();
      form.set("ontology", zipDraft.ontology);
      form.set("modality", zipDraft.modality);
      form.set("channel", zipDraft.modality === "fpv_video" ? zipDraft.channel : "");
      form.set("batch", targetBatch);
      form.set("file_version", fileVersion);
      form.set("replace", String(zipDraft.replace));
      form.set("follow_paths", zipDraft.followPaths ? "1" : "0");
      form.set(
        "merge_c3d",
        zipDraft.mergeC3d && isMotionModality(zipDraft.modality) ? "true" : "false"
      );
      form.set(
        "annotation",
        JSON.stringify({
          ...(zipDraft.ontology === "robot"
            ? {
                robot_style: zipDraft.robotStyle,
                robot_version: zipDraft.robotVersion,
              }
            : {
                person_name: zipDraft.personName.trim(),
                gender: zipDraft.gender,
                height: zipDraft.height.trim(),
                ...(zipDraft.modality === "motion"
                  ? {
                      human_model: resolveHumanModelName(zipDraft.humanModel),
                      human_model_file: zipDraft.humanModelFile,
                    }
                  : {}),
              }),
          ...(isMotionModality(zipDraft.modality)
            ? { motion_kind: resolveMotionKind(zipDraft.motionKind) }
            : {}),
          ...(zipDraft.ontology === "robot" ? { fps: parseCsvFps(zipDraft.fps) } : {}),
        })
      );
      form.set("taxonomy_tag_ids", JSON.stringify(taxonomyPayload));
      if (zipDraft.localPath.trim()) {
        form.set("local_path", zipDraft.localPath.trim());
      } else if (zipDraft.file) {
        form.set("file", zipDraft.file);
      } else {
        setFolderError("请选择 zip 或填写服务器路径");
        setFolderBusy(false);
        return;
      }
      let sessionId: string | undefined;
      const uploadedPaths: string[] = [];
      const showZipResult = (result: StorageFolderUploadResult) => {
        sessionId = result.upload_session_id || undefined;
        uploadedPaths.splice(
          0,
          uploadedPaths.length,
          ...result.items.map((item) => item.file?.path).filter((path): path is string => !!path)
        );
        setFolderError("");
        setFolderResult(result);
        invalidateStorageOverview();
        onImported(targetBatch, sessionId);
        if (!result.failed) {
          const mergedNote = result.merged_c3d
            ? `（含 ${result.merged_c3d} 组 C3D→FBX 合并数据）`
            : "";
          onMessage(
            `导入完成：上传 ${result.uploaded}${mergedNote}，替换 ${result.replaced}，跳过 ${result.skipped}`
          );
        }
      };
      await execute({
        label: `导入 Zip 到 ${targetBatch}`,
        do: async () => {
          let job: ZipImportJob;
          try {
            job = await api.storageUploadZip(form);
          } catch (error) {
            if (!isGatewayTimeout(error)) throw error;
            job = await api.storageActiveZipJob(targetBatch);
            if (!job.job_id || job.status === "absent") {
              throw new Error("网关等待超时。请到批次里查看是否已经写入，不要重复导入。");
            }
          }
          setZipProgress(job);
          if (job.status === "failed") throw new Error(job.detail || "Zip 导入失败");
          const result =
            job.status === "done" && job.result
              ? job.result
              : await pollZipJob(job.job_id || "", (update) => setZipProgress(update));
          showZipResult(result);
        },
        undo: async () => {
          await undoUploadSession(sessionId, uploadedPaths);
        },
      });
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : "Zip 导入失败");
    } finally {
      setFolderBusy(false);
      setZipProgress(null);
    }
  };

  const folderRows = useMemo(() => {
    if (!folderDraft) return [];
    const target = resolveImportTarget(
      folderDraft.batchChoice,
      folderDraft.folderName,
      folderDraft.batchName,
      folderDraft.repairBatch
    );
    const targetBatch = target.batch;
    const expectedVersion = target.existing
      ? folderDraft.fileVersion.trim() || "原版"
      : "原版";
    const existingUnits =
      overview?.batches.find((item) => item.name === targetBatch)?.units || [];

    const effectiveMergeC3d =
      folderDraft.mergeC3d &&
      isMotionModality(folderDraft.modality) &&
      folderDraft.mergeablePairs.length > 0;
    const byPath = new Map(folderDraft.files.map((item) => [item.path, item]));
    const c3dByFbxPath = new Map<string, RelFile>();
    const pairedC3dPaths = new Set<string>();
    if (effectiveMergeC3d) {
      for (const pair of folderDraft.mergeablePairs) {
        const c3dFile = byPath.get(pair.c3dRel);
        if (c3dFile) {
          c3dByFbxPath.set(pair.fbxRel, c3dFile);
          pairedC3dPaths.add(pair.c3dRel);
        }
      }
    }

    const activeFiles = effectiveMergeC3d
      ? folderDraft.files.filter((item) => !pairedC3dPaths.has(item.path))
      : folderDraft.files;

    const clipPlan = folderDraft.followPaths
      ? planFollowedPaths(
          activeFiles.map((item) => item.path),
          true
        )
      : planClipUnits(activeFiles.map((item) => item.path));
    const seenStored = new Set<string>();
    return activeFiles.map((relFile) => {
      const pairedC3d = c3dByFbxPath.get(relFile.path) || null;
      const planned = clipPlan.get(relFile.path);
      const unitName = planned?.skip
        ? relFile.file.name
        : planned?.unitName || fileUnitName(relFile);
      const storedName = planned?.storedName || relFile.file.name;
      const effectiveFormat = pairedC3d ? "fbx" : fileExtension(relFile) || folderDraft.format;
      const effectiveKind: MotionKind = pairedC3d
        ? "merged"
        : resolveMotionKind(folderDraft.motionKind);
      const duplicateKey = `${effectiveKind}\0${storedName}`;
      const duplicate = !planned?.skip && seenStored.has(duplicateKey);
      if (!planned?.skip) seenStored.add(duplicateKey);
      const existingUnit = matchExistingUnit(unitName, existingUnits);
      const newRobotStyle = folderDraft.ontology === "robot" ? folderDraft.robotStyle.trim() : "";
      const existingFile = existingUnit?.files.find(
        (item) =>
          item.ontology === folderDraft.ontology &&
          item.modality === folderDraft.modality &&
          (item.channel || "") ===
            (folderDraft.modality === "fpv_video" ? folderDraft.channel : "") &&
          item.format === effectiveFormat &&
          item.name === storedName &&
          (item.file_version || "原版") === expectedVersion &&
          String(item.robot_style || item.annotation?.robot_style || "").trim() ===
            newRobotStyle &&
          (!isMotionModality(folderDraft.modality) ||
            resolveMotionKind(item.annotation?.motion_kind) === effectiveKind)
      );
      const existingRobotStyle = existingFile ? String(existingFile.robot_style || existingFile.annotation?.robot_style || "").trim() : "";
      const styleDiffers =
        folderDraft.ontology === "robot" &&
        !!newRobotStyle &&
        !!existingRobotStyle &&
        newRobotStyle !== existingRobotStyle;
      const existingConflict = !!existingFile && !planned?.skip;
      const defaultAction: FolderAction =
        planned?.skip || duplicate || existingConflict ? "skip" : "upload";
      return {
        relFile,
        pairedC3d,
        unitName,
        duplicate,
        existingConflict,
        styleDiffers,
        action: folderDraft.actions[relFile.path] || (folderDraft.replace && existingConflict ? "replace" : defaultAction),
      };
    });
  }, [folderDraft, overview]);

  const folderExtensions = useMemo(
    () =>
      folderDraft
        ? Array.from(
            new Set(
              folderRows
                .map((row) => (row.pairedC3d ? "fbx" : fileExtension(row.relFile)))
                .filter(Boolean)
            )
          )
        : [],
    [folderDraft, folderRows]
  );

  const updateFolderDraft = (patch: Partial<FolderImportDraft>) => {
    setFolderDraft((current) => (current ? { ...current, ...patch } : null));
    setFolderResult(null);
    setFolderError("");
  };

  const submitFolderImport = async () => {
    if (!folderDraft) return;
    const target = resolveImportTarget(
      folderDraft.batchChoice,
      folderDraft.folderName,
      folderDraft.batchName,
      folderDraft.repairBatch
    );
    const targetBatch = target.batch;
    const fileVersion = target.existing ? folderDraft.fileVersion.trim() : "";
    if (!folderDraft.batchChoice && !folderDraft.repairBatch.trim()) {
      setFolderError("请选择修改名称创建新批次，或添加至现有批次");
      return;
    }
    if (!targetBatch) {
      setFolderError("批次名称不能为空");
      return;
    }
    const versionError = validateFileVersion(
      target,
      folderDraft.repairBatch,
      folderDraft.fileVersion,
      overview?.batches || []
    );
    if (versionError) {
      setFolderError(versionError);
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
      form.set("file_version", fileVersion);
      form.set("follow_paths", folderDraft.followPaths ? "1" : "0");
      const effectiveMergeC3d =
        folderDraft.mergeC3d &&
        isMotionModality(folderDraft.modality) &&
        folderDraft.mergeablePairs.length > 0;
      form.set("merge_c3d", effectiveMergeC3d ? "1" : "0");
      form.set("actions", JSON.stringify(folderRows.map((row) => row.action)));
      form.set(
        "annotation",
        JSON.stringify({
          ...(folderDraft.ontology === "robot"
            ? {
                robot_style: folderDraft.robotStyle,
                robot_version: folderDraft.robotVersion,
              }
            : {
                person_name: folderDraft.personName.trim(),
                gender: folderDraft.gender,
                height: folderDraft.height.trim(),
                ...(isSmplFormat(folderDraft.format) ||
                folderDraft.files.some((item) => isSmplFormat("", item.file.name))
                  ? {
                      human_model: resolveHumanModelName(folderDraft.humanModel),
                      human_model_file: folderDraft.humanModelFile,
                    }
                  : {}),
              }),
          ...(isMotionModality(folderDraft.modality)
            ? { motion_kind: resolveMotionKind(folderDraft.motionKind) }
            : {}),
          ...(needsManualCsvFps(
            folderDraft.ontology,
            folderDraft.format || (folderExtensions.includes("csv") ? "csv" : "")
          )
            ? { fps: parseCsvFps(folderDraft.fps) }
            : {}),
        })
      );
      form.set("taxonomy_tag_ids", JSON.stringify(taxonomyPayload));
      const subPaths = folderRows.map((row) => {
        const dir = row.relFile.path.split("/").slice(0, -1).join("/");
        return dir || "";
      });
      form.set("sub_paths", JSON.stringify(subPaths));
      folderRows.forEach((row, idx) => {
        form.append("files", row.relFile.file, row.relFile.file.name);
        if (row.pairedC3d && row.action !== "skip") {
          form.append("c3d_files", row.pairedC3d.file, row.pairedC3d.file.name);
          form.append("c3d_target_indices", String(idx));
        }
      });
      let sessionId: string | undefined;
      const uploadedPaths: string[] = [];
      await execute({
        label: `导入文件夹到 ${targetBatch}`,
        do: async () => {
          const result = await api.storageUploadFolder(form);
          sessionId = result.upload_session_id || undefined;
          uploadedPaths.splice(
            0,
            uploadedPaths.length,
            ...result.items.map((item) => item.file?.path).filter((path): path is string => !!path)
          );
          setFolderResult(result);
          invalidateStorageOverview();
          onImported(targetBatch, sessionId);
          if (!result.failed) {
            const mergedNote = result.merged_c3d
              ? `（含 ${result.merged_c3d} 组 C3D→FBX 合并数据）`
              : "";
            onMessage(
              `文件夹导入完成：上传 ${result.uploaded}${mergedNote}，替换 ${result.replaced}，跳过 ${result.skipped}`
            );
          }
        },
        undo: async () => {
          await undoUploadSession(sessionId, uploadedPaths);
        },
      });
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : "文件夹导入失败");
    } finally {
      setFolderBusy(false);
    }
  };

  const taxonomyEditor = (disabled?: boolean) => (
    <UploadTaxonomyFields
      schemes={schemes}
      nodes={nodes}
      value={taxonomyTagIds}
      onChange={onTaxonomyTagIdsChange}
      canCreate={canCreateTaxonomy}
      onNodesReload={onNodesReload}
      disabled={disabled}
    />
  );

  return (
    <>
      {showInlinePreset && (
        <section className="storage-upload-preset card-soft">
          <div>
            <strong>预设分类标签</strong>
            <p className="muted" style={{ margin: "2px 0 0", fontSize: "0.78rem" }}>
              先选标签再拖入；弹窗和导入后都还能改。
            </p>
          </div>
          {taxonomyEditor()}
        </section>
      )}
      <div
        className={`storage-batch-drop ${layout === "dock" ? "is-dock" : ""} ${
          draggingFolder ? "dragging" : ""
        }`}
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
          className={`storage-batch-create ${layout === "dock" ? "is-compact" : ""}`}
          onClick={() => void createBatch()}
        >
          <strong>＋ 新建批次</strong>
          {layout !== "dock" && <span>点击创建空批次</span>}
        </button>
        {layout !== "dock" && (
          <div className="storage-batch-drop-hint">
            或将文件夹 / zip 拖到这里批量导入（如 260902.zip）
          </div>
        )}
        <div className="row storage-batch-drop-actions">
          <button
            type="button"
            className="storage-batch-folder-pick secondary"
            onClick={() => folderInputRef.current?.click()}
          >
            选择文件夹
          </button>
          <button
            type="button"
            className="storage-batch-folder-pick secondary"
            onClick={() => zipInputRef.current?.click()}
          >
            选择 zip
          </button>
          <input
            value={localZipPath}
            placeholder="/home/noetix/Downloads/260902.zip"
            onChange={(event) => setLocalZipPath(event.target.value)}
          />
          <button
            type="button"
            className="secondary"
            disabled={!!inspectingText}
            onClick={() => void openZipImport(null, localZipPath.trim())}
          >
            {inspectingText ? "正在检查…" : "从服务器路径导入"}
          </button>
        </div>
        {inspectingText && (
          <div className="muted" style={{ fontSize: "0.8rem", marginTop: 6 }}>
            {inspectingText}
          </div>
        )}
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
        <input
          ref={zipInputRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void openZipImport(file);
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

            <FileVersionFields
              batches={overview?.batches || []}
              repairBatch={folderDraft.repairBatch}
              fileVersion={folderDraft.fileVersion}
              batchChoice={folderDraft.batchChoice}
              disabled={folderBusy}
              onRepairBatch={(repairBatch) =>
                updateFolderDraft({ repairBatch, actions: {} })
              }
              onFileVersion={(fileVersion) =>
                updateFolderDraft({ fileVersion, actions: {} })
              }
            />

            <label className="storage-follow-path">
              <input
                type="checkbox"
                checked={folderDraft.followPaths}
                onChange={(event) =>
                  updateFolderDraft({ followPaths: event.target.checked, actions: {} })
                }
              />
              遵循文件中的路径
              <small>
                {folderDraft.followPaths
                  ? "按文件夹里的目录显示"
                  : "忽略所有目录，只按文件格式归入同一条动作"}
              </small>
            </label>

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
                格式（可选覆盖）
                <input
                  value={folderDraft.format}
                  onChange={(event) =>
                    updateFolderDraft({
                      format: event.target.value,
                      actions: {},
                    })
                  }
                  placeholder="留空则按每个文件的后缀入库"
                />
              </label>
              {needsManualCsvFps(
                folderDraft.ontology,
                folderDraft.format || (folderExtensions.includes("csv") ? "csv" : "")
              ) && (
                <label>
                  帧率（Hz，机器人 CSV）
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    step="0.1"
                    value={folderDraft.fps}
                    placeholder="默认 30"
                    onChange={(event) =>
                      updateFolderDraft({ fps: event.target.value })
                    }
                  />
                </label>
              )}
              {isMotionModality(folderDraft.modality) && (
                <MotionKindFields
                  value={folderDraft.motionKind}
                  onChange={(motionKind) => updateFolderDraft({ motionKind })}
                />
              )}
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
              {folderDraft.ontology === "human" &&
                (isSmplFormat(folderDraft.format) ||
                  folderDraft.files.some((item) => isSmplFormat("", item.file.name))) && (
                <HumanModelFields
                  instances={humanInstances}
                  model={folderDraft.humanModel}
                  modelFile={folderDraft.humanModelFile}
                  onChange={(humanModel, humanModelFile) =>
                    updateFolderDraft({ humanModel, humanModelFile })
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
            <div className="storage-upload-taxonomy-block">
              <strong>分类标签</strong>
              <p className="muted" style={{ margin: "4px 0 8px" }}>
                沿用上方预设，导入前仍可修改
              </p>
              {taxonomyEditor(folderBusy)}
            </div>
            {folderDraft.mergeablePairs.length > 0 &&
              isMotionModality(folderDraft.modality) && (
                <div className="storage-folder-format-warning">
                  <label className="row" style={{ gap: 8, fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={folderDraft.mergeC3d}
                      disabled={folderBusy}
                      onChange={(event) =>
                        updateFolderDraft({
                          mergeC3d: event.target.checked,
                          actions: {},
                        })
                      }
                    />
                    将同名 C3D 数据合并入无 C3D 的 FBX（检测到 {folderDraft.mergeablePairs.length} 组）
                  </label>
                  <small style={{ display: "block", marginTop: 4 }}>
                    {folderDraft.mergeC3d
                      ? `已开启：合并生成的 FBX 将作为「合并数据」上传入库，原有的 ${folderDraft.mergeablePairs.length} 组未合并 FBX 与同名 C3D 文件不再上传（其余格式文件照常上传）。`
                      : "未开启：原有的 FBX 与 C3D 文件将分别按原样上传。"}
                  </small>
                </div>
              )}

            {folderExtensions.length > 0 && (
              <div className="storage-folder-format-warning">
                {folderDraft.format.trim()
                  ? `无后缀的文件将按"${folderDraft.format.trim()}"归档；有后缀的文件仍按各自后缀入库（${folderExtensions.join("、")}）。`
                  : `将按文件后缀分别入库：${folderExtensions.join("、")}。遇到尚未出现过的后缀会自动作为新格式。`}
              </div>
            )}

            {folderDraft.batchChoice === "existing" && (
              <label className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={folderDraft.replace}
                  onChange={(event) =>
                    updateFolderDraft({ replace: event.target.checked, actions: {} })
                  }
                />
                同路径文件已存在则替换（默认跳过）
              </label>
            )}

            <div className="storage-folder-summary">
              将上传 {folderRows.filter((row) => row.action === "upload").length} 个，替换{" "}
              {folderRows.filter((row) => row.action === "replace").length} 个，跳过{" "}
              {folderRows.filter((row) => row.action === "skip").length} 个
              {(() => {
                const dupCount = folderRows.filter((r) => r.duplicate && r.action === "skip").length;
                const conflictCount = folderRows.filter((r) => r.existingConflict && !r.duplicate && r.action === "skip").length;
                const parts: string[] = [];
                if (dupCount) parts.push(`单元名重复 ${dupCount}`);
                if (conflictCount) parts.push(`已有文件 ${conflictCount}`);
                return parts.length ? `（${parts.join("、")}）` : "";
              })()}
            </div>
            <div className="row" style={{ gap: 6, marginBottom: 6 }}>
              <button
                type="button"
                className={fileFilter === "all" ? "active" : "secondary"}
                style={{ fontSize: "0.75rem", padding: "3px 8px" }}
                onClick={() => setFileFilter("all")}
              >
                全部 {folderRows.length}
              </button>
              <button
                type="button"
                className={fileFilter === "new" ? "active" : "secondary"}
                style={{ fontSize: "0.75rem", padding: "3px 8px" }}
                onClick={() => setFileFilter("new")}
              >
                新文件 {folderRows.filter((r) => r.action !== "skip").length}
              </button>
              <button
                type="button"
                className={fileFilter === "skipped" ? "active" : "secondary"}
                style={{ fontSize: "0.75rem", padding: "3px 8px" }}
                onClick={() => setFileFilter("skipped")}
              >
                跳过 {folderRows.filter((r) => r.action === "skip").length}
              </button>
            </div>
            <div className="storage-folder-file-list">
              {folderRows
                .filter((row) => {
                  if (fileFilter === "new") return row.action !== "skip";
                  if (fileFilter === "skipped") return row.action === "skip";
                  return true;
                })
                .map((row) => (
                <div className={`storage-folder-file-row ${row.action === "skip" ? "is-skipped" : ""}`} key={row.relFile.path}>
                  <div>
                    <strong>{row.unitName}</strong>
                    {row.pairedC3d && (
                      <span className="storage-folder-status" style={{ marginLeft: 6 }}>
                        合并 C3D → FBX（合并数据）
                      </span>
                    )}
                    {row.styleDiffers && (
                      <span className="storage-folder-status" style={{ marginLeft: 6 }}>
                        款式不同，同单元新增
                      </span>
                    )}
                    <small title={row.pairedC3d ? `${row.relFile.path} + ${row.pairedC3d.path}` : row.relFile.path}>
                      {row.pairedC3d ? `${row.relFile.path} ← 合并 ${row.pairedC3d.path}` : row.relFile.path}
                    </small>
                  </div>
                  {row.duplicate && row.action === "skip" ? (
                    <span className="storage-folder-status warning">
                      跳过：数据单元名重复
                    </span>
                  ) : row.styleDiffers ? (
                    <span className="storage-folder-status">新文件（不同款式）</span>
                  ) : row.existingConflict && row.action === "skip" ? (
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
                      <option value="skip">跳过：已有同名文件</option>
                      <option value="replace">替换已有文件</option>
                    </select>
                  ) : row.existingConflict && row.action === "replace" ? (
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
                      <option value="skip">跳过：已有同名文件</option>
                      <option value="replace">替换已有文件</option>
                    </select>
                  ) : (
                    <span className="storage-folder-status">新文件</span>
                  )}
                </div>
              ))}
            </div>

            {folderBusy && (
              <div className="stack">
                <span>
                  {folderDraft.mergeC3d && folderDraft.mergeablePairs.length > 0
                    ? `正在合并 ${folderDraft.mergeablePairs.length} 组 C3D 与 FBX 并上传 ${folderRows.filter((r) => r.action !== "skip").length} 项文件，请勿关闭…`
                    : `正在上传 ${folderRows.filter((r) => r.action !== "skip").length} 个文件，请勿关闭…`}
                </span>
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
                上传 {folderResult.uploaded}
                {folderResult.merged_c3d ? `（含 ${folderResult.merged_c3d} 组 C3D→FBX 合并数据）` : ""}
                ，替换 {folderResult.replaced}，跳过 {folderResult.skipped}，失败{" "}
                {folderResult.failed}
                {folderResult.items?.some((item: any) => item.status === "skip") ? (
                  <details>
                    <summary className="muted" style={{ cursor: "pointer", marginTop: 4 }}>
                      查看跳过的文件
                    </summary>
                    <ul>
                      {folderResult.items
                        .filter((item: any) => item.status === "skip")
                        .map((item: any) => (
                          <li key={`${item.name}`}>
                            {item.name}：已有同名文件
                          </li>
                        ))}
                    </ul>
                  </details>
                ) : null}
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

      {zipDraft &&
        createPortal(
          <div
            className="storage-modal-backdrop"
            onClick={() => {
              if (!folderBusy) setZipDraft(null);
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
                  <h3>导入 Zip 批次</h3>
                  <span className="muted">
                    {zipDraft.file?.name || zipDraft.localPath} · 将按扩展名分别入库（bvh / csv
                    / fbx / tak 等），同名动作归入同一数据单元
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={folderBusy}
                  onClick={() => setZipDraft(null)}
                >
                  关闭
                </button>
              </div>
              {(overview?.batches || []).some((item) => item.name === zipDraft.folderName) && (
                <div className="storage-folder-format-warning">
                  <strong>批次“{zipDraft.folderName}”已存在</strong>
                  <label className="row" style={{ gap: 8 }}>
                    <input
                      type="radio"
                      checked={zipDraft.batchChoice === "new"}
                      onChange={() =>
                        updateZipDraft({
                          batchChoice: "new",
                          batchName: nextAvailableBatchName(
                            zipDraft.folderName,
                            overview?.batches || []
                          ),
                        })
                      }
                    />
                    改名新建批次
                  </label>
                  <label className="row" style={{ gap: 8 }}>
                    <input
                      type="radio"
                      checked={zipDraft.batchChoice === "existing"}
                      onChange={() => updateZipDraft({ batchChoice: "existing" })}
                    />
                    添加到现有批次
                  </label>
                </div>
              )}
              {zipDraft.batchChoice === "new" && (
                <label>
                  新批次名称
                  <input
                    value={zipDraft.batchName}
                    onChange={(event) => updateZipDraft({ batchName: event.target.value })}
                  />
                </label>
              )}
              <FileVersionFields
                batches={overview?.batches || []}
                repairBatch={zipDraft.repairBatch}
                fileVersion={zipDraft.fileVersion}
                batchChoice={zipDraft.batchChoice}
                disabled={folderBusy}
                onRepairBatch={(repairBatch) => updateZipDraft({ repairBatch })}
                onFileVersion={(fileVersion) => updateZipDraft({ fileVersion })}
              />
              <label className="storage-follow-path">
                <input
                  type="checkbox"
                  checked={zipDraft.followPaths}
                  onChange={(event) => updateZipDraft({ followPaths: event.target.checked })}
                />
                遵循文件中的路径
                <small>
                  {zipDraft.followPaths
                    ? "按压缩包里的目录显示"
                    : "忽略所有目录，只按文件格式归入同一条动作"}
                </small>
              </label>
              <div className="grid-2">
                <label>
                  本体
                  <select
                    value={zipDraft.ontology}
                    onChange={(event) => updateZipDraft({ ontology: event.target.value })}
                  >
                    <option value="human">人体</option>
                    <option value="robot">机器人</option>
                  </select>
                </label>
                <label>
                  模态
                  <select
                    value={zipDraft.modality}
                    onChange={(event) => updateZipDraft({ modality: event.target.value })}
                  >
                    {MODALITIES.map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {isMotionModality(zipDraft.modality) && (
                <MotionKindFields
                  value={zipDraft.motionKind}
                  onChange={(motionKind) => updateZipDraft({ motionKind })}
                />
              )}
              {zipDraft.ontology === "robot" && (
                <RobotStyleFields
                  instances={robotInstances}
                  style={zipDraft.robotStyle}
                  version={zipDraft.robotVersion}
                  onChange={(robotStyle, robotVersion) =>
                    updateZipDraft({ robotStyle, robotVersion })
                  }
                />
              )}
              {zipDraft.ontology === "human" && zipDraft.modality === "motion" && (
                <HumanModelFields
                  instances={humanInstances}
                  model={zipDraft.humanModel}
                  modelFile={zipDraft.humanModelFile}
                  onChange={(humanModel, humanModelFile) =>
                    updateZipDraft({ humanModel, humanModelFile })
                  }
                />
              )}
              {zipDraft.ontology === "human" && (
                <>
                  <label>
                    姓名
                    <input
                      value={zipDraft.personName}
                      onChange={(event) => updateZipDraft({ personName: event.target.value })}
                    />
                  </label>
                  <label>
                    性别
                    <select
                      value={zipDraft.gender}
                      onChange={(event) => updateZipDraft({ gender: event.target.value })}
                    >
                      <option value="">未填写</option>
                      <option value="男">男</option>
                      <option value="女">女</option>
                    </select>
                  </label>
                </>
              )}
              {zipDraft.ontology === "robot" && (
                <label>
                  帧率（Hz，机器人 CSV）
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    step="0.1"
                    value={zipDraft.fps}
                    placeholder="默认 30"
                    onChange={(event) => updateZipDraft({ fps: event.target.value })}
                  />
                </label>
              )}
              <div className="storage-upload-taxonomy-block">
                <strong>分类标签</strong>
                <p className="muted" style={{ margin: "4px 0 8px" }}>
                  沿用上方预设，导入前仍可修改
                </p>
                {taxonomyEditor(folderBusy)}
              </div>
              {zipDraft.mergeablePairCount > 0 && isMotionModality(zipDraft.modality) && (
                <div className="storage-folder-format-warning">
                  <label className="row" style={{ gap: 8, fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={zipDraft.mergeC3d}
                      disabled={folderBusy}
                      onChange={(event) => updateZipDraft({ mergeC3d: event.target.checked })}
                    />
                    将同名 C3D 数据合并入无 C3D 的 FBX（检测到 {zipDraft.mergeablePairCount} 组）
                  </label>
                  <small style={{ display: "block", marginTop: 4 }}>
                    {zipDraft.mergeC3d
                      ? `已开启：合并生成的 FBX 将作为「合并数据」上传入库，原有的 ${zipDraft.mergeablePairCount} 组未合并 FBX 与同名 C3D 文件不再上传（其余格式文件照常上传）。`
                      : "未开启：原有的 FBX 与 C3D 文件将分别按原样上传。"}
                  </small>
                </div>
              )}
              <label className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={zipDraft.replace}
                  onChange={(event) => updateZipDraft({ replace: event.target.checked })}
                />
                同路径文件已存在则替换
              </label>
              {folderBusy && (
                <div className="stack">
                  <span>
                    {zipProgress && zipProgress.total > 0
                      ? `正在导入，已处理 ${zipProgress.processed} / ${zipProgress.total}${zipProgress.detail ? `（${zipProgress.detail}）` : ""}，请勿关闭…`
                      : `${zipProgress?.detail || "正在解压并导入"}，请勿关闭…`}
                  </span>
                  <progress
                    className="storage-folder-progress"
                    value={zipProgress && zipProgress.total > 0 ? zipProgress.processed : undefined}
                    max={zipProgress && zipProgress.total > 0 ? zipProgress.total : undefined}
                  />
                </div>
              )}
              {folderError && <div className="error">{folderError}</div>}
              {folderResult && (
                <div
                  className={`storage-folder-result ${
                    folderResult.failed ? "error" : "success"
                  }`}
                >
                  上传 {folderResult.uploaded}
                  {folderResult.merged_c3d ? `（含 ${folderResult.merged_c3d} 组 C3D→FBX 合并数据）` : ""}
                  ，替换 {folderResult.replaced}，跳过 {folderResult.skipped}，失败{" "}
                  {folderResult.failed}
                  {folderResult.skipped > 0 && !folderResult.uploaded && !folderResult.replaced && !folderResult.failed ? (
                    <div className="muted" style={{ marginTop: 4 }}>
                      这些文件已经在这个批次里，没有重复写入。
                    </div>
                  ) : null}
                  {!!folderResult.failed && (
                    <ul>
                      {folderResult.items
                        ?.filter((item) => item.status === "failed")
                        .slice(0, 8)
                        .map((item) => (
                          <li key={`${item.name}-${item.detail || ""}`}>
                            {item.name}：{item.detail || "导入失败"}
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
                  onClick={() => setZipDraft(null)}
                >
                  {folderResult ? "完成" : "取消"}
                </button>
                {!folderResult && (
                  <button
                    type="button"
                    disabled={folderBusy || !zipDraft.batchChoice}
                    onClick={() => void submitZipImport()}
                  >
                    {folderBusy ? "正在导入…" : "开始导入"}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}

      {c3dMergePrompt &&
        createPortal(
          <div
            className="storage-modal-backdrop"
            onClick={() => answerMergeC3dChoice(null)}
          >
            <div
              className="storage-modal card stack"
              style={{ maxWidth: 520 }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="storage-folder-import-title">
                <div>
                  <h3>检测到可合并的 C3D 与 FBX 文件</h3>
                  <span className="muted">{c3dMergePrompt.sourceLabel}</span>
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => answerMergeC3dChoice(null)}
                >
                  取消
                </button>
              </div>
              <div className="stack" style={{ gap: 8, fontSize: "0.92rem", lineHeight: 1.55 }}>
                <p style={{ margin: 0 }}>
                  检测到 <strong>{c3dMergePrompt.pairCount}</strong> 组同名的 FBX（不含 C3D 光学点数据）与 C3D 文件
                  {c3dMergePrompt.sampleNames.length > 0
                    ? `（如：${c3dMergePrompt.sampleNames.slice(0, 3).join("、")}${
                        c3dMergePrompt.pairCount > 3 ? " 等" : ""
                      }）`
                    : ""}
                  。是否将 C3D 文件中的 C3D 数据合并入同名的 FBX 中？
                </p>
                <div className="storage-folder-format-warning" style={{ margin: 0 }}>
                  <div>
                    <strong>选择「是」：</strong>将同名 C3D 数据合并入 FBX 后，生成合并数据 FBX 上传入库；<strong>原来的 C3D 和未合并 FBX 文件不再上传</strong>（包内其他格式文件照常上传）。
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <strong>选择「否」：</strong>不进行合并，将原有的 FBX 和 C3D 文件分别原样上传。
                  </div>
                </div>
              </div>
              <div className="row storage-folder-actions" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => answerMergeC3dChoice(false)}
                >
                  否，原样上传
                </button>
                <button
                  type="button"
                  onClick={() => answerMergeC3dChoice(true)}
                >
                  是，合并入 FBX 后上传
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
