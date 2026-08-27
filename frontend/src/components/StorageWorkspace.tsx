import { Children, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, downloadAuth, getToken } from "../api";
import { useAuth } from "../auth";
import { FolderBatchImport } from "./FolderBatchImport";
import { TaxonomySelect } from "./TaxonomyTree";
import type {
  StorageAnnotation,
  StorageBatch,
  StorageFile,
  StorageFileDetail,
  StorageOverview,
  StorageUploader,
  StorageUnit,
  TaxonomyNode,
  TaxonomySchemeDef,
} from "../types";
import { taxonomySchemeLabel } from "../types";

const MODALITY_LABEL: Record<string, string> = {
  tpv_video: "第三视角视频",
  fpv_video: "第一视角视频",
  motion: "运动数据",
  text: "文本",
  audio: "音频",
  log: "日志",
};

const QUALITY_OPTIONS = [
  ["", "未评价"],
  ["pass", "直接通过"],
  ["needs_fix", "需要修改"],
  ["discard", "建议丢弃"],
];

const GENDER_OPTIONS = [
  ["", "未填写"],
  ["男", "男"],
  ["女", "女"],
];

const genderLabel = (value: string) =>
  GENDER_OPTIONS.find(([key]) => key === value)?.[1] || value || "未填写";

const heightLabel = (value: string) => {
  const trimmed = value.trim();
  return trimmed ? `${trimmed} cm` : "未填写";
};

const uploaderLabel = (uploaders: StorageUploader[] | undefined) =>
  uploaders?.length
    ? uploaders.map((item) => item.username).join("、")
    : "上传者未知";

const qualityLabel = (value: string) =>
  QUALITY_OPTIONS.find(([key]) => key === value)?.[1] || "未评价";

function Preview({ file }: { file: StorageFile | null }) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let objectUrl = "";
    let cancelled = false;
    setUrl("");
    setText("");
    setError("");
    if (!file) return;
    const token = getToken();
    fetch(api.storageFileUrl(file.path), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("预览加载失败");
        if (file.modality === "text" || ["json", "txt", "csv", "xml", "urdf"].includes(file.format)) {
          const content = await res.text();
          if (!cancelled) setText(content.slice(0, 12000));
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "预览失败");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file?.path]);

  if (!file) return <div className="storage-preview-empty">选择右上方文件后在这里预览</div>;
  if (error) return <div className="storage-preview-empty">{error}</div>;
  if (text) return <pre className="storage-text-preview">{text}</pre>;
  if (!url) return <div className="storage-preview-empty">正在加载 {file.name}…</div>;
  if (file.modality.includes("video")) {
    return <video controls src={url} className="storage-media-preview" />;
  }
  if (file.modality === "audio") {
    return <audio controls src={url} style={{ width: "90%" }} />;
  }
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(file.format)) {
    return <img src={url} alt={file.name} className="storage-media-preview" />;
  }
  return (
    <div className="storage-preview-empty">
      {file.name}
      <br />
      此格式暂不支持浏览器内预览，可下载查看
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`storage-tree-chevron ${open ? "is-open" : ""}`}>
      <path
        d="M6 4.2 10.4 8 6 11.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="storage-tree-glyph">
      <path
        d="M2.2 4.2A1.2 1.2 0 0 1 3.4 3h3.1c.3 0 .6.1.8.4l.7.8h4.6c.7 0 1.2.6 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3.4c-.7 0-1.2-.5-1.2-1.2V4.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function UnitIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="storage-tree-glyph">
      <rect x="3" y="2.5" width="10" height="11" rx="1.6" fill="currentColor" />
      <path d="M5.2 6h5.6M5.2 8.4h5.6M5.2 10.8h3.4" stroke="#0f1218" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="storage-tree-glyph">
      <circle cx="8" cy="5.2" r="2.3" fill="currentColor" />
      <path d="M3.2 13c.4-2.4 2.3-3.6 4.8-3.6S12.4 10.6 12.8 13" fill="currentColor" />
    </svg>
  );
}

function TreeAllButton({
  selected,
  children,
  onClick,
}: {
  selected: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`storage-tree-all ${selected ? "is-selected" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TreeToolbar({
  onCollapseAll,
  onExpandAll,
}: {
  onCollapseAll: () => void;
  onExpandAll: () => void;
}) {
  return (
    <div className="storage-tree-toolbar">
      <button
        type="button"
        className="secondary"
        title="展开上级目录，收起数据单元"
        onClick={onCollapseAll}
      >
        全部折叠
      </button>
      <button
        type="button"
        className="secondary"
        title="展开上级目录和数据单元"
        onClick={onExpandAll}
      >
        全部展开
      </button>
    </div>
  );
}

function TreeGroup({
  open,
  selected,
  title,
  meta,
  icon = "folder",
  toggleLabel,
  onToggle,
  onSelect,
  children,
  nested = false,
}: {
  open: boolean;
  selected: boolean;
  title: string;
  meta: ReactNode;
  icon?: "folder" | "user";
  toggleLabel: string;
  onToggle: () => void;
  onSelect: () => void;
  children?: ReactNode;
  nested?: boolean;
}) {
  const activate = () => {
    onToggle();
    onSelect();
  };
  const body = (
    <>
      <button
        type="button"
        className={`storage-tree-row ${selected ? "is-selected" : ""}`}
        title={title}
        aria-label={toggleLabel}
        aria-expanded={open}
        onClick={activate}
      >
        <span className="storage-tree-toggle">
          <ChevronIcon open={open} />
        </span>
        <span className="storage-tree-item">
          <span className={`storage-tree-icon ${icon === "user" ? "is-user" : "is-folder"}`}>
            {icon === "user" ? <UserIcon /> : <FolderIcon />}
          </span>
          <span className="storage-tree-copy">
            <span className="storage-tree-title">{title}</span>
            <span className="storage-tree-meta">{meta}</span>
          </span>
        </span>
      </button>
      {open && Children.toArray(children).some(Boolean) && (
        <div className="storage-tree-children">{children}</div>
      )}
    </>
  );
  if (nested) return <div className="storage-tree-nested">{body}</div>;
  return <div className={`storage-tree-node ${open ? "is-open" : ""}`}>{body}</div>;
}

function TreeUnitItem({
  title,
  meta,
  selected,
  onClick,
}: {
  title: string;
  meta: ReactNode;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      className={`storage-tree-item storage-tree-child ${selected ? "is-selected" : ""}`}
      onClick={onClick}
    >
      <span className="storage-tree-icon is-unit">
        <UnitIcon />
      </span>
      <span className="storage-tree-copy">
        <span className="storage-tree-title">{title}</span>
        <span className="storage-tree-meta">{meta}</span>
      </span>
    </button>
  );
}

function UnitTree({
  data,
  selectedUnit,
  selectedBatch,
  onSelectUnit,
  onSelectBatch,
}: {
  data: StorageOverview;
  selectedUnit: string | null;
  selectedBatch: string | null;
  onSelectUnit: (unit: StorageUnit) => void;
  onSelectBatch: (batch: StorageBatch) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const batchKeys = data.batches.map((batch) => batch.name);

  return (
    <div className="storage-tree storage-structure-tree">
      <TreeToolbar
        onCollapseAll={() => setExpanded({})}
        onExpandAll={() =>
          setExpanded(Object.fromEntries(batchKeys.map((key) => [key, true])))
        }
      />
      {data.batches.map((batch) => {
        const open = expanded[batch.name] === true;
        return (
          <TreeGroup
            key={batch.name}
            open={open}
            selected={selectedBatch === batch.name && !selectedUnit}
            title={batch.name}
            meta={
              <>
                <span>{batch.unit_count} 个单元</span>
                <span>{uploaderLabel(batch.uploaders)}</span>
              </>
            }
            toggleLabel={open ? "收起批次" : "展开批次"}
            onToggle={() =>
              setExpanded((current) => ({
                ...current,
                [batch.name]: !open,
              }))
            }
            onSelect={() => onSelectBatch(batch)}
          >
            {open ? (
              <>
                {batch.units.map((unit) => (
                  <TreeUnitItem
                    key={unit.key}
                    title={unit.name}
                    meta={uploaderLabel(unit.uploaders)}
                    selected={selectedUnit === unit.key}
                    onClick={() => onSelectUnit(unit)}
                  />
                ))}
                {!batch.units.length && (
                  <div className="muted storage-tree-empty">暂无数据单元</div>
                )}
              </>
            ) : null}
          </TreeGroup>
        );
      })}
      {!data.batches.length && <div className="muted">没有匹配的数据批次</div>}
    </div>
  );
}

function UploaderTreePanel({
  uploaders,
  units,
  selectedId,
  selectedKey,
  onSelect,
  onUnitSelect,
}: {
  uploaders: StorageUploader[];
  units: StorageUnit[];
  selectedId: number | null;
  selectedKey: string | null;
  onSelect: (id: number | null) => void;
  onUnitSelect: (unit: StorageUnit) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const uploaderKeys = uploaders.map((item) => String(item.id));

  return (
    <div className="storage-tree storage-structure-tree">
      <TreeToolbar
        onCollapseAll={() => setExpanded({})}
        onExpandAll={() =>
          setExpanded(Object.fromEntries(uploaderKeys.map((key) => [key, true])))
        }
      />
      <TreeAllButton selected={selectedId == null} onClick={() => onSelect(null)}>
        全部上传用户
      </TreeAllButton>
      {uploaders.map((uploader) => {
        const uploaderUnits = units.filter((unit) =>
          unit.files.some((file) =>
            uploader.id === -1
              ? !file.uploader
              : file.uploader?.id === uploader.id
          )
        );
        const key = String(uploader.id);
        const open = expanded[key] === true;
        return (
          <TreeGroup
            key={uploader.id}
            open={open}
            selected={selectedId === uploader.id}
            title={uploader.username}
            icon="user"
            meta={
              <>
                <span>{uploaderUnits.length} 个单元</span>
                <span>{uploader.file_count || 0} 个文件</span>
              </>
            }
            toggleLabel={open ? "收起用户" : "展开用户"}
            onToggle={() =>
              setExpanded((current) => ({
                ...current,
                [key]: !open,
              }))
            }
            onSelect={() => onSelect(uploader.id)}
          >
            {open ? (
              <>
                {uploaderUnits.map((unit) => (
                  <TreeUnitItem
                    key={unit.key}
                    title={unit.name}
                    meta={unit.batch}
                    selected={selectedKey === unit.key}
                    onClick={() => {
                      onSelect(uploader.id);
                      onUnitSelect(unit);
                    }}
                  />
                ))}
                {!uploaderUnits.length && (
                  <div className="muted storage-tree-empty">暂无数据单元</div>
                )}
              </>
            ) : null}
          </TreeGroup>
        );
      })}
    </div>
  );
}

function TaxonomyTreePanel({
  nodes,
  units,
  selectedId,
  selectedKey,
  onSelect,
  onUnitSelect,
}: {
  nodes: TaxonomyNode[];
  units: StorageUnit[];
  selectedId: number | null;
  selectedKey: string | null;
  onSelect: (id: number | null) => void;
  onUnitSelect: (unit: StorageUnit) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [expandedUnits, setExpandedUnits] = useState<Record<number, boolean>>({});
  const children = new Map<number | null, TaxonomyNode[]>();
  nodes.forEach((node) => {
    const list = children.get(node.parent_id) || [];
    list.push(node);
    children.set(node.parent_id, list);
  });
  children.forEach((list) =>
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  );
  const scheme = nodes[0]?.scheme || "";
  const countUnder = (node: TaxonomyNode) =>
    units.filter((unit) => {
      const taggedId = unit.taxonomy_tag_ids?.[scheme];
      const tagged = nodes.find((item) => item.id === taggedId);
      return !!tagged && tagged.path.startsWith(node.path);
    }).length;

  const renderNodes = (parentId: number | null, depth = 0): ReactNode =>
    (children.get(parentId) || []).map((node) => {
      const childRows = children.get(node.id) || [];
      const directUnits = units.filter(
        (unit) => unit.taxonomy_tag_ids?.[scheme] === node.id
      );
      const hasNested = childRows.length > 0;
      const dirOpen = collapsed[node.id] !== true;
      const unitsVisible = expandedUnits[node.id] === true;
      const open = hasNested ? dirOpen : unitsVisible;
      return (
        <TreeGroup
          key={node.id}
          nested={depth > 0}
          open={open}
          selected={selectedId === node.id}
          title={node.code ? `${node.code} ${node.name}` : node.name}
          meta={<span>{countUnder(node)} 个单元</span>}
          toggleLabel={open ? "收起分类" : "展开分类"}
          onToggle={() => {
            if (hasNested) {
              setCollapsed((current) => ({ ...current, [node.id]: dirOpen }));
              return;
            }
            setExpandedUnits((current) => ({ ...current, [node.id]: !unitsVisible }));
          }}
          onSelect={() => onSelect(node.id)}
        >
          {unitsVisible &&
            directUnits.map((unit) => (
              <TreeUnitItem
                key={unit.key}
                title={unit.name}
                meta={unit.batch}
                selected={selectedKey === unit.key}
                onClick={() => {
                  onSelect(node.id);
                  onUnitSelect(unit);
                }}
              />
            ))}
          {dirOpen && childRows.length > 0 && renderNodes(node.id, depth + 1)}
          {unitsVisible && !directUnits.length && !childRows.length && (
            <div className="muted storage-tree-empty">暂无数据单元</div>
          )}
        </TreeGroup>
      );
    });

  return (
    <div className="storage-tree storage-structure-tree">
      <TreeToolbar
        onCollapseAll={() => {
          setCollapsed({});
          setExpandedUnits({});
        }}
        onExpandAll={() => {
          setCollapsed({});
          setExpandedUnits(Object.fromEntries(nodes.map((node) => [node.id, true])));
        }}
      />
      <TreeAllButton selected={selectedId == null} onClick={() => onSelect(null)}>
        全部分类节点
      </TreeAllButton>
      {renderNodes(null)}
      {!nodes.length && <div className="muted">该分类标准暂无节点</div>}
    </div>
  );
}

function QuickUpload({
  unit,
  preset,
  manageOverride,
  onClose,
  onUploaded,
}: {
  unit: StorageUnit;
  preset?: { ontology: string; modality: string };
  manageOverride: boolean;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [ontology, setOntology] = useState(preset?.ontology || "human");
  const [modality, setModality] = useState(preset?.modality || "motion");
  const [channel, setChannel] = useState("rgb");
  const [format, setFormat] = useState("");
  const [robotStyle, setRobotStyle] = useState("");
  const [personName, setPersonName] = useState("");
  const [gender, setGender] = useState("");
  const [height, setHeight] = useState("");
  const [robotStyles, setRobotStyles] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (ontology !== "robot") return;
    let cancelled = false;
    api
      .storageModels()
      .then((data) => {
        if (cancelled) return;
        setRobotStyles(
          data.instances
            .filter((item) => item.ontology === "robot")
            .map((item) => item.name)
        );
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "机器人款式加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [ontology]);

  const submit = async () => {
    if (!file || !format.trim()) {
      setError("请选择文件并填写格式");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("ontology", ontology);
      form.set("modality", modality);
      form.set("channel", modality === "fpv_video" ? channel : "");
      form.set("format", format.trim());
      form.set("batch", unit.batch);
      form.set("unit_name", unit.name);
      form.set("replace", String(replace));
      form.set("manage_override", String(manageOverride));
      form.set(
        "annotation",
        JSON.stringify(
          ontology === "robot"
            ? { robot_style: robotStyle }
            : {
                person_name: personName.trim(),
                gender,
                height: height.trim(),
              }
        )
      );
      form.set("file", file);
      await api.storageUpload(form);
      onUploaded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="storage-modal-backdrop" onClick={onClose}>
      <div className="storage-modal card stack" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0 }}>
          向 {unit.batch} / {unit.name} 添加数据
        </h3>
        {error && <div className="error">{error}</div>}
        <div className="grid-2">
          <label>
            本体
            <select value={ontology} onChange={(e) => setOntology(e.target.value)}>
              <option value="human">人体</option>
              <option value="robot">机器人</option>
            </select>
          </label>
          <label>
            模态
            <select value={modality} onChange={(e) => setModality(e.target.value)}>
              {Object.entries(MODALITY_LABEL).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {modality === "fpv_video" && (
          <label>
            第一视角类型
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="rgb">RGB</option>
              <option value="depth">Depth</option>
            </select>
          </label>
        )}
        <label>
          格式
          <input value={format} onChange={(e) => setFormat(e.target.value)} placeholder="csv / mp4 / json…" />
        </label>
        {ontology === "robot" && (
          <label>
            机器人款式
            <select value={robotStyle} onChange={(e) => setRobotStyle(e.target.value)}>
              <option value="">未选择</option>
              {robotStyles.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {ontology === "human" && (
          <>
            <label>
              姓名
              <input
                value={personName}
                placeholder="采集对象姓名"
                onChange={(e) => setPersonName(e.target.value)}
              />
            </label>
            <label>
              性别
              <select value={gender} onChange={(e) => setGender(e.target.value)}>
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
                value={height}
                placeholder="厘米"
                onChange={(e) => setHeight(e.target.value)}
              />
            </label>
          </>
        )}
        <label>
          文件
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={replace}
            onChange={(e) => setReplace(e.target.checked)}
          />
          如果同路径文件已存在则替换
        </label>
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? "上传中…" : "确认上传"}
          </button>
        </div>
      </div>
    </div>
  );
}

const ONTOLOGY_LABEL: Record<string, string> = {
  human: "人体",
  robot: "机器人",
};

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(2)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes} 分 ${rest.toFixed(1)} 秒`;
}

function formatNumber(value: number | null | undefined, suffix = "") {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const numeric = Number(value);
  const text = Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
  return suffix ? `${text} ${suffix}` : text;
}

function formatDateTime(value: string | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="storage-detail-row">
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

type DetailKind = "batch" | "unit" | "file";

const FILE_TAG_KEYS = new Set(["custom_2", "custom_3", "custom_4"]);
const FILE_TAG_NAMES = new Set(["获取方式", "获取地点", "获取设备"]);

function schemesForKind(kind: DetailKind, schemes: TaxonomySchemeDef[]) {
  if (kind !== "file") return schemes;
  return schemes.filter(
    (scheme) => FILE_TAG_KEYS.has(scheme.key) || FILE_TAG_NAMES.has(scheme.name)
  );
}

function EntityDetailPanel({
  kind,
  batch,
  unit,
  file,
  schemes,
  nodes,
  canEdit,
  canCreate,
  onReload,
  onNodesReload,
  onError,
  onMessage,
}: {
  kind: DetailKind | null;
  batch: StorageBatch | null;
  unit: StorageUnit | null;
  file: StorageFile | null;
  schemes: TaxonomySchemeDef[];
  nodes: TaxonomyNode[];
  canEdit: boolean;
  canCreate: boolean;
  onReload: () => Promise<void>;
  onNodesReload: () => Promise<void>;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [detail, setDetail] = useState<StorageFileDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [quality, setQuality] = useState("");
  const [robotStyle, setRobotStyle] = useState("");
  const [personName, setPersonName] = useState("");
  const [gender, setGender] = useState("");
  const [height, setHeight] = useState("");
  const [robotStyles, setRobotStyles] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (kind !== "file" || !file) {
      setDetail(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .storageFileDetail(file.path)
      .then((row) => {
        if (!cancelled) setDetail(row);
      })
      .catch((e) => {
        if (!cancelled) onError(e instanceof Error ? e.message : "详情加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, file?.path]);

  const viewFile = detail || file;
  const annotation: StorageAnnotation =
    kind === "file"
      ? detail?.annotation || file?.annotation || {}
      : kind === "unit"
        ? unit?.annotation || {}
        : batch?.annotation || {};
  const tagIds =
    kind === "file"
      ? detail?.taxonomy_tag_ids || file?.taxonomy_tag_ids || {}
      : kind === "unit"
        ? unit?.taxonomy_tag_ids || {}
        : batch?.taxonomy_tag_ids || {};
  const tags =
    kind === "file"
      ? detail?.taxonomy_tags || file?.taxonomy_tags || {}
      : kind === "unit"
        ? unit?.taxonomy_tags || {}
        : batch?.taxonomy_tags || {};
  const parentTags =
    kind === "file"
      ? { ...(detail?.batch_taxonomy_tags || batch?.taxonomy_tags || {}), ...(detail?.unit_taxonomy_tags || unit?.taxonomy_tags || {}) }
      : kind === "unit"
        ? batch?.taxonomy_tags || {}
        : {};
  const visibleSchemes = kind ? schemesForKind(kind, schemes) : [];

  useEffect(() => {
    setNote(String(annotation.note || ""));
    setQuality(String(annotation.quality || ""));
    setRobotStyle(String(annotation.robot_style || ""));
    setPersonName(String(annotation.person_name || ""));
    setGender(String(annotation.gender || ""));
    setHeight(String(annotation.height || ""));
    setSaved(false);
  }, [
    kind,
    batch?.name,
    unit?.key,
    file?.path,
    annotation.note,
    annotation.quality,
    annotation.robot_style,
    annotation.person_name,
    annotation.gender,
    annotation.height,
  ]);

  useEffect(() => {
    if (kind !== "file" || (file?.ontology !== "robot" && detail?.ontology !== "robot")) {
      return;
    }
    let cancelled = false;
    api
      .storageModels()
      .then((data) => {
        if (cancelled) return;
        setRobotStyles(
          data.instances
            .filter((item) => item.ontology === "robot")
            .map((item) => item.name)
        );
      })
      .catch((e) => {
        if (!cancelled) onError(e instanceof Error ? e.message : "机器人款式加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [kind, file?.ontology, detail?.ontology]);

  const title =
    kind === "batch" ? "批次详情" : kind === "unit" ? "数据单元详情" : kind === "file" ? "文件详情" : "详情";

  const saveAnnotation = async () => {
    if (!kind) return;
    setSaving(true);
    try {
      const fileAnnotation =
        viewFile?.ontology === "robot"
          ? { quality, note, robot_style: robotStyle }
          : viewFile?.ontology === "human"
            ? { quality, note, person_name: personName.trim(), gender, height: height.trim() }
            : { quality, note };
      const body = {
        annotation: kind === "file" ? fileAnnotation : { note },
      };
      if (kind === "batch" && batch) {
        await api.storageUpdateBatch(batch.name, body);
      } else if (kind === "unit" && unit) {
        await api.storageUpdateUnit(unit.batch, unit.name, body);
      } else if (kind === "file" && file) {
        await api.storageUpdateFileMeta(file.path, body);
        const row = await api.storageFileDetail(file.path);
        setDetail(row);
      }
      setSaved(true);
      onMessage("标签已保存");
      await onReload();
    } catch (e) {
      onError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const saveTaxonomy = async (scheme: string, raw: number | "") => {
    try {
      const body = { taxonomy_tag_ids: { [scheme]: raw === "" ? null : raw } };
      if (kind === "batch" && batch) {
        await api.storageUpdateBatch(batch.name, body);
      } else if (kind === "unit" && unit) {
        await api.storageUpdateUnit(unit.batch, unit.name, body);
      } else if (kind === "file" && file) {
        await api.storageUpdateFileMeta(file.path, body);
      }
      onMessage("分类标签已更新");
      await onReload();
    } catch (e) {
      onError(e instanceof Error ? e.message : "更新失败");
    }
  };

  return (
    <aside className="card storage-detail-pane">
      <h3>{title}</h3>
      {!kind && (
        <div className="storage-preview-empty">
          点击左侧批次、数据单元或具体文件查看标签
        </div>
      )}
      {kind === "batch" && batch && (
        <dl className="storage-detail-list">
          <DetailRow label="数据批次" value={batch.name} />
          <DetailRow label="数据单元数" value={String(batch.unit_count)} />
          <DetailRow label="文件数" value={String(batch.file_count)} />
          <DetailRow label="上传者" value={uploaderLabel(batch.uploaders)} />
        </dl>
      )}
      {kind === "unit" && unit && (
        <dl className="storage-detail-list">
          <DetailRow label="数据单元" value={unit.name} />
          <DetailRow label="数据批次" value={unit.batch} />
          <DetailRow label="文件数" value={String(unit.file_count)} />
          <DetailRow label="上传者" value={uploaderLabel(unit.uploaders)} />
        </dl>
      )}
      {kind === "file" && viewFile && (
        <dl className="storage-detail-list">
          <DetailRow label="文件名" value={viewFile.name} />
          <DetailRow label="路径" value={viewFile.path} />
          <DetailRow label="数据批次" value={viewFile.batch} />
          <DetailRow label="数据单元" value={viewFile.unit_name} />
          <DetailRow
            label="本体"
            value={ONTOLOGY_LABEL[viewFile.ontology] || viewFile.ontology}
          />
          <DetailRow
            label="模态"
            value={MODALITY_LABEL[viewFile.modality] || viewFile.modality}
          />
          {viewFile.channel ? <DetailRow label="通道" value={viewFile.channel} /> : null}
          <DetailRow label="格式" value={viewFile.format} />
          <DetailRow label="体积" value={formatFileSize(viewFile.size)} />
          <DetailRow label="修改时间" value={formatDateTime(viewFile.modified_at)} />
          <DetailRow
            label="上传者"
            value={viewFile.uploader?.username || "上传者未知"}
          />
          <DetailRow label="帧数" value={formatNumber(viewFile.frame_count)} />
          <DetailRow label="帧率" value={formatNumber(viewFile.fps, "fps")} />
          <DetailRow label="时长" value={formatDuration(viewFile.duration_sec)} />
          {viewFile.width || viewFile.height ? (
            <DetailRow
              label="分辨率"
              value={`${viewFile.width || "—"} × ${viewFile.height || "—"}`}
            />
          ) : null}
          {viewFile.joint_count != null ? (
            <DetailRow label="关节数" value={formatNumber(viewFile.joint_count)} />
          ) : null}
          {viewFile.sample_rate != null ? (
            <DetailRow
              label="采样率"
              value={formatNumber(viewFile.sample_rate, "Hz")}
            />
          ) : null}
          {viewFile.column_count != null ? (
            <DetailRow label="列数" value={formatNumber(viewFile.column_count)} />
          ) : null}
        </dl>
      )}
      {kind && (
        <section className="storage-detail-tags stack">
          <h4>标签</h4>
          {visibleSchemes.map((scheme) => {
            const inherited = parentTags[scheme.key]?.path;
            if (canEdit) {
              return (
                <label key={scheme.key}>
                  {taxonomySchemeLabel(scheme.key, schemes)}
                  <TaxonomySelect
                    scheme={scheme.key}
                    nodes={nodes.filter((node) => node.scheme === scheme.key)}
                    value={tagIds[scheme.key] ?? ""}
                    canCreate={canCreate}
                    onNodesReload={onNodesReload}
                    onChange={(id) => void saveTaxonomy(scheme.key, id)}
                  />
                  {!tagIds[scheme.key] && inherited ? (
                    <small className="muted">上级：{inherited}</small>
                  ) : null}
                </label>
              );
            }
            return (
              <DetailRow
                key={scheme.key}
                label={taxonomySchemeLabel(scheme.key, schemes)}
                value={
                  tags[scheme.key]?.path ||
                  (inherited ? `上级：${inherited}` : "未分类")
                }
              />
            );
          })}
          {kind === "file" && viewFile?.ontology === "robot" && canEdit && (
            <label>
              机器人款式
              <select
                value={robotStyle}
                onChange={(e) => {
                  setRobotStyle(e.target.value);
                  setSaved(false);
                }}
              >
                <option value="">未选择</option>
                {[...new Set([robotStyle, ...robotStyles].filter(Boolean))].map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === "file" && viewFile?.ontology === "robot" && !canEdit && (
            <DetailRow
              label="机器人款式"
              value={robotStyle || "未选择"}
            />
          )}
          {kind === "file" && viewFile?.ontology === "human" && canEdit && (
            <>
              <label>
                姓名
                <input
                  type="text"
                  value={personName}
                  placeholder="采集对象姓名"
                  onChange={(e) => {
                    setPersonName(e.target.value);
                    setSaved(false);
                  }}
                />
              </label>
              <label>
                性别
                <select
                  value={gender}
                  onChange={(e) => {
                    setGender(e.target.value);
                    setSaved(false);
                  }}
                >
                  {GENDER_OPTIONS.map(([value, label]) => (
                    <option key={value || "empty"} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                身高（cm）
                <input
                  type="number"
                  min="50"
                  max="250"
                  step="0.1"
                  value={height}
                  placeholder="厘米"
                  onChange={(e) => {
                    setHeight(e.target.value);
                    setSaved(false);
                  }}
                />
              </label>
            </>
          )}
          {kind === "file" && viewFile?.ontology === "human" && !canEdit && (
            <>
              <DetailRow label="姓名" value={personName.trim() || "未填写"} />
              <DetailRow label="性别" value={genderLabel(gender)} />
              <DetailRow label="身高" value={heightLabel(height)} />
            </>
          )}
          {kind === "file" && canEdit && (
            <label>
              数据评价
              <select
                value={quality}
                onChange={(e) => {
                  setQuality(e.target.value);
                  setSaved(false);
                }}
              >
                {QUALITY_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === "file" && !canEdit && (
            <DetailRow
              label="数据评价"
              value={qualityLabel(String(annotation.quality || ""))}
            />
          )}
          {canEdit ? (
            <>
              <label>
                备注
                <textarea
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setSaved(false);
                  }}
                  placeholder="记录采集说明、数据问题或补充信息"
                />
              </label>
              <button type="button" disabled={saving} onClick={() => void saveAnnotation()}>
                {saving ? "保存中…" : saved ? "已保存" : "保存标签"}
              </button>
            </>
          ) : (
            <DetailRow
              label="备注"
              value={String(annotation.note || "").trim() || "暂无备注"}
            />
          )}
        </section>
      )}
      {kind === "file" && loading && <div className="muted">正在读取文件元数据…</div>}
    </aside>
  );
}

function UnitMatrix({
  unit,
  selectedFile,
  onFile,
  canUpload,
  onQuickUpload,
}: {
  unit: StorageUnit;
  selectedFile: StorageFile | null;
  onFile: (file: StorageFile) => void;
  canUpload: boolean;
  onQuickUpload: (preset: { ontology: string; modality: string }) => void;
}) {
  return (
    <div className="storage-unit-matrix">
      {(["human", "robot"] as const).map((ontology) => (
        <section key={ontology} className="storage-ontology-card">
          <h3>{ontology === "human" ? "人体数据" : "机器人数据"}</h3>
          {Object.entries(MODALITY_LABEL).map(([modality, label]) => {
            const files = unit.files.filter(
              (f) => f.ontology === ontology && f.modality === modality
            );
            return (
              <div className="storage-modality-row" key={modality}>
                <div className={`storage-modality-name ${files.length ? "" : "missing"}`}>
                  {label}
                </div>
                <div className="storage-file-pills">
                  {files.map((file) => (
                    <button
                      type="button"
                      key={file.id}
                      className={selectedFile?.id === file.id ? "active" : "secondary"}
                      title={file.path}
                      onClick={() => onFile(file)}
                    >
                      {file.channel ? `${file.channel}/` : ""}
                      {file.format}
                      <span className="storage-file-uploader">
                        {file.uploader?.username || "未知用户"}
                      </span>
                    </button>
                  ))}
                  {!files.length && <span className="muted">缺省</span>}
                </div>
                {canUpload && (
                  <button
                    type="button"
                    className="storage-circle-add"
                    title={`添加${label}`}
                    onClick={() => onQuickUpload({ ontology, modality })}
                  >
                    +
                  </button>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

type WorkspaceVariant = "browse" | "upload" | "annotate" | "manage";

export function StorageWorkspace({
  variant = "browse",
}: {
  variant?: WorkspaceVariant;
}) {
  const { user, isAdmin, hasPerm } = useAuth();
  const [data, setData] = useState<StorageOverview | null>(null);
  const [classificationUnits, setClassificationUnits] = useState<StorageUnit[]>([]);
  const [schemes, setSchemes] = useState<TaxonomySchemeDef[]>([]);
  const [nodes, setNodes] = useState<TaxonomyNode[]>([]);
  const [mode, setMode] = useState("folder");
  const [tagId, setTagId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState("name_asc");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ kind: DetailKind; key: string } | null>(null);
  const [previewFiles, setPreviewFiles] = useState<(StorageFile | null)[]>([
    null,
    null,
    null,
    null,
  ]);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  const [quickPreset, setQuickPreset] = useState<{
    ontology: string;
    modality: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [extraBatches, setExtraBatches] = useState<string[]>([]);
  const loadSequence = useRef(0);
  const pendingSelectBatch = useRef<string | null>(null);

  const hasAnnotationPermission =
    isAdmin || hasPerm("annotate") || hasPerm("edit");
  const canUpload =
    (variant === "manage" && isAdmin) ||
    (variant === "upload" && (isAdmin || hasPerm("upload")));
  const canAnnotate =
    (variant === "annotate" && hasAnnotationPermission) ||
    (variant === "manage" && isAdmin) ||
    (variant === "upload" && (isAdmin || hasPerm("upload")));
  const canDelete = variant === "manage" && isAdmin;
  const canCreateTaxonomy =
    canAnnotate && (isAdmin || hasPerm("edit"));
  const structureOnly = variant === "upload";
  const selectedFile = previewFiles[activePreviewIndex] || null;

  const clearPreviews = () => {
    setPreviewFiles([null, null, null, null]);
    setActivePreviewIndex(0);
  };

  const addPreviewFile = (file: StorageFile) => {
    setFocus({ kind: "file", key: file.path });
    const existingIndex = previewFiles.findIndex((item) => item?.id === file.id);
    if (existingIndex >= 0) {
      setActivePreviewIndex(existingIndex);
      return;
    }
    const emptyIndex = previewFiles.findIndex((item) => item == null);
    const targetIndex =
      previewFiles[activePreviewIndex] == null
        ? activePreviewIndex
        : emptyIndex >= 0
          ? emptyIndex
          : activePreviewIndex;
    setPreviewFiles((current) =>
      current.map((item, index) => (index === targetIndex ? file : item))
    );
    setActivePreviewIndex(targetIndex);
  };

  const removePreviewFile = (index: number) => {
    const next = previewFiles.map((file, itemIndex) =>
      itemIndex === index ? null : file
    );
    setPreviewFiles(next);
    if (index === activePreviewIndex) {
      const nextIndex = next.findIndex((file) => file != null);
      setActivePreviewIndex(nextIndex >= 0 ? nextIndex : 0);
    }
  };

  const load = async (keepSelection = true) => {
    const requestId = ++loadSequence.current;
    setError("");
    try {
      const overview = await api.storageOverview({
        q: query || undefined,
        taxonomy_scheme:
          mode === "folder" || mode === "uploader" ? undefined : mode,
        tag_id:
          mode === "folder" || mode === "uploader" ? undefined : tagId,
        uploader_id: variant === "upload" ? user?.id : undefined,
        include_empty: variant === "manage" ? 1 : undefined,
      });
      if (requestId !== loadSequence.current) return;
      setData(overview);
      if (mode !== "folder" && mode !== "uploader" && tagId == null) {
        setClassificationUnits(overview.units);
      }
      setExtraBatches((current) =>
        current.filter((name) => !overview.batches.some((batch) => batch.name === name))
      );
      const pendingBatchName = pendingSelectBatch.current;
      const importedBatch = pendingBatchName
        ? overview.batches.find((batch) => batch.name === pendingBatchName)
        : null;
      pendingSelectBatch.current = null;
      if (importedBatch?.units[0]) {
        setSelectedKey(importedBatch.units[0].key);
        setFocus({ kind: "unit", key: importedBatch.units[0].key });
        clearPreviews();
      } else if (pendingBatchName) {
        setFocus({ kind: "batch", key: pendingBatchName });
      } else if (!keepSelection || !overview.units.some((u) => u.key === selectedKey)) {
        const first = overview.units[0];
        setSelectedKey(first?.key || null);
        setFocus(first ? { kind: "unit", key: first.key } : null);
        clearPreviews();
      }
    } catch (e) {
      if (requestId !== loadSequence.current) return;
      setError(e instanceof Error ? e.message : "加载失败");
    }
  };

  useEffect(() => {
    Promise.all([api.listTaxonomySchemes(), api.listTaxonomies()])
      .then(([schemeRows, nodeRows]) => {
        setSchemes(schemeRows);
        setNodes(nodeRows);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void load(true);
  }, [mode, tagId, user?.id, variant]);

  const selected = useMemo(
    () => data?.units.find((unit) => unit.key === selectedKey) || null,
    [data, selectedKey]
  );

  const displayData = useMemo(() => {
    if (!data) return null;
    const timestamp = (unit: StorageUnit) =>
      Math.max(
        0,
        ...unit.files.map((file) => Date.parse(file.modified_at) || 0)
      );
    const compareUnits = (a: StorageUnit, b: StorageUnit) => {
      if (sortMode === "name_desc") return b.name.localeCompare(a.name);
      if (sortMode === "modified_desc") return timestamp(b) - timestamp(a);
      if (sortMode === "modified_asc") return timestamp(a) - timestamp(b);
      if (sortMode === "created_desc") return timestamp(b) - timestamp(a);
      if (sortMode === "created_asc") return timestamp(a) - timestamp(b);
      return a.name.localeCompare(b.name);
    };
    const known = new Set(data.batches.map((batch) => batch.name));
    const placeholderBatches = extraBatches
      .filter((name) => !known.has(name))
      .map((name) => ({
        name,
        unit_count: 0,
        file_count: 0,
        units: [],
        meta: {},
        uploaders: [],
        taxonomy_tag_ids: {},
        taxonomy_tags: {},
        annotation: {},
      }));
    const batches = [...data.batches, ...placeholderBatches]
      .map((batch) => ({ ...batch, units: [...batch.units].sort(compareUnits) }))
      .sort((a, b) =>
        sortMode === "name_desc"
          ? b.name.localeCompare(a.name)
          : a.name.localeCompare(b.name)
      );
    return { ...data, batches };
  }, [data, extraBatches, sortMode]);

  const currentNodes = nodes.filter((node) => node.scheme === mode);

  const reloadTaxonomies = async () => {
    setNodes(await api.listTaxonomies());
  };

  const focusedBatch = useMemo(() => {
    if (focus?.kind !== "batch") return null;
    return displayData?.batches.find((item) => item.name === focus.key) || null;
  }, [displayData, focus]);

  const focusedFile = useMemo(() => {
    if (focus?.kind !== "file") return selectedFile;
    return (
      selected?.files.find((item) => item.path === focus.key) ||
      data?.files.find((item) => item.path === focus.key) ||
      selectedFile
    );
  }, [focus, selected, data, selectedFile]);

  if (variant === "manage" && !isAdmin) {
    return <div className="page error">只有管理员可以进入数据管理</div>;
  }
  if (variant === "upload" && !(isAdmin || hasPerm("upload"))) {
    return <div className="page error">没有上传权限</div>;
  }
  if (variant === "annotate" && !hasAnnotationPermission) {
    return <div className="page error">没有标注权限</div>;
  }

  return (
    <div className="page storage-page stack">
      <div className="storage-toolbar card">
        {!structureOnly && (
          <div className="storage-filter-line">
            <span className="muted">分类标准：</span>
            <button
              type="button"
              className={mode === "folder" ? "active" : "secondary"}
              onClick={() => {
                setMode("folder");
                setTagId(null);
              }}
            >
              存储结构
            </button>
            <button
              type="button"
              className={mode === "uploader" ? "active" : "secondary"}
              onClick={() => {
                setMode("uploader");
                setTagId(null);
              }}
            >
              上传用户
            </button>
            {schemes.map((scheme) => (
              <button
                type="button"
                key={scheme.key}
                className={mode === scheme.key ? "active" : "secondary"}
                onClick={() => {
                  setMode(scheme.key);
                  setTagId(null);
                }}
              >
                {taxonomySchemeLabel(scheme.key, schemes)}
              </button>
            ))}
          </div>
        )}
        <div className="storage-filter-line">
          <span className="muted">排序方式：</span>
          {[
            ["created_asc", "创建时间正序"],
            ["created_desc", "创建时间倒序"],
            ["modified_asc", "修改时间正序"],
            ["modified_desc", "修改时间倒序"],
            ["name_asc", "字符顺序 A-Z"],
            ["name_desc", "字符顺序 Z-A"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={sortMode === value ? "active" : "secondary"}
              onClick={() => setSortMode(value)}
            >
              {label}
            </button>
          ))}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(false);
            }}
            placeholder="搜索批次或数据单元"
            style={{ marginLeft: "auto", minWidth: 210 }}
          />
          <button type="button" onClick={() => void load(false)}>搜索</button>
        </div>
        {mode !== "folder" && mode !== "uploader" && (
          <div className="storage-filter-line">
            <span className="muted">{taxonomySchemeLabel(mode, schemes)}：</span>
            <select
              value={tagId ?? ""}
              onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">全部</option>
              {currentNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.path}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <div className="storage-workspace">
        <aside className="card storage-left-pane">
          {variant === "upload" && (
            <>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>存储结构</h3>
              <FolderBatchImport
                onImported={(batchName) => {
                  pendingSelectBatch.current = batchName;
                  setExtraBatches((current) =>
                    current.includes(batchName) ? current : [...current, batchName]
                  );
                  void load(true);
                }}
                onError={setError}
                onMessage={setMessage}
              />
            </>
          )}
          {mode !== "folder" && mode !== "uploader" && (
            <>
              <h3 style={{ marginTop: 0 }}>
                {taxonomySchemeLabel(mode, schemes)}分类树
              </h3>
              <TaxonomyTreePanel
                nodes={currentNodes}
                units={classificationUnits}
                selectedId={tagId}
                selectedKey={selectedKey}
                onSelect={setTagId}
                onUnitSelect={(unit) => {
                  setSelectedKey(unit.key);
                  setFocus({ kind: "unit", key: unit.key });
                  clearPreviews();
                }}
              />
            </>
          )}
          {mode === "uploader" && (
            <>
              <h3 style={{ marginTop: 0 }}>上传用户</h3>
              <UploaderTreePanel
                uploaders={data?.uploaders || []}
                units={data?.units || []}
                selectedId={tagId}
                selectedKey={selectedKey}
                onSelect={setTagId}
                onUnitSelect={(unit) => {
                  setSelectedKey(unit.key);
                  setFocus({ kind: "unit", key: unit.key });
                  clearPreviews();
                }}
              />
            </>
          )}
          {mode === "folder" && (
            <UnitTree
              data={displayData || { updated_at: "", modalities: [], ontologies: [], uploaders: [], batches: [], units: [], files: [] }}
              selectedUnit={focus?.kind === "unit" || focus?.kind === "file" ? selectedKey : null}
              selectedBatch={focus?.kind === "batch" ? focus.key : selected?.batch || null}
              onSelectUnit={(unit) => {
                setSelectedKey(unit.key);
                setFocus({ kind: "unit", key: unit.key });
                clearPreviews();
              }}
              onSelectBatch={(batch) => {
                setFocus({ kind: "batch", key: batch.name });
              }}
            />
          )}
        </aside>

        <main className="card storage-right-pane stack">
          {focus?.kind === "batch" && focusedBatch && (
            <>
              <div>
                <h2 style={{ margin: 0 }}>{focusedBatch.name}</h2>
                <span className="muted">
                  数据批次 · {focusedBatch.unit_count} 个单元 · {focusedBatch.file_count} 个文件 ·{" "}
                  {uploaderLabel(focusedBatch.uploaders)}
                </span>
              </div>
              <div className="storage-preview-empty">
                已选中数据批次。请在右侧查看或设置批次标签，或从左侧选择数据单元。
              </div>
            </>
          )}
          {focus?.kind !== "batch" && !selected && (
            <div className="storage-preview-empty">请选择一个数据批次或数据单元</div>
          )}
          {focus?.kind !== "batch" && selected && (
            <>
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                <div>
                  <h2 style={{ margin: 0 }}>{selected.name}</h2>
                  <span className="muted">
                    {selected.batch} · {selected.file_count} 个文件 ·{" "}
                    {uploaderLabel(selected.uploaders)}
                  </span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {selectedFile && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        downloadAuth(
                          api.storageFileUrl(selectedFile.path, true),
                          selectedFile.name
                        )
                      }
                    >
                      下载当前文件
                    </button>
                  )}
                  {selectedFile && canDelete && (
                    <button
                      type="button"
                      className="danger"
                      onClick={async () => {
                        if (!confirm(`确认删除 ${selectedFile.name}？`)) return;
                        await api.storageDeleteFile(selectedFile.path);
                        removePreviewFile(activePreviewIndex);
                        await load();
                      }}
                    >
                      删除当前文件
                    </button>
                  )}
                </div>
              </div>

              <UnitMatrix
                unit={selected}
                selectedFile={focus?.kind === "file" ? focusedFile : selectedFile}
                onFile={(file) => {
                  setSelectedKey(`${file.batch}::${file.unit_name}`);
                  addPreviewFile(file);
                }}
                canUpload={canUpload}
                onQuickUpload={setQuickPreset}
              />

              <section className="storage-preview-section">
                <h3>预览</h3>
                <div className="storage-preview-grid">
                  {previewFiles.map((file, index) => (
                    <div
                      key={index}
                      className={`storage-preview-box ${
                        activePreviewIndex === index ? "active" : ""
                      }`}
                      onClick={() => {
                        setActivePreviewIndex(index);
                        if (file) setFocus({ kind: "file", key: file.path });
                      }}
                    >
                      {file && (
                        <div className="storage-preview-header">
                          <span title={file.path}>
                            窗口 {index + 1} · {file.name} ·{" "}
                            {file.uploader?.username || "上传者未知"}
                          </span>
                          <button
                            type="button"
                            className="storage-preview-close"
                            title="关闭此预览"
                            onClick={(event) => {
                              event.stopPropagation();
                              removePreviewFile(index);
                            }}
                          >
                            ×
                          </button>
                        </div>
                      )}
                      <div className="storage-preview-content">
                        {file ? (
                          <Preview file={file} />
                        ) : (
                          <div className="storage-preview-empty">
                            窗口 {index + 1}
                            <br />
                            点击上方文件添加预览
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </main>
        <EntityDetailPanel
          kind={focus?.kind || null}
          batch={
            focusedBatch ||
            displayData?.batches.find(
              (item) => item.name === (selected?.batch || focusedFile?.batch)
            ) ||
            null
          }
          unit={selected}
          file={focus?.kind === "file" ? focusedFile : null}
          schemes={schemes}
          nodes={nodes}
          canEdit={canAnnotate}
          canCreate={canCreateTaxonomy}
          onReload={async () => {
            await load(true);
          }}
          onNodesReload={reloadTaxonomies}
          onError={setError}
          onMessage={setMessage}
        />
      </div>

      {selected && quickPreset && (
        <QuickUpload
          unit={selected}
          preset={quickPreset}
          manageOverride={variant === "manage"}
          onClose={() => setQuickPreset(null)}
          onUploaded={() => void load()}
        />
      )}
    </div>
  );
}
