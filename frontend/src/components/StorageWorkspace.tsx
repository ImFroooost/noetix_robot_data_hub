import { Children, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, downloadAuth, downloadAuthPost } from "../api";
import { useAuth } from "../auth";
import { usePreview } from "../preview/PreviewContext";
import { isVisualizableStorageFile, pickPreviewFile } from "../preview/pickPreviewFile";
import { FilePreviewDock } from "./FilePreviewDock";
import { FolderBatchImport, UploadTaxonomyFields } from "./FolderBatchImport";
import {
  DEFAULT_HUMAN_MODEL,
  HumanModelFields,
  humanModelFileLabel,
  humanModelFiles,
  resolveHumanModelName,
} from "./HumanModelFields";
import { MotionKindFields } from "./MotionKindFields";
import {
  RobotStyleFields,
  robotDescriptionVersions,
  robotVersionLabel,
  normalizeRobotVersion,
} from "./RobotStyleFields";
import { TaxonomySelect } from "./TaxonomyTree";
import { fetchStorageOverview, INDEX_UPDATED_EVENT } from "../storageOverviewCache";
import { useUndo } from "../undo/UndoContext";
import { patchStorageMeta, type StorageMetaTarget } from "../undo/storageMeta";
import { formatFromFileName } from "../utils/folderUpload";
import type {
  ModelInstance,
  StorageAnnotation,
  StorageBatch,
  StorageFile,
  StorageFileDetail,
  StorageOverview,
  StorageUploadSession,
  StorageUploader,
  StorageUnit,
  TaxonomyNode,
  TaxonomySchemeDef,
} from "../types";
import {
  isMotionModality,
  isSmplFormat,
  isSmplMotionFile,
  isSuperRole,
  MOTION_KIND_OPTIONS,
  motionKindLabel,
  needsManualCsvFps,
  parseCsvFps,
  resolveMotionKind,
  taxonomySchemeLabel,
  type MotionKind,
} from "../types";

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

const ownedByUser = (
  userId: number | undefined,
  uploaders?: StorageUploader[] | null,
  files?: StorageFile[] | null
) => {
  if (!userId) return false;
  if (uploaders?.some((item) => item.id === userId)) return true;
  return !!files?.some((file) => file.uploader?.id === userId);
};

const unitOwnedBy = (unit: StorageUnit, userId: number | undefined) =>
  ownedByUser(userId, unit.uploaders, unit.files);

const batchOwnedBy = (batch: StorageBatch, userId: number | undefined) =>
  ownedByUser(userId, batch.uploaders) ||
  batch.units.some((unit) => unitOwnedBy(unit, userId));

const qualityLabel = (value: string) =>
  QUALITY_OPTIONS.find(([key]) => key === value)?.[1] || "未评价";

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

function TreeSelectAll({
  total,
  selected,
  disabled,
  onChange,
}: {
  total: number;
  selected: number;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const allOn = total > 0 && selected >= total;
  const someOn = selected > 0 && selected < total;
  return (
    <label className="storage-tree-select-all">
      <input
        type="checkbox"
        className="storage-tree-check"
        disabled={disabled || total === 0}
        checked={allOn}
        ref={(el) => {
          if (el) el.indeterminate = someOn;
        }}
        onChange={(e) => onChange(e.target.checked)}
        aria-label="全选"
      />
      全选
    </label>
  );
}

function DownloadToolbar({
  count,
  total,
  selectedForAll,
  canDownload,
  onDownload,
  onClear,
  onSelectAll,
}: {
  count: number;
  total?: number;
  selectedForAll?: number;
  canDownload?: boolean;
  onDownload?: () => void;
  onClear: () => void;
  onSelectAll?: (checked: boolean) => void;
}) {
  if (!canDownload) return null;
  return (
    <div className="storage-tree-manage">
      {onSelectAll && total != null && (
        <TreeSelectAll
          total={total}
          selected={selectedForAll ?? count}
          onChange={onSelectAll}
        />
      )}
      <span className="muted">已选 {count} 项</span>
      <button
        type="button"
        className="secondary"
        disabled={!count}
        onClick={onDownload}
      >
        下载
      </button>
      <button type="button" className="secondary" disabled={!count} onClick={onClear}>
        取消选择
      </button>
    </div>
  );
}

function uniqueUnits(items: StorageUnit[]) {
  const seen = new Set<string>();
  return items.filter((unit) => {
    if (seen.has(unit.key)) return false;
    seen.add(unit.key);
    return true;
  });
}

function TreeToolbar({
  onCollapseAll,
  onExpandAll,
  extra,
  children,
  toolbarExtra,
}: {
  onCollapseAll: () => void;
  onExpandAll: () => void;
  extra?: ReactNode;
  children?: ReactNode;
  toolbarExtra?: ReactNode;
}) {
  return (
    <>
      <div className="storage-tree-toolbar-wrap">
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
          {toolbarExtra}
        </div>
        {extra}
      </div>
      <div className="storage-tree-scroll">{children}</div>
    </>
  );
}

function TreeActions({
  canDownload,
  canEdit,
  onDownload,
  onRename,
  onDelete,
}: {
  canDownload?: boolean;
  canEdit?: boolean;
  onDownload?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  if (!canDownload && !canEdit) return null;
  return (
    <span className="storage-tree-actions">
      {canDownload && onDownload && (
        <button type="button" className="secondary" onClick={(e) => { e.stopPropagation(); onDownload(); }}>
          下载
        </button>
      )}
      {canEdit && onRename && (
        <button type="button" className="secondary" onClick={(e) => { e.stopPropagation(); onRename(); }}>
          重命名
        </button>
      )}
      {canEdit && onDelete && (
        <button type="button" className="danger" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          删除
        </button>
      )}
    </span>
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
  depth = 0,
  checked,
  onCheck,
  actions,
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
  depth?: number;
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  actions?: ReactNode;
}) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const pinOnCollapse = useRef(false);
  const activate = () => {
    if (open) pinOnCollapse.current = true;
    onToggle();
    onSelect();
  };
  useLayoutEffect(() => {
    if (open || !pinOnCollapse.current) return;
    pinOnCollapse.current = false;
    nodeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open]);
  const body = (
    <>
      <div className={`storage-tree-row ${selected ? "is-selected" : ""} ${checked ? "is-checked" : ""}`}>
        {onCheck && (
          <input
            type="checkbox"
            className="storage-tree-check"
            checked={!!checked}
            onChange={(e) => onCheck(e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`选择 ${title}`}
          />
        )}
        <button
          type="button"
          className="storage-tree-toggle"
          title={title}
          aria-label={toggleLabel}
          aria-expanded={open}
          onClick={activate}
        >
          <ChevronIcon open={open} />
        </button>
        <button type="button" className="storage-tree-item" title={title} onClick={activate}>
          <span className={`storage-tree-icon ${icon === "user" ? "is-user" : "is-folder"}`}>
            {icon === "user" ? <UserIcon /> : <FolderIcon />}
          </span>
          <span className="storage-tree-copy">
            <span className="storage-tree-title">{title}</span>
            <span className="storage-tree-meta">{meta}</span>
          </span>
        </button>
        {actions}
      </div>
      {open && Children.toArray(children).some(Boolean) && (
        <div className="storage-tree-children">{children}</div>
      )}
    </>
  );
  const wrapStyle = { "--tree-depth": depth } as CSSProperties;
  if (nested) {
    return (
      <div ref={nodeRef} className={`storage-tree-nested ${open ? "is-open" : ""}`} style={wrapStyle}>
        {body}
      </div>
    );
  }
  return (
    <div ref={nodeRef} className={`storage-tree-node ${open ? "is-open" : ""}`} style={wrapStyle}>
      {body}
    </div>
  );
}

function TreeUnitItem({
  title,
  meta,
  selected,
  onClick,
  checked,
  onCheck,
  actions,
}: {
  title: string;
  meta: ReactNode;
  selected: boolean;
  onClick: () => void;
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  actions?: ReactNode;
}) {
  return (
    <div className={`storage-tree-unit-line ${selected ? "is-selected" : ""} ${checked ? "is-checked" : ""}`}>
      {onCheck && (
        <input
          type="checkbox"
          className="storage-tree-check"
          checked={!!checked}
          onChange={(e) => onCheck(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`选择 ${title}`}
        />
      )}
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
      {actions}
    </div>
  );
}

function unitSubPath(unit: StorageUnit): string {
  for (const file of unit.files) {
    if (file.sub_path) return file.sub_path;
  }
  return "";
}

type DirTreeNode = {
  name: string;
  path: string;
  units: StorageUnit[];
  children: Map<string, DirTreeNode>;
};

function buildDirTree(units: StorageUnit[]): DirTreeNode {
  const root: DirTreeNode = { name: "", path: "", units: [], children: new Map() };
  for (const unit of units) {
    const subPath = unitSubPath(unit);
    if (!subPath) {
      root.units.push(unit);
      continue;
    }
    const segs = subPath.replace(/\\/g, "/").split("/").filter(Boolean);
    let node = root;
    let acc = "";
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, path: acc, units: [], children: new Map() };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.units.push(unit);
  }
  return root;
}

function dirUnitCount(node: DirTreeNode): number {
  let total = node.units.length;
  for (const child of node.children.values()) total += dirUnitCount(child);
  return total;
}

function unitsUnderPath(units: StorageUnit[], dirPath: string): StorageUnit[] {
  if (!dirPath) return units;
  return units.filter((unit) => {
    const subPath = unitSubPath(unit);
    return subPath === dirPath || subPath.startsWith(`${dirPath}/`);
  });
}

function sharedUnitTag(units: StorageUnit[], scheme: string): { id: number | ""; mixed: boolean } {
  let current: number | null | undefined;
  for (const unit of units) {
    const raw = unit.taxonomy_tag_ids?.[scheme];
    const id = raw == null ? null : raw;
    if (current === undefined) {
      current = id;
      continue;
    }
    if (current !== id) return { id: "", mixed: true };
  }
  return { id: current == null ? "" : current, mixed: false };
}

const VIRTUAL_UNIT_ROW = 46;
const VIRTUAL_UNIT_THRESHOLD = 80;

function VirtualTreeUnits({
  units,
  renderUnit,
}: {
  units: StorageUnit[];
  renderUnit: (unit: StorageUnit) => ReactNode;
}) {
  const spacerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState(() => ({
    start: 0,
    end: Math.min(units.length, 48),
  }));

  useLayoutEffect(() => {
    const spacer = spacerRef.current;
    const scroll = spacer?.closest(".storage-tree-scroll") as HTMLElement | null;
    if (!spacer || !scroll) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const scrollRect = scroll.getBoundingClientRect();
      const spacerRect = spacer.getBoundingClientRect();
      const into = scrollRect.top - spacerRect.top;
      const start = Math.max(0, Math.floor(into / VIRTUAL_UNIT_ROW) - 8);
      const end = Math.min(
        units.length,
        start + Math.ceil(scrollRect.height / VIRTUAL_UNIT_ROW) + 20
      );
      setRange((current) =>
        current.start === start && current.end === end ? current : { start, end }
      );
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(update);
    };
    update();
    scroll.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(onScroll);
    observer.observe(scroll);
    return () => {
      scroll.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [units.length]);

  return (
    <div ref={spacerRef} className="storage-tree-virtual" style={{ height: units.length * VIRTUAL_UNIT_ROW }}>
      {units.slice(range.start, range.end).map((unit, index) => (
        <div
          key={unit.key}
          className="storage-tree-virtual-row"
          style={{ top: (range.start + index) * VIRTUAL_UNIT_ROW }}
        >
          {renderUnit(unit)}
        </div>
      ))}
    </div>
  );
}

function renderDirTree(
  node: DirTreeNode,
  batch: StorageBatch,
  depth: number,
  expanded: Record<string, boolean>,
  setExpanded: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void,
  selectedUnit: string | null,
  selectedNodeKey: string | null,
  onSelectUnit: (unit: StorageUnit) => void,
  onSelectNode: (key: string) => void,
  canManage: boolean,
  canEdit: boolean | undefined,
  canDownload: boolean | undefined,
  currentUserId: number | undefined,
  checkedUnits: Record<string, boolean>,
  setCheckedUnits: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void,
  onRenameUnit: (unit: StorageUnit) => void,
  onDelete: (batches: StorageBatch[], units: StorageUnit[]) => void,
  onDownload: (batches: StorageBatch[], units: StorageUnit[]) => void
): ReactNode {
  const dirEntries = [...node.children.entries()].sort((left, right) =>
    left[0].localeCompare(right[0], "zh")
  );
  return (
    <>
      {dirEntries.map(([, child]) => {
        const nodeKey = `${batch.name}::${child.path}`;
        const open = expanded[nodeKey] === true;
        return (
          <TreeGroup
            key={nodeKey}
            nested={depth > 0}
            depth={depth}
            open={open}
            selected={selectedNodeKey === nodeKey}
            title={child.name}
            meta={<span>{dirUnitCount(child)} 个单元</span>}
            toggleLabel={open ? "收起目录" : "展开目录"}
            onToggle={() =>
              setExpanded((current) => ({
                ...current,
                [nodeKey]: !open,
              }))
            }
            onSelect={() => onSelectNode(nodeKey)}
          >
            {open
              ? renderDirTree(
                  child,
                  batch,
                  depth + 1,
                  expanded,
                  setExpanded,
                  selectedUnit,
                  selectedNodeKey,
                  onSelectUnit,
                  onSelectNode,
                  canManage,
                  canEdit,
                  canDownload,
                  currentUserId,
                  checkedUnits,
                  setCheckedUnits,
                  onRenameUnit,
                  onDelete,
                  onDownload
                )
              : null}
          </TreeGroup>
        );
      })}
      {node.units.length > VIRTUAL_UNIT_THRESHOLD ? (
        <VirtualTreeUnits
          units={node.units}
          renderUnit={(unit) => (
            <TreeUnitItem
              title={unit.name}
              meta={uploaderLabel(unit.uploaders)}
              selected={selectedUnit === unit.key}
              onClick={() => onSelectUnit(unit)}
              checked={!!checkedUnits[unit.key]}
              onCheck={
                canManage
                  ? (value) =>
                      setCheckedUnits((current) => ({ ...current, [unit.key]: value }))
                  : undefined
              }
              actions={
                <TreeActions
                  canDownload={!!canDownload || unitOwnedBy(unit, currentUserId)}
                  canEdit={canEdit}
                  onDownload={() => onDownload([], [unit])}
                  onRename={() => onRenameUnit(unit)}
                  onDelete={() => onDelete([], [unit])}
                />
              }
            />
          )}
        />
      ) : (
        node.units.map((unit) => (
          <TreeUnitItem
            key={unit.key}
            title={unit.name}
            meta={uploaderLabel(unit.uploaders)}
            selected={selectedUnit === unit.key}
            onClick={() => onSelectUnit(unit)}
            checked={!!checkedUnits[unit.key]}
            onCheck={
              canManage
                ? (value) =>
                    setCheckedUnits((current) => ({ ...current, [unit.key]: value }))
                : undefined
            }
            actions={
              <TreeActions
                canDownload={!!canDownload || unitOwnedBy(unit, currentUserId)}
                canEdit={canEdit}
                onDownload={() => onDownload([], [unit])}
                onRename={() => onRenameUnit(unit)}
                onDelete={() => onDelete([], [unit])}
              />
            }
          />
        ))
      )}
    </>
  );
}

function UnitTree({
  data,
  selectedUnit,
  selectedNodeKey,
  onSelectUnit,
  onSelectNode,
  canEdit,
  canDownload,
  currentUserId,
  onRenameBatch,
  onRenameUnit,
  onDelete,
  onDownload,
}: {
  data: StorageOverview;
  selectedUnit: string | null;
  selectedNodeKey: string | null;
  onSelectUnit: (unit: StorageUnit) => void;
  onSelectNode: (key: string) => void;
  canEdit?: boolean;
  canDownload?: boolean;
  currentUserId?: number;
  onRenameBatch: (batch: StorageBatch) => void;
  onRenameUnit: (unit: StorageUnit) => void;
  onDelete: (batches: StorageBatch[], units: StorageUnit[]) => void;
  onDownload: (batches: StorageBatch[], units: StorageUnit[]) => void;
}) {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [checkedBatches, setCheckedBatches] = useState<Record<string, boolean>>({});
  const scopedEmpty =
    !isSuperRole(user?.role) &&
    !(user?.permissions || []).some(
      (item) => item.capability === "browse" || item.capability === "manage_data"
    );
  const [checkedUnits, setCheckedUnits] = useState<Record<string, boolean>>({});
  const batchKeys = data.batches.map((batch) => batch.name);
  const selectedBatches = data.batches.filter((batch) => checkedBatches[batch.name]);
  const selectedUnits = data.batches.flatMap((batch) => batch.units).filter((unit) => checkedUnits[unit.key]);
  const selectedCount = selectedBatches.length + selectedUnits.length;
  const canDownloadAny =
    !!canDownload || data.batches.some((batch) => batchOwnedBy(batch, currentUserId));
  const canManage = !!(canEdit || canDownloadAny);

  const toggleBatch = (name: string, value: boolean) => {
    setCheckedBatches((current) => ({ ...current, [name]: value }));
  };

  return (
    <div className="storage-tree storage-structure-tree">
      <TreeToolbar
        onCollapseAll={() => setExpanded({})}
        onExpandAll={() =>
          setExpanded(Object.fromEntries(batchKeys.map((key) => [key, true])))
        }
        extra={
          canManage ? (
            <div className="storage-tree-manage">
              <TreeSelectAll
                total={data.batches.length}
                selected={selectedBatches.length}
                onChange={(checked) => {
                  if (checked) {
                    setCheckedBatches(
                      Object.fromEntries(data.batches.map((batch) => [batch.name, true]))
                    );
                    return;
                  }
                  setCheckedBatches({});
                  setCheckedUnits({});
                }}
              />
              <span className="muted">已选 {selectedCount} 项</span>
              {canDownloadAny && (
                <button
                  type="button"
                  className="secondary"
                  disabled={!selectedCount}
                  onClick={() => onDownload(selectedBatches, selectedUnits)}
                >
                  下载
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  className="secondary"
                  disabled={selectedCount !== 1}
                  onClick={() => {
                    if (selectedBatches.length === 1) onRenameBatch(selectedBatches[0]);
                    else if (selectedUnits.length === 1) onRenameUnit(selectedUnits[0]);
                  }}
                >
                  重命名
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  className="danger"
                  disabled={!selectedCount}
                  onClick={() => onDelete(selectedBatches, selectedUnits)}
                >
                  删除
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={!selectedCount}
                onClick={() => {
                  setCheckedBatches({});
                  setCheckedUnits({});
                }}
              >
                取消选择
              </button>
            </div>
          ) : null
        }
      >
      {data.batches.map((batch) => {
        const open = expanded[batch.name] === true;
        return (
          <TreeGroup
            key={batch.name}
            open={open}
            selected={selectedNodeKey === `${batch.name}::`}
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
            onSelect={() => onSelectNode(`${batch.name}::`)}
            checked={!!checkedBatches[batch.name]}
            onCheck={canManage ? (value) => toggleBatch(batch.name, value) : undefined}
            actions={
              <TreeActions
                canDownload={!!canDownload || batchOwnedBy(batch, currentUserId)}
                canEdit={canEdit}
                onDownload={() => onDownload([batch], [])}
                onRename={() => onRenameBatch(batch)}
                onDelete={() => onDelete([batch], [])}
              />
            }
          >
            {open ? (
              <>
                {batch.units.length ? (
                  renderDirTree(
                    buildDirTree(batch.units),
                    batch,
                    0,
                    expanded,
                    setExpanded,
                    selectedUnit,
                    selectedNodeKey,
                    onSelectUnit,
                    onSelectNode,
                    canManage,
                    canEdit,
                    canDownload,
                    currentUserId,
                    checkedUnits,
                    setCheckedUnits,
                    onRenameUnit,
                    onDelete,
                    onDownload
                  )
                ) : (
                  <div className="muted storage-tree-empty">暂无数据单元</div>
                )}
              </>
            ) : null}
          </TreeGroup>
        );
      })}
      {!data.batches.length && (
        <div className="muted">
          {scopedEmpty
            ? "当前账号没有配置浏览范围，也没有自己上传的数据，所以列表为空。这和从哪台电脑打开无关。请用超级管理者登录查看全部数据，或在「用户管理」里为该账号配置范围。"
            : "没有匹配的数据批次"}
        </div>
      )}
      </TreeToolbar>
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
  canDownload,
  currentUserId,
  onDownload,
  sortMode = "created_desc",
}: {
  uploaders: StorageUploader[];
  units: StorageUnit[];
  selectedId: number | null;
  selectedKey: string | null;
  onSelect: (id: number | null) => void;
  onUnitSelect: (unit: StorageUnit) => void;
  canDownload?: boolean;
  currentUserId?: number;
  onDownload?: (units: StorageUnit[]) => void;
  sortMode?: string;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [checkedUploaders, setCheckedUploaders] = useState<Record<string, boolean>>({});
  const [checkedUnits, setCheckedUnits] = useState<Record<string, boolean>>({});
  const uploaderKeys = uploaders.map((item) => String(item.id));
  const unitsOf = (uploader: StorageUploader) =>
    units.filter((unit) =>
      unit.files.some((file) =>
        uploader.id === -1 ? !file.uploader : file.uploader?.id === uploader.id
      )
    );
  const selectedUploaders = uploaders.filter((item) => checkedUploaders[String(item.id)]);
  const selectedUnits = units.filter((unit) => checkedUnits[unit.key]);
  const selectedCount = selectedUploaders.length + selectedUnits.length;
  const canDownloadAny =
    !!canDownload || units.some((unit) => unitOwnedBy(unit, currentUserId));

  return (
    <div className="storage-tree storage-structure-tree">
      <TreeToolbar
        onCollapseAll={() => setExpanded({})}
        onExpandAll={() =>
          setExpanded(Object.fromEntries(uploaderKeys.map((key) => [key, true])))
        }
        extra={
          <DownloadToolbar
            count={selectedCount}
            total={uploaders.length}
            selectedForAll={selectedUploaders.length}
            canDownload={canDownloadAny}
            onSelectAll={(checked) => {
              if (checked) {
                setCheckedUploaders(
                  Object.fromEntries(uploaders.map((item) => [String(item.id), true]))
                );
                return;
              }
              setCheckedUploaders({});
              setCheckedUnits({});
            }}
            onDownload={() =>
              onDownload?.(
                uniqueUnits([
                  ...selectedUploaders.flatMap((item) => unitsOf(item)),
                  ...selectedUnits,
                ])
              )
            }
            onClear={() => {
              setCheckedUploaders({});
              setCheckedUnits({});
            }}
          />
        }
      >
      <TreeAllButton selected={selectedId == null} onClick={() => onSelect(null)}>
        全部上传用户
      </TreeAllButton>
      {uploaders.map((uploader) => {
        const uploaderUnits = sortStorageUnits(unitsOf(uploader), sortMode);
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
            checked={!!checkedUploaders[key]}
            onCheck={canDownloadAny ? (value) => setCheckedUploaders((current) => ({ ...current, [key]: value })) : undefined}
            actions={
              <TreeActions
                canDownload={
                  uploaderUnits.length > 0 &&
                  (!!canDownload ||
                    uploaderUnits.some((unit) => unitOwnedBy(unit, currentUserId)))
                }
                onDownload={() => onDownload?.(uploaderUnits)}
              />
            }
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
                    checked={!!checkedUnits[unit.key]}
                    onCheck={canDownloadAny ? (value) => setCheckedUnits((current) => ({ ...current, [unit.key]: value })) : undefined}
                    actions={
                      <TreeActions
                        canDownload={!!canDownload || unitOwnedBy(unit, currentUserId)}
                        onDownload={() => onDownload?.([unit])}
                      />
                    }
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
      </TreeToolbar>
    </div>
  );
}

const UPLOAD_SOURCE_LABEL: Record<string, string> = {
  folder: "文件夹导入",
  file: "单文件上传",
  zip: "Zip 导入",
  legacy: "历史上传",
};

function formatSessionTime(value: string) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sessionUnitPaths(session: StorageUploadSession, unit: StorageUnit): string[] {
  const unitPaths = new Set(unit.files.map((file) => file.path));
  return session.paths.filter((path) => unitPaths.has(path));
}

function UploadSessionTree({
  sessions,
  units,
  selectedSessionId,
  selectedUnitKey,
  canDeleteSession,
  canDownload,
  currentUserId,
  onSelectSession,
  onSelectUnit,
  onDeleteSession,
  onDeleteSessionUnit,
  onDownload,
}: {
  sessions: StorageUploadSession[];
  units: StorageUnit[];
  selectedSessionId: string | null;
  selectedUnitKey: string | null;
  canDeleteSession?: (session: StorageUploadSession) => boolean;
  canDownload?: boolean;
  currentUserId?: number;
  onSelectSession: (session: StorageUploadSession) => void;
  onSelectUnit: (session: StorageUploadSession, unit: StorageUnit) => void;
  onDeleteSession?: (session: StorageUploadSession) => void;
  onDeleteSessionUnit?: (session: StorageUploadSession, unit: StorageUnit) => void;
  onDownload?: (units: StorageUnit[]) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [checkedSessions, setCheckedSessions] = useState<Record<string, boolean>>({});
  const [checkedUnits, setCheckedUnits] = useState<Record<string, boolean>>({});
  const unitsByKey = new Map(units.map((unit) => [unit.key, unit]));
  const unitsByName = new Map<string, StorageUnit[]>();
  units.forEach((unit) => {
    const list = unitsByName.get(`${unit.batch}::${unit.name}`) || [];
    list.push(unit);
    unitsByName.set(`${unit.batch}::${unit.name}`, list);
  });
  const unitsOf = (session: StorageUploadSession) =>
    session.unit_names
      .map(
        (name) =>
          unitsByKey.get(`${session.batch}::${name}`) ||
          unitsByName.get(`${session.batch}::${name}`)?.[0]
      )
      .filter((item): item is StorageUnit => !!item);
  const unitCheckKey = (sessionId: string, unitKey: string) => `${sessionId}:${unitKey}`;
  const selectedSessions = sessions.filter((item) => checkedSessions[item.id]);
  const selectedUnits = sessions.flatMap((session) =>
    unitsOf(session).filter((unit) => checkedUnits[unitCheckKey(session.id, unit.key)])
  );
  const selectedCount = selectedSessions.length + selectedUnits.length;
  const canDownloadAny =
    !!canDownload || units.some((unit) => unitOwnedBy(unit, currentUserId));

  return (
    <div className="storage-tree storage-structure-tree">
      <TreeToolbar
        onCollapseAll={() =>
          setExpanded(Object.fromEntries(sessions.map((item) => [item.id, false])))
        }
        onExpandAll={() =>
          setExpanded(Object.fromEntries(sessions.map((item) => [item.id, true])))
        }
        extra={
          <DownloadToolbar
            count={selectedCount}
            total={sessions.length}
            selectedForAll={selectedSessions.length}
            canDownload={canDownloadAny}
            onSelectAll={(checked) => {
              if (checked) {
                setCheckedSessions(
                  Object.fromEntries(sessions.map((item) => [item.id, true]))
                );
                return;
              }
              setCheckedSessions({});
              setCheckedUnits({});
            }}
            onDownload={() =>
              onDownload?.(
                uniqueUnits([
                  ...selectedSessions.flatMap((item) => unitsOf(item)),
                  ...selectedUnits,
                ])
              )
            }
            onClear={() => {
              setCheckedSessions({});
              setCheckedUnits({});
            }}
          />
        }
      >
      {sessions.map((session) => {
        const sessionUnits = unitsOf(session);
        const open = expanded[session.id] === true;
        const allowDelete = !!canDeleteSession?.(session);
        return (
          <TreeGroup
            key={session.id}
            open={open}
            selected={selectedSessionId === session.id && !selectedUnitKey}
            title={`${formatSessionTime(session.created_at)} · ${
              UPLOAD_SOURCE_LABEL[session.source] || "上传"
            }`}
            meta={
              <>
                <span>{session.file_count} 个文件</span>
                <span>{session.batch || "未分批次"}</span>
              </>
            }
            toggleLabel={open ? "收起上传" : "展开上传"}
            onToggle={() =>
              setExpanded((current) => ({
                ...current,
                [session.id]: !open,
              }))
            }
            onSelect={() => onSelectSession(session)}
            checked={!!checkedSessions[session.id]}
            onCheck={
              canDownloadAny
                ? (value) =>
                    setCheckedSessions((current) => ({
                      ...current,
                      [session.id]: value,
                    }))
                : undefined
            }
            actions={
              <TreeActions
                canDownload={
                  sessionUnits.length > 0 &&
                  (!!canDownload ||
                    sessionUnits.some((unit) => unitOwnedBy(unit, currentUserId)))
                }
                canEdit={allowDelete}
                onDownload={() => onDownload?.(sessionUnits)}
                onDelete={
                  allowDelete && onDeleteSession
                    ? () => onDeleteSession(session)
                    : undefined
                }
              />
            }
          >
            {open ? (
              <>
                {sessionUnits.map((unit) => {
                  const unitPaths = sessionUnitPaths(session, unit);
                  const checkKey = unitCheckKey(session.id, unit.key);
                  return (
                    <TreeUnitItem
                      key={checkKey}
                      title={unit.name}
                      meta={`${unitPaths.length || unit.file_count} 个文件`}
                      selected={
                        selectedSessionId === session.id && selectedUnitKey === unit.key
                      }
                      onClick={() => onSelectUnit(session, unit)}
                      checked={!!checkedUnits[checkKey]}
                      onCheck={
                        canDownloadAny
                          ? (value) =>
                              setCheckedUnits((current) => ({
                                ...current,
                                [checkKey]: value,
                              }))
                          : undefined
                      }
                      actions={
                        <TreeActions
                          canDownload={!!canDownload || unitOwnedBy(unit, currentUserId)}
                          canEdit={allowDelete && !!unitPaths.length}
                          onDownload={() => onDownload?.([unit])}
                          onDelete={
                            allowDelete && onDeleteSessionUnit && unitPaths.length
                              ? () => onDeleteSessionUnit(session, unit)
                              : undefined
                          }
                        />
                      }
                    />
                  );
                })}
                {!sessionUnits.length && (
                  <div className="muted storage-tree-empty">该次上传的文件已不在库中</div>
                )}
              </>
            ) : null}
          </TreeGroup>
        );
      })}
      {!sessions.length && <div className="muted">还没有上传记录</div>}
      </TreeToolbar>
    </div>
  );
}

function TaxonomyTreePanel({
  nodes,
  units,
  selectedId,
  selectedExact,
  selectedKey,
  onSelect,
  onUnitSelect,
  canDownload,
  currentUserId,
  onDownload,
  sortMode = "created_desc",
}: {
  nodes: TaxonomyNode[];
  units: StorageUnit[];
  selectedId: number | null;
  selectedExact?: boolean;
  selectedKey: string | null;
  onSelect: (id: number | null, exact?: boolean) => void;
  onUnitSelect: (unit: StorageUnit) => void;
  canDownload?: boolean;
  currentUserId?: number;
  onDownload?: (units: StorageUnit[]) => void;
  sortMode?: string;
}) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(nodes.map((node) => [node.id, false]))
  );
  const [unspecifiedOpen, setUnspecifiedOpen] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(nodes.map((node) => [node.id, false]))
  );
  const [groupByBatch, setGroupByBatch] = useState(true);
  const [batchExpanded, setBatchExpanded] = useState<Record<string, boolean>>({});
  const [checkedNodes, setCheckedNodes] = useState<Record<number, boolean>>({});
  const [checkedUnspecified, setCheckedUnspecified] = useState<Record<number, boolean>>({});
  const [checkedUnits, setCheckedUnits] = useState<Record<string, boolean>>({});
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
  // 唯一根节点时隐藏它，直接展示其子节点作为顶层
  const rootNodes = children.get(null) || [];
  const topLevelParentId: number | null =
    rootNodes.length === 1 ? rootNodes[0].id : null;
  const unitsUnder = (node: TaxonomyNode) =>
    units.filter((unit) => {
      const taggedId = unit.taxonomy_tag_ids?.[scheme];
      const tagged = nodes.find((item) => item.id === taggedId);
      return !!tagged && tagged.path.startsWith(node.path);
    });
  const unspecifiedUnitsOf = (node: TaxonomyNode) =>
    units.filter((unit) => unit.taxonomy_tag_ids?.[scheme] === node.id);
  const selectedNodes = nodes.filter((node) => checkedNodes[node.id]);
  const selectedUnspecified = nodes.filter((node) => checkedUnspecified[node.id]);
  const selectedUnits = units.filter((unit) => checkedUnits[unit.key]);
  const selectedCount =
    selectedNodes.length + selectedUnspecified.length + selectedUnits.length;
  const canDownloadAny =
    !!canDownload || units.some((unit) => unitOwnedBy(unit, currentUserId));

  const renderUnspecified = (node: TaxonomyNode, depth: number) => {
    const bucket = unspecifiedUnitsOf(node);
    const open = unspecifiedOpen[node.id] === true;
    const batches = groupByBatch
      ? sortBatchNames([...new Set(bucket.map((u) => u.batch))], bucket, sortMode)
      : [];
    return (
      <TreeGroup
        key={`unspecified:${node.id}`}
        nested={depth > 0}
        depth={depth}
        open={open}
        selected={selectedId === node.id && !!selectedExact}
        title="暂未细分"
        meta={<span>{bucket.length} 个单元</span>}
        toggleLabel={open ? "收起未细分" : "展开未细分"}
        onToggle={() =>
          setUnspecifiedOpen((current) => ({ ...current, [node.id]: !open }))
        }
        onSelect={() => onSelect(node.id, true)}
        checked={!!checkedUnspecified[node.id]}
        onCheck={
          canDownloadAny
            ? (value) =>
                setCheckedUnspecified((current) => ({ ...current, [node.id]: value }))
            : undefined
        }
        actions={
          <TreeActions
            canDownload={
              bucket.length > 0 &&
              (!!canDownload || bucket.some((unit) => unitOwnedBy(unit, currentUserId)))
            }
            onDownload={() => onDownload?.(bucket)}
          />
        }
      >
        {groupByBatch && open
          ? batches.map((batchName) => {
              const batchUnits = sortStorageUnits(
                bucket.filter((u) => u.batch === batchName),
                sortMode
              );
              const bKey = `${node.id}::${batchName}`;
              const bOpen = batchExpanded[bKey] === true;
              return (
                <TreeGroup
                  key={bKey}
                  nested
                  depth={depth + 1}
                  open={bOpen}
                  title={batchName}
                  meta={<span>{batchUnits.length} 个单元</span>}
                  toggleLabel={bOpen ? "收起批次" : "展开批次"}
                  onToggle={() =>
                    setBatchExpanded((current) => ({ ...current, [bKey]: !bOpen }))
                  }
                >
                  {batchUnits.map((unit) => (
                    <TreeUnitItem
                      key={unit.key}
                      title={unit.name}
                      meta={unit.batch}
                      selected={selectedKey === unit.key}
                      onClick={() => {
                        onSelect(node.id, true);
                        onUnitSelect(unit);
                      }}
                      checked={!!checkedUnits[unit.key]}
                      onCheck={
                        canDownloadAny
                          ? (value) =>
                              setCheckedUnits((current) => ({
                                ...current,
                                [unit.key]: value,
                              }))
                          : undefined
                      }
                      actions={
                        <TreeActions
                          canDownload={!!canDownload || unitOwnedBy(unit, currentUserId)}
                          onDownload={() => onDownload?.([unit])}
                        />
                      }
                    />
                  ))}
                </TreeGroup>
              );
            })
          : sortStorageUnits(bucket, sortMode).map((unit) => (
          <TreeUnitItem
            key={unit.key}
            title={unit.name}
            meta={unit.batch}
            selected={selectedKey === unit.key}
            onClick={() => {
              onSelect(node.id, true);
              onUnitSelect(unit);
            }}
            checked={!!checkedUnits[unit.key]}
            onCheck={
              canDownloadAny
                ? (value) =>
                    setCheckedUnits((current) => ({
                      ...current,
                      [unit.key]: value,
                    }))
                : undefined
            }
            actions={
              <TreeActions
                canDownload={!!canDownload || unitOwnedBy(unit, currentUserId)}
                onDownload={() => onDownload?.([unit])}
              />
            }
          />
        ))}
        {!bucket.length && <div className="muted storage-tree-empty">暂无数据单元</div>}
      </TreeGroup>
    );
  };

  const renderNodes = (parentId: number | null, depth = 0): ReactNode =>
    (children.get(parentId) || []).map((node) => {
      const nodeUnits = unitsUnder(node);
      const dirOpen = expanded[node.id] === true;
      return (
        <TreeGroup
          key={node.id}
          nested={depth > 0}
          depth={depth}
          open={dirOpen}
          selected={selectedId === node.id && !selectedExact}
          title={node.code ? `${node.code} ${node.name}` : node.name}
          meta={<span>{nodeUnits.length} 个单元</span>}
          toggleLabel={dirOpen ? "收起分类" : "展开分类"}
          onToggle={() =>
            setExpanded((current) => ({ ...current, [node.id]: !dirOpen }))
          }
          onSelect={() => onSelect(node.id, false)}
          checked={!!checkedNodes[node.id]}
          onCheck={
            canDownloadAny
              ? (value) =>
                  setCheckedNodes((current) => ({ ...current, [node.id]: value }))
              : undefined
          }
          actions={
            <TreeActions
              canDownload={
                nodeUnits.length > 0 &&
                (!!canDownload ||
                  nodeUnits.some((unit) => unitOwnedBy(unit, currentUserId)))
              }
              onDownload={() => onDownload?.(nodeUnits)}
            />
          }
        >
          {dirOpen && renderNodes(node.id, depth + 1)}
          {dirOpen && renderUnspecified(node, depth + 1)}
        </TreeGroup>
      );
    });

  return (
    <div className="storage-tree storage-structure-tree">
      <TreeToolbar
        onCollapseAll={() => {
          setExpanded(Object.fromEntries(nodes.map((node) => [node.id, false])));
          setUnspecifiedOpen(Object.fromEntries(nodes.map((node) => [node.id, false])));
        }}
        onExpandAll={() => {
          setExpanded(Object.fromEntries(nodes.map((node) => [node.id, true])));
          setUnspecifiedOpen(Object.fromEntries(nodes.map((node) => [node.id, true])));
        }}
        toolbarExtra={
          <button
            type="button"
            className={groupByBatch ? "active" : "secondary"}
            title="按数据批次折叠数据单元"
            onClick={() => setGroupByBatch((v) => !v)}
          >
            按批次归纳
          </button>
        }
        extra={
          <DownloadToolbar
            count={selectedCount}
            total={nodes.length}
            selectedForAll={selectedNodes.length}
            canDownload={canDownloadAny}
            onSelectAll={(checked) => {
              if (checked) {
                setCheckedNodes(Object.fromEntries(nodes.map((node) => [node.id, true])));
                return;
              }
              setCheckedNodes({});
              setCheckedUnspecified({});
              setCheckedUnits({});
            }}
            onDownload={() =>
              onDownload?.(
                uniqueUnits([
                  ...selectedNodes.flatMap((node) => unitsUnder(node)),
                  ...selectedUnspecified.flatMap((node) => unspecifiedUnitsOf(node)),
                  ...selectedUnits,
                ])
              )
            }
            onClear={() => {
              setCheckedNodes({});
              setCheckedUnspecified({});
              setCheckedUnits({});
            }}
          />
        }
      >
      <TreeAllButton selected={selectedId == null} onClick={() => onSelect(null)}>
        全部分类节点
      </TreeAllButton>
      {renderNodes(topLevelParentId)}
      {!nodes.length && <div className="muted">该分类标准暂无节点</div>}
      </TreeToolbar>
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
  preset?: { ontology: string; modality: string; motionKind?: MotionKind };
  manageOverride: boolean;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [ontology, setOntology] = useState(preset?.ontology || "human");
  const [modality, setModality] = useState(preset?.modality || "motion");
  const [channel, setChannel] = useState("rgb");
  const [format, setFormat] = useState("");
  const [robotStyle, setRobotStyle] = useState("");
  const [robotVersion, setRobotVersion] = useState("");
  const [humanModel, setHumanModel] = useState(DEFAULT_HUMAN_MODEL);
  const [humanModelFile, setHumanModelFile] = useState("");
  const [personName, setPersonName] = useState("");
  const [gender, setGender] = useState("");
  const [height, setHeight] = useState("");
  const [fps, setFps] = useState("30");
  const { execute } = useUndo();
  const [motionKind, setMotionKind] = useState<MotionKind>(
    resolveMotionKind(preset?.motionKind)
  );
  const [robotInstances, setRobotInstances] = useState<ModelInstance[]>([]);
  const [humanInstances, setHumanInstances] = useState<ModelInstance[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (ontology !== "robot" && ontology !== "human") return;
    let cancelled = false;
    api
      .storageModels()
      .then((data) => {
        if (cancelled) return;
        setRobotInstances(data.instances.filter((item) => item.ontology === "robot"));
        setHumanInstances(data.instances.filter((item) => item.ontology === "human"));
      })
      .catch((e) => {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : ontology === "robot"
                ? "机器人款式加载失败"
                : "人体模型加载失败"
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ontology]);

  const submit = async () => {
    if (!file) {
      setError("请选择文件");
      return;
    }
    const resolvedFormat = format.trim() || formatFromFileName(file.name);
    if (!resolvedFormat) {
      setError("无法从文件名判断格式，请填写格式");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("ontology", ontology);
      form.set("modality", modality);
      form.set("channel", modality === "fpv_video" ? channel : "");
      form.set("format", resolvedFormat);
      form.set("batch", unit.batch);
      form.set("unit_name", unit.name);
      form.set("replace", String(replace));
      form.set("manage_override", String(manageOverride));
      form.set(
        "annotation",
        JSON.stringify({
          ...(ontology === "robot"
            ? { robot_style: robotStyle, robot_version: robotVersion }
            : {
                person_name: personName.trim(),
                gender,
                height: height.trim(),
                ...(isSmplFormat(resolvedFormat, file.name)
                  ? {
                      human_model: resolveHumanModelName(humanModel),
                      human_model_file: humanModelFile,
                    }
                  : {}),
              }),
          ...(needsManualCsvFps(ontology, resolvedFormat) ? { fps: parseCsvFps(fps) } : {}),
          ...(isMotionModality(modality)
            ? { motion_kind: resolveMotionKind(motionKind) }
            : {}),
        })
      );
      form.set("file", file);
      let uploadedPath = "";
      await execute({
        label: `上传 ${file.name}`,
        do: async () => {
          const uploaded = await api.storageUpload(form);
          uploadedPath = uploaded.path;
          onUploaded();
        },
        undo: async () => {
          if (uploadedPath) await api.storageDeleteFile(uploadedPath);
        },
      });
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
          <input
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            placeholder="选文件后自动用后缀，也可改"
          />
        </label>
        {isMotionModality(modality) && (
          <MotionKindFields value={motionKind} onChange={setMotionKind} />
        )}
        {needsManualCsvFps(ontology, format) && (
          <label>
            帧率（Hz，机器人 CSV）
            <input
              type="number"
              min="1"
              max="10000"
              step="0.1"
              value={fps}
              placeholder="默认 30"
              onChange={(e) => setFps(e.target.value)}
            />
          </label>
        )}
        {ontology === "robot" && (
          <RobotStyleFields
            instances={robotInstances}
            style={robotStyle}
            version={robotVersion}
            onChange={(nextStyle, nextVersion) => {
              setRobotStyle(nextStyle);
              setRobotVersion(nextVersion);
            }}
          />
        )}
        {ontology === "human" && isSmplFormat(format, file?.name) && (
          <HumanModelFields
            instances={humanInstances}
            model={humanModel}
            modelFile={humanModelFile}
            onChange={(nextModel, nextFile) => {
              setHumanModel(nextModel);
              setHumanModelFile(nextFile);
            }}
          />
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
            onChange={(e) => {
              const next = e.target.files?.[0] || null;
              setFile(next);
              if (next) {
                const detected = formatFromFileName(next.name);
                if (detected) setFormat(detected);
              }
            }}
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

type DetailKind = "batch" | "unit" | "file" | "upload_session" | "node";

type StorageNodeFocus = {
  batchName: string;
  dirPath: string;
  units: StorageUnit[];
};

function schemesForKind(_kind: DetailKind, schemes: TaxonomySchemeDef[]) {
  return schemes;
}

function EntityDetailPanel({
  kind,
  batch,
  unit,
  file,
  session,
  nodeInfo,
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
  session: StorageUploadSession | null;
  nodeInfo: StorageNodeFocus | null;
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
  const [robotVersion, setRobotVersion] = useState("");
  const [humanModel, setHumanModel] = useState(DEFAULT_HUMAN_MODEL);
  const [humanModelFile, setHumanModelFile] = useState("");
  const [personName, setPersonName] = useState("");
  const [gender, setGender] = useState("");
  const [height, setHeight] = useState("");
  const [fps, setFps] = useState("30");
  const [motionKind, setMotionKind] = useState<MotionKind>("skeleton");
  const [robotInstances, setRobotInstances] = useState<ModelInstance[]>([]);
  const [humanInstances, setHumanInstances] = useState<ModelInstance[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const { execute } = useUndo();

  const metaTarget = (): StorageMetaTarget | null => {
    if (kind === "batch" && batch) return { kind: "batch", name: batch.name };
    if (kind === "unit" && unit) return { kind: "unit", batch: unit.batch, name: unit.name };
    if (kind === "file" && file) return { kind: "file", path: file.path };
    if (kind === "upload_session" && session) {
      return { kind: "upload_session", id: session.id, paths: session.paths };
    }
    return null;
  };

  const nodeShare: Record<string, { id: number | ""; mixed: boolean }> = {};
  if (kind === "node" && nodeInfo) {
    for (const scheme of schemes) {
      nodeShare[scheme.key] = sharedUnitTag(nodeInfo.units, scheme.key);
    }
  }
  const ownTagIds =
    kind === "node"
      ? Object.fromEntries(
          Object.entries(nodeShare)
            .filter(([, value]) => value.id !== "")
            .map(([key, value]) => [key, value.id])
        )
      : kind === "file"
        ? detail?.taxonomy_tag_ids || file?.taxonomy_tag_ids || {}
        : kind === "unit"
          ? unit?.taxonomy_tag_ids || {}
          : kind === "upload_session"
            ? session?.taxonomy_tag_ids || {}
            : batch?.taxonomy_tag_ids || {};

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
    kind === "node"
      ? {}
      : kind === "file"
        ? detail?.annotation || file?.annotation || {}
        : kind === "unit"
          ? unit?.annotation || {}
          : kind === "upload_session"
            ? session?.annotation || {}
            : batch?.annotation || {};
  const tagIds =
    kind === "node"
      ? ownTagIds
      : kind === "file"
      ? {
          ...(detail?.batch_taxonomy_tag_ids || batch?.taxonomy_tag_ids || {}),
          ...(detail?.unit_taxonomy_tag_ids || unit?.taxonomy_tag_ids || {}),
          ...(detail?.taxonomy_tag_ids || file?.taxonomy_tag_ids || {}),
        }
      : kind === "unit"
        ? {
            ...(batch?.taxonomy_tag_ids || {}),
            ...(unit?.taxonomy_tag_ids || {}),
          }
        : kind === "upload_session"
          ? session?.taxonomy_tag_ids || {}
          : batch?.taxonomy_tag_ids || {};
  const tags =
    kind === "node"
      ? {}
      : kind === "file"
      ? {
          ...(detail?.batch_taxonomy_tags || batch?.taxonomy_tags || {}),
          ...(detail?.unit_taxonomy_tags || unit?.taxonomy_tags || {}),
          ...(detail?.taxonomy_tags || file?.taxonomy_tags || {}),
        }
      : kind === "unit"
        ? {
            ...(batch?.taxonomy_tags || {}),
            ...(unit?.taxonomy_tags || {}),
          }
        : kind === "upload_session"
          ? session?.taxonomy_tags || {}
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
    setRobotVersion(String(annotation.robot_version || ""));
    setHumanModel(resolveHumanModelName(annotation.human_model));
    setHumanModelFile(String(annotation.human_model_file || ""));
    setPersonName(String(annotation.person_name || ""));
    setGender(String(annotation.gender || ""));
    setHeight(String(annotation.height || ""));
    setFps(String(parseCsvFps(annotation.fps)));
    setMotionKind(resolveMotionKind(annotation.motion_kind));
    setSaved(false);
  }, [
    kind,
    batch?.name,
    unit?.key,
    file?.path,
    nodeInfo?.batchName,
    nodeInfo?.dirPath,
    session?.id,
    annotation.note,
    annotation.quality,
    annotation.robot_style,
    annotation.robot_version,
    annotation.human_model,
    annotation.human_model_file,
    annotation.person_name,
    annotation.gender,
    annotation.height,
    annotation.fps,
    annotation.motion_kind,
  ]);

  useEffect(() => {
    const needRobot =
      (kind === "file" && (file?.ontology === "robot" || detail?.ontology === "robot")) ||
      (kind === "upload_session" && session?.ontology === "robot");
    const needHuman =
      (kind === "file" && isSmplMotionFile(detail || file)) ||
      (kind === "upload_session" &&
        isSmplMotionFile({
          ontology: session?.ontology,
          modality: session?.modality,
          format: session?.format,
        }));
    if ((kind !== "file" && kind !== "upload_session") || (!needRobot && !needHuman)) {
      return;
    }
    let cancelled = false;
    api
      .storageModels()
      .then((data) => {
        if (cancelled) return;
        if (needRobot) {
          setRobotInstances(data.instances.filter((item) => item.ontology === "robot"));
        }
        if (needHuman) {
          setHumanInstances(data.instances.filter((item) => item.ontology === "human"));
        }
      })
      .catch((e) => {
        if (!cancelled) {
          onError(
            e instanceof Error
              ? e.message
              : needRobot
                ? "机器人款式加载失败"
                : "人体模型加载失败"
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    kind,
    file?.ontology,
    file?.modality,
    file?.format,
    file?.name,
    detail?.ontology,
    detail?.modality,
    detail?.format,
    detail?.name,
    session?.ontology,
    session?.modality,
    session?.format,
  ]);

  const paramOntology =
    kind === "upload_session" ? session?.ontology : viewFile?.ontology;
  const detailNeedsFps = needsManualCsvFps(
    paramOntology,
    kind === "upload_session" ? session?.format : viewFile?.format
  );

  const title =
    kind === "batch"
      ? "批次详情"
      : kind === "node"
        ? "数据节点详情"
        : kind === "unit"
          ? "数据单元详情"
          : kind === "file"
            ? "文件详情"
            : kind === "upload_session"
              ? "上传记录"
              : "详情";

  const saveAnnotation = async () => {
    if (!kind) return;
    setSaving(true);
    try {
      const csvFps = needsManualCsvFps(paramOntology, viewFile?.format || session?.format)
        ? { fps: parseCsvFps(fps) }
        : {};
      const smplAnnotation = isSmplMotionFile(
        kind === "upload_session"
          ? { ontology: session?.ontology, modality: session?.modality, format: session?.format }
          : viewFile
      )
        ? { human_model: resolveHumanModelName(humanModel), human_model_file: humanModelFile }
        : {};
      const motionAnnotation = isMotionModality(
        kind === "upload_session" ? session?.modality : viewFile?.modality
      )
        ? { motion_kind: resolveMotionKind(motionKind) }
        : {};
      const fileAnnotation =
        viewFile?.ontology === "robot" || session?.ontology === "robot"
          ? {
              quality,
              note,
              robot_style: robotStyle,
              robot_version: robotVersion,
              ...motionAnnotation,
              ...csvFps,
            }
          : viewFile?.ontology === "human" || session?.ontology === "human"
            ? {
                quality,
                note,
                person_name: personName.trim(),
                gender,
                height: height.trim(),
                ...smplAnnotation,
                ...motionAnnotation,
                ...csvFps,
              }
            : { quality, note, ...motionAnnotation, ...csvFps };
      const body = {
        annotation:
          kind === "file" || kind === "upload_session" ? fileAnnotation : { note },
      };
      const target = metaTarget();
      if (!target) return;
      const prevBody = { annotation: { ...annotation } };
      await execute({
        label: kind === "upload_session" ? "保存上传参数" : "保存标注",
        do: async () => {
          await patchStorageMeta(target, body);
          if (kind === "file" && file) {
            const row = await api.storageFileDetail(file.path);
            setDetail(row);
          }
          setSaved(true);
          onMessage(
            kind === "upload_session"
              ? "本次上传参数已保存，已同步到该次上传的文件"
              : "标签已保存"
          );
          await onReload();
        },
        undo: async () => {
          await patchStorageMeta(target, prevBody);
        },
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const saveTaxonomy = async (scheme: string, raw: number | "") => {
    try {
      if (kind === "node" && nodeInfo) {
        const nextId = raw === "" ? null : raw;
        const shared = nodeShare[scheme];
        const currentId = shared?.mixed || shared?.id === "" ? null : shared?.id ?? null;
        if (!shared?.mixed && currentId === nextId) return;
        const schemeName = taxonomySchemeLabel(scheme, schemes);
        const previous = nodeInfo.units.map((item) => ({
          name: item.name,
          taxonomy_tag_ids: {
            [scheme]: item.taxonomy_tag_ids?.[scheme] ?? null,
          },
        }));
        await execute({
          label: `更新${schemeName}分类`,
          do: async () => {
            await api.storageUpdateNodeTaxonomy({
              batch: nodeInfo.batchName,
              units: nodeInfo.units.map((item) => ({
                name: item.name,
                taxonomy_tag_ids: { [scheme]: nextId },
              })),
            });
            onMessage(
              `已批量修改 ${nodeInfo.units.length} 个单元的${schemeName}`
            );
            await onReload();
          },
          undo: async () => {
            await api.storageUpdateNodeTaxonomy({
              batch: nodeInfo.batchName,
              units: previous,
            });
          },
        });
        return;
      }
      const target = metaTarget();
      if (!target) return;
      const nextId = raw === "" ? null : raw;
      const prevId = ownTagIds[scheme] ?? null;
      if (nextId === prevId) return;
      const schemeName = taxonomySchemeLabel(scheme, schemes);
      await execute({
        label: `更新${schemeName}分类`,
        do: async () => {
          await patchStorageMeta(target, { taxonomy_tag_ids: { [scheme]: nextId } });
          onMessage(
            kind === "batch"
              ? "分类标签已更新，已同步到该批次下的数据单元和文件"
              : kind === "unit"
                ? "分类标签已更新，已同步到该数据单元下的文件"
                : kind === "upload_session"
                  ? "分类标签已更新，已同步到这次上传的数据单元和文件"
                  : "分类标签已更新"
          );
          await onReload();
        },
        undo: async () => {
          await patchStorageMeta(target, { taxonomy_tag_ids: { [scheme]: prevId } });
        },
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "更新失败");
    }
  };

  return (
    <aside className="card storage-detail-pane">
      <h3>{title}</h3>
      {!kind && (
        <div className="storage-preview-empty">
          点击左侧批次、数据单元、上传记录或具体文件查看标签
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
      {kind === "node" && nodeInfo && (
        <dl className="storage-detail-list">
          <DetailRow label="数据批次" value={nodeInfo.batchName} />
          <DetailRow label="节点路径" value={nodeInfo.dirPath || "整个批次"} />
          <DetailRow label="包含单元" value={String(nodeInfo.units.length)} />
          <DetailRow
            label="包含文件"
            value={String(nodeInfo.units.reduce((sum, item) => sum + item.file_count, 0))}
          />
        </dl>
      )}
      {kind === "upload_session" && session && (
        <dl className="storage-detail-list">
          <DetailRow label="上传时间" value={formatSessionTime(session.created_at)} />
          <DetailRow
            label="上传方式"
            value={UPLOAD_SOURCE_LABEL[session.source] || session.source}
          />
          <DetailRow label="数据批次" value={session.batch || "—"} />
          <DetailRow label="文件数" value={String(session.file_count)} />
          <DetailRow
            label="本体"
            value={ONTOLOGY_LABEL[session.ontology] || session.ontology || "—"}
          />
          <DetailRow
            label="模态"
            value={MODALITY_LABEL[session.modality] || session.modality || "—"}
          />
          <DetailRow label="格式" value={session.format || "—"} />
          <DetailRow label="上传者" value={session.username || "—"} />
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
          {kind === "node" && nodeInfo && canEdit && (
            <p className="muted">
              修改后应用到该节点下所有 {nodeInfo.units.length} 个数据单元
            </p>
          )}
          {visibleSchemes.map((scheme) => {
            if (kind === "node") {
              const share = nodeShare[scheme.key];
              const found = share?.id
                ? nodes.find((item) => item.id === share.id)
                : null;
              if (!canEdit) {
                return (
                  <DetailRow
                    key={scheme.key}
                    label={taxonomySchemeLabel(scheme.key, schemes)}
                    value={share?.mixed ? "多个取值" : found?.path || "未分类"}
                  />
                );
              }
              return (
                <label key={scheme.key}>
                  {taxonomySchemeLabel(scheme.key, schemes)}
                  <TaxonomySelect
                    scheme={scheme.key}
                    nodes={nodes.filter((item) => item.scheme === scheme.key)}
                    value={share?.id ?? ""}
                    canCreate={canCreate}
                    onNodesReload={onNodesReload}
                    onChange={(id) => void saveTaxonomy(scheme.key, id)}
                  />
                  {share?.mixed ? (
                    <small className="muted">节点内取值不一致，选择后将统一设置</small>
                  ) : null}
                </label>
              );
            }
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
          {(kind === "file" || kind === "upload_session") &&
            isMotionModality(
              kind === "upload_session" ? session?.modality : viewFile?.modality
            ) &&
            canEdit && (
            <MotionKindFields
              value={motionKind}
              onChange={(next) => {
                setMotionKind(next);
                setSaved(false);
              }}
            />
          )}
          {(kind === "file" || kind === "upload_session") &&
            isMotionModality(
              kind === "upload_session" ? session?.modality : viewFile?.modality
            ) &&
            !canEdit && (
            <DetailRow label="运动类型" value={motionKindLabel(motionKind)} />
          )}
          {(kind === "file" || kind === "upload_session") &&
            paramOntology === "robot" &&
            canEdit && (
            <RobotStyleFields
              instances={robotInstances}
              style={robotStyle}
              version={robotVersion}
              extraStyle={robotStyle}
              onChange={(nextStyle, nextVersion) => {
                setRobotStyle(nextStyle);
                setRobotVersion(nextVersion);
                setSaved(false);
              }}
            />
          )}
          {(kind === "file" || kind === "upload_session") &&
            paramOntology === "robot" &&
            !canEdit && (
            <>
              <DetailRow label="机器人款式" value={robotStyle || "未选择"} />
              {(() => {
                const inst = robotInstances.find((item) => item.name === robotStyle);
                const vers = robotDescriptionVersions(inst);
                const defFile = String(inst?.meta?.default_description_file || "");
                const resolved = normalizeRobotVersion(vers, robotVersion, defFile);
                return vers.length > 1 || resolved ? (
                  <DetailRow
                    label="机器人版本"
                    value={robotVersionLabel(vers, resolved)}
                  />
                ) : null;
              })()}
            </>
          )}
          {(kind === "file" || kind === "upload_session") &&
            isSmplMotionFile(
              kind === "upload_session"
                ? { ontology: session?.ontology, modality: session?.modality, format: session?.format }
                : viewFile
            ) &&
            canEdit && (
            <HumanModelFields
              instances={humanInstances}
              model={humanModel}
              modelFile={humanModelFile}
              extraModel={humanModel}
              onChange={(nextModel, nextFile) => {
                setHumanModel(nextModel);
                setHumanModelFile(nextFile);
                setSaved(false);
              }}
            />
          )}
          {(kind === "file" || kind === "upload_session") &&
            isSmplMotionFile(
              kind === "upload_session"
                ? { ontology: session?.ontology, modality: session?.modality, format: session?.format }
                : viewFile
            ) &&
            !canEdit && (
            <>
              <DetailRow label="人体模型" value={resolveHumanModelName(humanModel)} />
              {humanModelFiles(
                humanInstances.find((item) => item.name === humanModel)
              ).length > 1 || humanModelFile ? (
                <DetailRow
                  label="人体模型文件"
                  value={humanModelFileLabel(
                    humanModelFiles(humanInstances.find((item) => item.name === humanModel)),
                    humanModelFile
                  )}
                />
              ) : null}
            </>
          )}
          {(kind === "file" || kind === "upload_session") &&
            paramOntology === "human" &&
            canEdit && (
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
          {(kind === "file" || kind === "upload_session") &&
            paramOntology === "human" &&
            !canEdit && (
            <>
              <DetailRow label="姓名" value={personName.trim() || "未填写"} />
              <DetailRow label="性别" value={genderLabel(gender)} />
              <DetailRow label="身高" value={heightLabel(height)} />
            </>
          )}
          {detailNeedsFps && canEdit && (
            <label>
              帧率（Hz，机器人 CSV）
              <input
                type="number"
                min="1"
                max="10000"
                step="0.1"
                value={fps}
                placeholder="默认 30"
                onChange={(e) => {
                  setFps(e.target.value);
                  setSaved(false);
                }}
              />
            </label>
          )}
          {detailNeedsFps && !canEdit && kind === "upload_session" && (
            <DetailRow label="帧率" value={`${parseCsvFps(annotation.fps)} Hz`} />
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
          {kind !== "node" && canEdit ? (
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
          ) : kind !== "node" ? (
            <DetailRow
              label="备注"
              value={String(annotation.note || "").trim() || "暂无备注"}
            />
          ) : null}
        </section>
      )}
      {kind === "file" && loading && <div className="muted">正在读取文件元数据…</div>}
    </aside>
  );
}

const ONTOLOGIES = ["human", "robot"] as const;

function downloadKindKey(ontology: string, modality: string, format = "") {
  return `${ontology}:${modality}:${format}`;
}

function fileFormatOf(file: StorageFile) {
  return (file.format || formatFromFileName(file.name) || "unknown").toLowerCase();
}

function filesFromDownloadTargets(batches: StorageBatch[], units: StorageUnit[]) {
  const covered = new Set(batches.map((item) => item.name));
  const leftover = units.filter((unit) => !covered.has(unit.batch));
  const unitByPath = new Map<string, StorageUnit>();
  const files: StorageFile[] = [];
  const seen = new Set<string>();
  const addUnit = (unit: StorageUnit) => {
    for (const file of unit.files) {
      unitByPath.set(file.path, unit);
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      files.push(file);
    }
  };
  for (const batch of batches) {
    for (const unit of batch.units) addUnit(unit);
  }
  for (const unit of leftover) addUnit(unit);
  return { leftover, files, unitByPath };
}

function fileRobotStyle(file: StorageFile, unit?: StorageUnit | null) {
  return String(file.robot_style || file.annotation?.robot_style || unit?.annotation?.robot_style || "").trim();
}

type DownloadConfirm = {
  kinds: { ontology: string; modality: string; format: string }[];
  robotStyles?: string[];
};

function DownloadPicker({
  batches,
  units,
  busy,
  onClose,
  onConfirm,
}: {
  batches: StorageBatch[];
  units: StorageUnit[];
  busy: boolean;
  onClose: () => void;
  onConfirm: (payload: DownloadConfirm) => void;
}) {
  const { leftover, files, unitByPath } = filesFromDownloadTargets(batches, units);
  const available = new Set(
    files.map((file) => downloadKindKey(file.ontology, file.modality, fileFormatOf(file)))
  );
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries([...available].map((key) => [key, true]))
  );
  const robotFiles = files.filter((file) => file.ontology === "robot");
  const robotStyleKeys = [
    ...new Set(robotFiles.map((file) => fileRobotStyle(file, unitByPath.get(file.path)))),
  ].sort((left, right) => {
    if (!left) return 1;
    if (!right) return -1;
    return left.localeCompare(right, "zh");
  });
  const showRobotStyles = robotStyleKeys.some(Boolean);
  const [checkedStyles, setCheckedStyles] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(robotStyleKeys.map((style) => [style, true]))
  );
  const selectedStyles = showRobotStyles
    ? robotStyleKeys.filter((style) => checkedStyles[style])
    : undefined;
  const fileIncluded = (file: StorageFile) => {
    if (!checked[downloadKindKey(file.ontology, file.modality, fileFormatOf(file))]) {
      return false;
    }
    if (!showRobotStyles || file.ontology !== "robot") return true;
    return !!checkedStyles[fileRobotStyle(file, unitByPath.get(file.path))];
  };
  const selectedKinds = files
    .filter(fileIncluded)
    .map((file) => ({
      ontology: file.ontology,
      modality: file.modality,
      format: fileFormatOf(file),
    }))
    .filter((kind, index, list) => {
      const key = downloadKindKey(kind.ontology, kind.modality, kind.format);
      return list.findIndex((item) => downloadKindKey(item.ontology, item.modality, item.format) === key) === index;
    });
  const selectedCount = files.filter(fileIncluded).length;
  const title =
    batches.length === 1 && !leftover.length
      ? batches[0].name
      : leftover.length === 1 && !batches.length
        ? `${leftover[0].batch} / ${leftover[0].name}`
        : `${batches.length} 个批次、${leftover.length} 个单元`;

  return (
    <div className="storage-modal-backdrop" onClick={onClose}>
      <div
        className="storage-modal card stack storage-download-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0 }}>选择下载内容</h3>
        <p className="muted" style={{ margin: 0 }}>
          {title} · 共 {files.length} 个文件，已选 {selectedCount} 个
          {showRobotStyles ? "。机器人数据可按款式再筛选" : ""}
        </p>
        <div className="storage-unit-matrix">
          {ONTOLOGIES.map((ontology) => (
            <section key={ontology} className="storage-ontology-card">
              <h3>{ontology === "human" ? "人体数据" : "机器人数据"}</h3>
              {Object.entries(MODALITY_LABEL).map(([modality, label]) => {
                const rowFiles = files.filter(
                  (file) => file.ontology === ontology && file.modality === modality
                );
                const formats = [...new Set(rowFiles.map((file) => fileFormatOf(file)))].sort();
                const formatKeys = formats.map((format) =>
                  downloadKindKey(ontology, modality, format)
                );
                const enabled = rowFiles.length > 0;
                const selectedFormats = formatKeys.filter((key) => checked[key]);
                const allOn = enabled && selectedFormats.length === formatKeys.length;
                const someOn = selectedFormats.length > 0;
                return (
                  <div
                    key={modality}
                    className={`storage-download-row ${enabled ? "" : "is-empty"}`}
                  >
                    <input
                      type="checkbox"
                      disabled={!enabled || busy}
                      checked={allOn}
                      ref={(el) => {
                        if (el) el.indeterminate = someOn && !allOn;
                      }}
                      onChange={(e) =>
                        setChecked((current) => ({
                          ...current,
                          ...Object.fromEntries(formatKeys.map((key) => [key, e.target.checked])),
                        }))
                      }
                    />
                    <span className={`storage-modality-name ${enabled ? "" : "missing"}`}>
                      {label}
                    </span>
                    <span className="storage-download-formats">
                      {enabled ? (
                        formats.map((format) => {
                          const key = downloadKindKey(ontology, modality, format);
                          const count = rowFiles.filter((file) => {
                            if (fileFormatOf(file) !== format) return false;
                            if (!showRobotStyles || file.ontology !== "robot") return true;
                            return !!checkedStyles[fileRobotStyle(file, unitByPath.get(file.path))];
                          }).length;
                          return (
                            <label key={format} className="storage-download-format">
                              <input
                                type="checkbox"
                                disabled={busy}
                                checked={!!checked[key]}
                                onChange={(e) =>
                                  setChecked((current) => ({
                                    ...current,
                                    [key]: e.target.checked,
                                  }))
                                }
                              />
                              {format}
                              <span className="muted">{count}</span>
                            </label>
                          );
                        })
                      ) : (
                        <span className="muted">缺省</span>
                      )}
                    </span>
                  </div>
                );
              })}
              {ontology === "robot" && showRobotStyles && (
                <div className="storage-download-row">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={
                      robotStyleKeys.length > 0 &&
                      robotStyleKeys.every((style) => checkedStyles[style])
                    }
                    ref={(el) => {
                      if (!el) return;
                      const selected = robotStyleKeys.filter((style) => checkedStyles[style]);
                      el.indeterminate =
                        selected.length > 0 && selected.length < robotStyleKeys.length;
                    }}
                    onChange={(e) =>
                      setCheckedStyles(
                        Object.fromEntries(
                          robotStyleKeys.map((style) => [style, e.target.checked])
                        )
                      )
                    }
                  />
                  <span className="storage-modality-name">机器人款式</span>
                  <span className="storage-download-formats">
                    {robotStyleKeys.map((style) => {
                      const count = robotFiles.filter(
                        (file) => fileRobotStyle(file, unitByPath.get(file.path)) === style
                      ).length;
                      return (
                        <label key={style || "__none__"} className="storage-download-format">
                          <input
                            type="checkbox"
                            disabled={busy}
                            checked={!!checkedStyles[style]}
                            onChange={(e) =>
                              setCheckedStyles((current) => ({
                                ...current,
                                [style]: e.target.checked,
                              }))
                            }
                          />
                          {style || "未标注"}
                          <span className="muted">{count}</span>
                        </label>
                      );
                    })}
                  </span>
                </div>
              )}
            </section>
          ))}
        </div>
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            disabled={busy || !selectedCount}
            onClick={() => onConfirm({ kinds: selectedKinds, robotStyles: selectedStyles })}
          >
            {busy ? "打包中…" : "开始下载"}
          </button>
        </div>
      </div>
    </div>
  );
}

function matrixRows() {
  return Object.entries(MODALITY_LABEL).flatMap(([modality, label]) =>
    modality === "motion"
      ? MOTION_KIND_OPTIONS.map(([kind, kindLabel]) => ({
          key: `${modality}:${kind}`,
          modality,
          motionKind: kind,
          label: kindLabel,
        }))
      : [{ key: modality, modality, motionKind: undefined as MotionKind | undefined, label }]
  );
}

function UnitMatrix({
  unit,
  selectedFile,
  onFile,
  canUpload,
  onQuickUpload,
  showEmpty = true,
}: {
  unit: StorageUnit;
  selectedFile: StorageFile | null;
  onFile: (file: StorageFile) => void;
  canUpload: boolean;
  onQuickUpload: (preset: {
    ontology: string;
    modality: string;
    motionKind?: MotionKind;
  }) => void;
  showEmpty?: boolean;
}) {
  const robotFiles = unit.files.filter((f) => f.ontology === "robot");
  const robotStyles = [
    ...new Set(
      robotFiles.map((f) => String(f.robot_style || f.annotation?.robot_style || "").trim()).filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b, "zh"));
  const [robotStyle, setRobotStyle] = useState(robotStyles[0] || "");
  const activeStyle = robotStyles.includes(robotStyle) ? robotStyle : robotStyles[0] || "";
  const styleFilter = (file: StorageFile) => {
    if (file.ontology !== "robot") return true;
    if (!robotStyles.length) return true;
    const style = String(file.robot_style || file.annotation?.robot_style || "").trim();
    return style === activeStyle;
  };

  return (
    <div className="storage-unit-matrix">
      {(["human", "robot"] as const).map((ontology) => {
        const hasFiles = unit.files.some((file) => file.ontology === ontology);
        if (!showEmpty && !hasFiles) return null;
        return (
        <section key={ontology} className="storage-ontology-card">
          <h3>{ontology === "human" ? "人体数据" : "机器人数据"}</h3>
          {ontology === "robot" && robotStyles.length > 1 && (
            <div className="storage-robot-style-tabs">
              {robotStyles.map((style) => (
                <button
                  key={style}
                  type="button"
                  className={`storage-robot-style-tab ${style === activeStyle ? "active" : "secondary"}`}
                  onClick={() => setRobotStyle(style)}
                >
                  {style}
                </button>
              ))}
            </div>
          )}
          {ontology === "robot" && robotStyles.length === 1 && (
            <div className="storage-robot-style-label">款式：{robotStyles[0]}</div>
          )}
          {matrixRows().map(({ key, modality, motionKind, label }) => {
            const files = unit.files.filter(
              (f) =>
                f.ontology === ontology &&
                f.modality === modality &&
                (!motionKind || resolveMotionKind(f.annotation?.motion_kind) === motionKind) &&
                styleFilter(f)
            );
            if (!showEmpty && !files.length) return null;
            return (
              <div className="storage-modality-row" key={key}>
                <div
                  className={`storage-modality-name ${files.length ? "" : "missing"}`}
                  title={files.length ? `查看${label}文件信息` : undefined}
                  onClick={() => {
                    if (files.length) onFile(files[files.length - 1]);
                  }}
                  style={files.length ? { cursor: "pointer" } : undefined}
                >
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
                    title={
                      files.length && selectedFile?.id !== files[files.length - 1].id
                        ? `查看并预览${label}`
                        : `添加${label}`
                    }
                    onClick={() => {
                      const last = files[files.length - 1];
                      if (last && selectedFile?.id !== last.id) {
                        onFile(last);
                        return;
                      }
                      onQuickUpload({ ontology, modality, motionKind });
                    }}
                  >
                    +
                  </button>
                )}
              </div>
            );
          })}
        </section>
        );
      })}
    </div>
  );
}

type WorkspaceVariant = "browse" | "upload" | "annotate" | "manage";

export const STORAGE_SORT_OPTIONS: [string, string][] = [
  ["created_desc", "创建时间由近到远"],
  ["created_asc", "创建时间由远到近"],
  ["uploaded_desc", "上传时间由近到远"],
  ["uploaded_asc", "上传时间由远到近"],
  ["modified_desc", "修改时间由近到远"],
  ["modified_asc", "修改时间由远到近"],
  ["name_asc", "字符顺序 A-Z"],
  ["name_desc", "字符顺序 Z-A"],
];

function parseSortTime(value?: string | null) {
  if (!value) return 0;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? stamp : 0;
}

function compareNames(left: string, right: string) {
  return left.localeCompare(right, "zh", { numeric: true, sensitivity: "base" });
}

function entitySortTimes(item: {
  created_at?: string;
  uploaded_at?: string;
  modified_at?: string;
}) {
  return {
    created: parseSortTime(item.created_at),
    uploaded: parseSortTime(item.uploaded_at),
    modified: parseSortTime(item.modified_at),
  };
}

function sortStorageUnits(units: StorageUnit[], sortMode: string) {
  return [...units].sort((a, b) =>
    compareByStorageSort(a, b, sortMode, (item) => item.name, entitySortTimes)
  );
}

function sortBatchNames(names: string[], units: StorageUnit[], sortMode: string) {
  const groups = new Map<string, StorageUnit[]>();
  for (const unit of units) {
    const list = groups.get(unit.batch) || [];
    list.push(unit);
    groups.set(unit.batch, list);
  }
  return [...names].sort((left, right) =>
    compareByStorageSort(
      {
        name: left,
        created_at: groups.get(left)?.reduce(
          (earliest, unit) =>
            !earliest || (unit.created_at && unit.created_at < earliest)
              ? unit.created_at || earliest
              : earliest,
          ""
        ),
        uploaded_at: groups.get(left)?.reduce(
          (latest, unit) =>
            unit.uploaded_at && unit.uploaded_at > latest ? unit.uploaded_at : latest,
          ""
        ),
        modified_at: groups.get(left)?.reduce(
          (latest, unit) =>
            unit.modified_at && unit.modified_at > latest ? unit.modified_at : latest,
          ""
        ),
      },
      {
        name: right,
        created_at: groups.get(right)?.reduce(
          (earliest, unit) =>
            !earliest || (unit.created_at && unit.created_at < earliest)
              ? unit.created_at || earliest
              : earliest,
          ""
        ),
        uploaded_at: groups.get(right)?.reduce(
          (latest, unit) =>
            unit.uploaded_at && unit.uploaded_at > latest ? unit.uploaded_at : latest,
          ""
        ),
        modified_at: groups.get(right)?.reduce(
          (latest, unit) =>
            unit.modified_at && unit.modified_at > latest ? unit.modified_at : latest,
          ""
        ),
      },
      sortMode,
      (item) => item.name,
      entitySortTimes
    )
  );
}

function compareByStorageSort<T>(
  left: T,
  right: T,
  sortMode: string,
  nameOf: (item: T) => string,
  timesOf: (item: T) => { created: number; uploaded: number; modified: number }
) {
  const nameCmp = compareNames(nameOf(left), nameOf(right));
  const a = timesOf(left);
  const b = timesOf(right);
  let primary = 0;
  if (sortMode === "created_desc") primary = b.created - a.created;
  else if (sortMode === "created_asc") primary = a.created - b.created;
  else if (sortMode === "uploaded_desc") primary = b.uploaded - a.uploaded;
  else if (sortMode === "uploaded_asc") primary = a.uploaded - b.uploaded;
  else if (sortMode === "modified_desc") primary = b.modified - a.modified;
  else if (sortMode === "modified_asc") primary = a.modified - b.modified;
  else if (sortMode === "name_desc") return -nameCmp;
  else return nameCmp;
  return primary || nameCmp;
}

export function StorageWorkspace({
  variant = "browse",
}: {
  variant?: WorkspaceVariant;
}) {
  const { user, hasPerm } = useAuth();
  const { execute } = useUndo();
  const [data, setData] = useState<StorageOverview | null>(null);
  const [classificationUnits, setClassificationUnits] = useState<StorageUnit[]>([]);
  const [schemes, setSchemes] = useState<TaxonomySchemeDef[]>([]);
  const [nodes, setNodes] = useState<TaxonomyNode[]>([]);
  const [mode, setMode] = useState("folder");
  const [tagId, setTagId] = useState<number | null>(null);
  const [tagExact, setTagExact] = useState(false);
  const selectTag = (id: number | null, exact = false) => {
    setTagId(id);
    setTagExact(Boolean(exact) && id != null);
  };
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState("created_desc");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ kind: DetailKind; key: string } | null>(null);
  const preview = usePreview();
  const [quickPreset, setQuickPreset] = useState<{
    ontology: string;
    modality: string;
    motionKind?: MotionKind;
  } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [extraBatches, setExtraBatches] = useState<string[]>([]);
  const [downloadPick, setDownloadPick] = useState<{
    batches: StorageBatch[];
    units: StorageUnit[];
  } | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const loadSequence = useRef(0);
  const pendingSelectBatch = useRef<string | null>(null);
  const pendingSelectSession = useRef<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [uploadTagIds, setUploadTagIds] = useState<Record<string, number | "">>({});

  const hasAnnotationPermission = hasPerm("annotate");
  const canUpload =
    (variant === "manage" && hasPerm("manage_data")) ||
    (variant === "upload" && hasPerm("upload"));
  const canAnnotate =
    (variant === "annotate" && hasAnnotationPermission) ||
    (variant === "manage" && hasPerm("manage_data")) ||
    (variant === "upload" && hasPerm("upload"));
  const canDelete = variant === "manage" && hasPerm("manage_data");
  const canManageItems = hasPerm("manage_data");
  const canDownloadItems = hasPerm("download");
  const canCreateTaxonomy = canAnnotate && hasPerm("manage_data");
  const structureOnly = variant === "upload";
  const selectedFile = preview.activeFile;

  const load = async (keepSelection = true, force = true) => {
    const requestId = ++loadSequence.current;
    setError("");
    try {
      const overview = await fetchStorageOverview({
        q: query || undefined,
        taxonomy_scheme:
          mode === "folder" || mode === "uploader" ? undefined : mode,
        tag_id:
          mode === "folder" || mode === "uploader" ? undefined : tagId,
        tag_exact:
          mode === "folder" || mode === "uploader" || !tagExact ? undefined : 1,
        uploader_id: variant === "upload" ? user?.id : undefined,
        include_empty: variant === "manage" ? 1 : undefined,
      }, force);
      if (requestId !== loadSequence.current) return;
      setData(overview);
      preview.syncFromOverview(overview.files, overview.units);
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
      const pendingSessionId = pendingSelectSession.current;
      pendingSelectSession.current = null;
      const importedSession = pendingSessionId
        ? (overview.upload_sessions || []).find((item) => item.id === pendingSessionId)
        : null;
      if (importedSession) {
        setMode("upload_order");
        setActiveSessionId(importedSession.id);
        setFocus({ kind: "upload_session", key: importedSession.id });
        setSelectedKey(null);
      } else if (importedBatch?.units[0]) {
        setSelectedKey(importedBatch.units[0].key);
        setFocus({ kind: "unit", key: importedBatch.units[0].key });
      } else if (pendingBatchName) {
        setFocus({ kind: "batch", key: pendingBatchName });
      } else if (!keepSelection || !overview.units.some((u) => u.key === selectedKey)) {
        const first = overview.units[0];
        setSelectedKey(first?.key || null);
        setFocus(first ? { kind: "unit", key: first.key } : null);
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
    void load(true, false);
  }, [mode, tagId, tagExact, user?.id, variant]);

  useEffect(() => {
    const onIndexUpdated = () => {
      void load(true, true);
    };
    window.addEventListener(INDEX_UPDATED_EVENT, onIndexUpdated);
    return () => window.removeEventListener(INDEX_UPDATED_EVENT, onIndexUpdated);
  }, [mode, tagId, tagExact, user?.id, variant, query]);

  const selected = useMemo(
    () => data?.units.find((unit) => unit.key === selectedKey) || null,
    [data, selectedKey]
  );

  const displayData = useMemo(() => {
    if (!data) return null;
    const compareUnits = (a: StorageUnit, b: StorageUnit) =>
      compareByStorageSort(a, b, sortMode, (item) => item.name, entitySortTimes);
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
        compareByStorageSort(a, b, sortMode, (item) => item.name, entitySortTimes)
      );
    return { ...data, batches };
  }, [data, extraBatches, sortMode]);

  const currentNodes = nodes.filter((node) => node.scheme === mode);

  const reloadTaxonomies = async () => {
    setNodes(await api.listTaxonomies());
  };

  const focusedSession = useMemo(() => {
    const id =
      focus?.kind === "upload_session" ? focus.key : activeSessionId;
    if (!id) return null;
    return (data?.upload_sessions || []).find((item) => item.id === id) || null;
  }, [focus, activeSessionId, data]);

  const focusedBatch = useMemo(() => {
    if (focus?.kind !== "batch") return null;
    return displayData?.batches.find((item) => item.name === focus.key) || null;
  }, [displayData, focus]);

  const focusedNode = useMemo(() => {
    if (focus?.kind !== "node" || !displayData) return null;
    const splitAt = focus.key.indexOf("::");
    const batchName = splitAt >= 0 ? focus.key.slice(0, splitAt) : focus.key;
    const dirPath = splitAt >= 0 ? focus.key.slice(splitAt + 2) : "";
    const nodeBatch = displayData.batches.find((item) => item.name === batchName);
    if (!nodeBatch) return null;
    return {
      batchName,
      dirPath,
      units: unitsUnderPath(nodeBatch.units, dirPath),
    };
  }, [displayData, focus]);

  const lastVisualizedRef = useRef<StorageFile | null>(preview.activeFile);
  useEffect(() => {
    if (preview.activeFile) lastVisualizedRef.current = preview.activeFile;
  }, [preview.activeFile]);

  const previewUnitFile = (unit: StorageUnit, keepFocus: boolean) => {
    const file = pickPreviewFile(unit.files, lastVisualizedRef.current);
    if (!file) return;
    lastVisualizedRef.current = file;
    preview.add(file);
    if (!keepFocus) {
      setSelectedKey(unit.key);
      setFocus({ kind: "file", key: file.path });
    }
  };

  const previewRandomUnit = (units: StorageUnit[], keepFocus: boolean) => {
    const playable = units.filter((unit) =>
      unit.files.some((file) => isVisualizableStorageFile(file))
    );
    if (!playable.length) return;
    const unit = playable[Math.floor(Math.random() * playable.length)];
    previewUnitFile(unit, keepFocus);
  };

  const unitsForTaxonomyNode = (id: number, exact: boolean) => {
    const node = nodes.find((item) => item.id === id);
    if (!node) return [];
    return classificationUnits.filter((unit) => {
      const taggedId = unit.taxonomy_tag_ids?.[node.scheme];
      if (exact) return taggedId === node.id;
      const tagged = nodes.find((item) => item.id === taggedId);
      return !!tagged && tagged.path.startsWith(node.path);
    });
  };

  const ownsSelected = !!(user && selected && unitOwnedBy(selected, user.id));
  const ownsFocusedBatch = !!(
    user &&
    focusedBatch &&
    batchOwnedBy(focusedBatch, user.id)
  );
  const canAnnotateSelected =
    canAnnotate ||
    ownsSelected ||
    ownsFocusedBatch ||
    !!(user && focusedSession && focusedSession.user_id === user.id);

  const focusedFile = useMemo(() => {
    if (focus?.kind !== "file") return selectedFile;
    const path = focus.key;
    return (
      selected?.files.find((item) => item.path === path) ||
      data?.units.flatMap((unit) => unit.files).find((item) => item.path === path) ||
      data?.files.find((item) => item.path === path) ||
      preview.slots.find((item) => item?.path === path) ||
      selectedFile
    );
  }, [focus, selected, data, selectedFile, preview.slots]);

  const promptName = (label: string, current: string) => {
    const next = window.prompt(label, current);
    if (next == null) return "";
    return next.trim();
  };

  const handleRenameBatch = async (batch: StorageBatch) => {
    const next = promptName("新的数据批次名称", batch.name);
    if (!next || next === batch.name) return;
    const prev = batch.name;
    try {
      await execute({
        label: `重命名批次为 ${next}`,
        do: async () => {
          await api.storageRenameBatch(prev, next);
          setMessage(`批次已重命名为 ${next}`);
          setFocus({ kind: "batch", key: next });
          await load();
        },
        undo: async () => {
          await api.storageRenameBatch(next, prev);
          setFocus({ kind: "batch", key: prev });
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "重命名失败");
    }
  };

  const handleRenameUnit = async (unit: StorageUnit) => {
    const next = promptName("新的数据单元名称", unit.name);
    if (!next || next === unit.name) return;
    const prev = unit.name;
    const batchName = unit.batch;
    try {
      await execute({
        label: `重命名数据单元为 ${next}`,
        do: async () => {
          await api.storageRenameUnit(batchName, prev, next);
          setMessage(`数据单元已重命名为 ${next}`);
          setSelectedKey(`${batchName}::${next}`);
          setFocus({ kind: "unit", key: `${batchName}::${next}` });
          await load();
        },
        undo: async () => {
          await api.storageRenameUnit(batchName, next, prev);
          setSelectedKey(`${batchName}::${prev}`);
          setFocus({ kind: "unit", key: `${batchName}::${prev}` });
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "重命名失败");
    }
  };

  const handleRenameFile = async (file: StorageFile) => {
    const next = promptName("新的文件名（扩展名会保留）", file.name);
    if (!next || next === file.name) return;
    const prevName = file.name;
    let currentPath = file.path;
    try {
      await execute({
        label: `重命名文件为 ${next}`,
        do: async () => {
          const renamed = await api.storageRenameFile(currentPath, next);
          preview.replaceByPath(currentPath, renamed);
          currentPath = renamed.path;
          setMessage(`文件已重命名为 ${renamed.name}`);
          setSelectedKey(`${renamed.batch}::${renamed.unit_name}`);
          setFocus({ kind: "file", key: renamed.path });
          await load();
        },
        undo: async () => {
          const restored = await api.storageRenameFile(currentPath, prevName);
          preview.replaceByPath(currentPath, restored);
          currentPath = restored.path;
          setSelectedKey(`${restored.batch}::${restored.unit_name}`);
          setFocus({ kind: "file", key: restored.path });
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "重命名失败");
    }
  };

  const handleDeleteItems = async (batches: StorageBatch[], units: StorageUnit[]) => {
    const covered = new Set(batches.map((item) => item.name));
    const leftover = units.filter((unit) => !covered.has(unit.batch));
    const labels = [
      ...batches.map((item) => `批次 ${item.name}`),
      ...leftover.map((unit) => `单元 ${unit.batch}/${unit.name}`),
    ];
    if (!labels.length) return;
    if (!window.confirm(`确认删除以下 ${labels.length} 项？\n${labels.join("\n")}`)) return;
    try {
      await api.storageBulkDelete({
        batches: batches.map((item) => item.name),
        units: leftover.map((unit) => ({ batch: unit.batch, name: unit.name })),
      });
      setMessage("已删除所选项目");
      setFocus(null);
      setSelectedKey(null);
      preview.removeByPaths(
        [
          ...batches.flatMap((item) =>
            item.units.flatMap((unit) => unit.files.map((file) => file.path))
          ),
          ...leftover.flatMap((unit) => unit.files.map((file) => file.path)),
        ]
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const canDeleteUploadSession = (session: StorageUploadSession) =>
    !!(user && (session.user_id === user.id || hasPerm("manage_data")));

  const handleDeleteUploadSession = async (
    session: StorageUploadSession,
    paths?: string[],
    confirmText?: string
  ) => {
    const targets = paths ?? session.paths;
    if (!targets.length) return;
    const whole = !paths || paths.length >= session.paths.length;
    const text =
      confirmText ||
      (whole
        ? `确认删除这次上传的 ${session.file_count} 个文件？\n${formatSessionTime(session.created_at)} · ${session.batch || "未分批次"}\n不会删除同批次其它上传。`
        : `确认删除这次上传中的 ${targets.length} 个文件？\n不会删除同单元其它上传留下的文件。`);
    if (!window.confirm(text)) return;
    try {
      await api.storageDeleteUploadSession(session.id, whole ? undefined : paths);
      setMessage(whole ? "已删除这次上传的文件" : `已删除 ${targets.length} 个文件`);
      if (whole) {
        if (activeSessionId === session.id) setActiveSessionId(null);
        if (focus?.kind === "upload_session" && focus.key === session.id) {
          setFocus(null);
        }
        setSelectedKey(null);
      }
      preview.removeByPaths(targets);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const handleDownloadItems = (batches: StorageBatch[], units: StorageUnit[]) => {
    const covered = new Set(batches.map((item) => item.name));
    const leftover = units.filter((unit) => !covered.has(unit.batch));
    if (!batches.length && !leftover.length) return;
    setDownloadPick({ batches, units: leftover });
  };

  const confirmDownload = async ({ kinds, robotStyles }: DownloadConfirm) => {
    if (!downloadPick || !kinds.length) return;
    const { batches, units } = downloadPick;
    const filename =
      batches.length === 1 && !units.length
        ? `${batches[0].name}.zip`
        : !batches.length && units.length === 1
          ? `${units[0].name}.zip`
          : "storage_selection.zip";
    setDownloadBusy(true);
    try {
      await downloadAuthPost(
        "/api/storage/archive",
        {
          batches: batches.map((item) => item.name),
          units: units.map((unit) => ({ batch: unit.batch, name: unit.name })),
          kinds,
          robot_styles: robotStyles,
        },
        filename
      );
      setDownloadPick(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "下载失败");
    } finally {
      setDownloadBusy(false);
    }
  };

  if (variant === "manage" && !hasPerm("manage_data")) {
    return <div className="page error">没有管理数据权限</div>;
  }
  if (variant === "upload" && !hasPerm("upload")) {
    return <div className="page error">没有上传权限</div>;
  }
  if (variant === "annotate" && !hasAnnotationPermission) {
    return <div className="page error">没有标注权限</div>;
  }

  return (
    <div className={`page storage-page stack${variant === "upload" ? " is-upload" : ""}`}>
      {variant === "upload" && (
        <div className="card storage-upload-dock">
          <section className="storage-upload-dock-tags">
            <div className="storage-upload-preset-head">
              <strong>预设分类标签</strong>
              <span className="muted">先选标签再导入，弹窗和导入后都还能改</span>
            </div>
            <UploadTaxonomyFields
              schemes={schemes}
              nodes={nodes}
              value={uploadTagIds}
              onChange={setUploadTagIds}
              canCreate={canCreateTaxonomy}
              onNodesReload={reloadTaxonomies}
            />
          </section>
          <section className="storage-upload-dock-panel is-import">
            <div className="storage-upload-dock-title">
              <strong>新建与导入</strong>
              <span className="muted">也可把文件夹 / zip 拖到这里</span>
            </div>
            <FolderBatchImport
              layout="dock"
              schemes={schemes}
              nodes={nodes}
              canCreateTaxonomy={canCreateTaxonomy}
              onNodesReload={reloadTaxonomies}
              taxonomyTagIds={uploadTagIds}
              onTaxonomyTagIdsChange={setUploadTagIds}
              onImported={(batchName, sessionId) => {
                pendingSelectBatch.current = batchName;
                pendingSelectSession.current = sessionId || null;
                setExtraBatches((current) =>
                  current.includes(batchName) ? current : [...current, batchName]
                );
                if (sessionId && mode !== "upload_order") {
                  setMode("upload_order");
                  return;
                }
                void load(true);
              }}
              onError={setError}
              onMessage={setMessage}
            />
          </section>
        </div>
      )}
      {variant !== "upload" && (
      <div className="storage-toolbar card">
        {!structureOnly && (
          <div className="storage-filter-line">
            <span className="muted">分类标准：</span>
            <button
              type="button"
              className={mode === "folder" ? "active" : "secondary"}
              onClick={() => {
                setMode("folder");
                selectTag(null);
              }}
            >
              存储结构
            </button>
            <button
              type="button"
              className={mode === "uploader" ? "active" : "secondary"}
              onClick={() => {
                setMode("uploader");
                selectTag(null);
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
                  selectTag(null);
                }}
              >
                {taxonomySchemeLabel(scheme.key, schemes)}
              </button>
            ))}
          </div>
        )}
        <div className="storage-filter-line">
          <span className="muted">排序方式：</span>
          {STORAGE_SORT_OPTIONS.map(([value, label]) => (
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
        {mode !== "folder" && mode !== "uploader" && mode !== "upload_order" && (
          <div className="storage-filter-line">
            <span className="muted">{taxonomySchemeLabel(mode, schemes)}：</span>
            <select
              value={tagId ?? ""}
              onChange={(e) => selectTag(e.target.value ? Number(e.target.value) : null)}
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
      )}

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <div className="storage-workspace">
        <aside className="card storage-left-pane">
          {variant === "upload" && (
            <div className="storage-upload-browse">
              <div className="storage-upload-dock-title">
                <strong>查看与搜索</strong>
                <span className="muted">
                  {mode === "upload_order" ? "上传顺序" : "存储结构"}
                </span>
              </div>
              <div className="storage-filter-line">
                <span className="muted">列表：</span>
                <button
                  type="button"
                  className={mode === "folder" ? "active" : "secondary"}
                  onClick={() => {
                    setMode("folder");
                    selectTag(null);
                  }}
                >
                  存储结构
                </button>
                <button
                  type="button"
                  className={mode === "upload_order" ? "active" : "secondary"}
                  onClick={() => {
                    setMode("upload_order");
                    selectTag(null);
                  }}
                >
                  上传顺序
                </button>
              </div>
              <div className="storage-filter-line">
                <span className="muted">排序：</span>
                <select
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value)}
                >
                  {STORAGE_SORT_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="storage-filter-line">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void load(false);
                  }}
                  placeholder="搜索批次或数据单元"
                />
                <button type="button" onClick={() => void load(false)}>
                  搜索
                </button>
              </div>
            </div>
          )}
          {mode !== "folder" && mode !== "uploader" && mode !== "upload_order" && (
            <>
              <h3 style={{ marginTop: 0 }}>
                {taxonomySchemeLabel(mode, schemes)}分类树
              </h3>
              <TaxonomyTreePanel
                nodes={currentNodes}
                units={classificationUnits}
                sortMode={sortMode}
                selectedId={tagId}
                selectedExact={tagExact}
                selectedKey={selectedKey}
                onSelect={(id, exact) => {
                  selectTag(id, exact);
                  if (id != null) previewRandomUnit(unitsForTaxonomyNode(id, !!exact), false);
                }}
                onUnitSelect={(unit) => {
                  setSelectedKey(unit.key);
                  setActiveSessionId(null);
                  previewUnitFile(unit, false);
                  if (!pickPreviewFile(unit.files, lastVisualizedRef.current)) {
                    setFocus({ kind: "unit", key: unit.key });
                  }
                }}
                canDownload={canDownloadItems}
                currentUserId={user?.id}
                onDownload={(units) => handleDownloadItems([], units)}
              />
            </>
          )}
          {mode === "uploader" && (
            <>
              <h3 style={{ marginTop: 0 }}>上传用户</h3>
              <UploaderTreePanel
                uploaders={data?.uploaders || []}
                units={data?.units || []}
                sortMode={sortMode}
                selectedId={tagId}
                selectedKey={selectedKey}
                onSelect={setTagId}
                onUnitSelect={(unit) => {
                  setSelectedKey(unit.key);
                  previewUnitFile(unit, false);
                  if (!unit.files.some((file) => isVisualizableStorageFile(file))) {
                    setFocus({ kind: "unit", key: unit.key });
                  }
                }}
                canDownload={canDownloadItems}
                currentUserId={user?.id}
                onDownload={(units) => handleDownloadItems([], units)}
              />
            </>
          )}
          {mode === "upload_order" && (
            <UploadSessionTree
              sessions={(data?.upload_sessions || [])
                .filter((session) => {
                  if (!query.trim()) return true;
                  const needle = query.trim().toLowerCase();
                  return (
                    session.batch.toLowerCase().includes(needle) ||
                    session.unit_names.some((name) =>
                      name.toLowerCase().includes(needle)
                    ) ||
                    formatSessionTime(session.created_at).includes(needle)
                  );
                })
                .slice()
                .sort((left, right) =>
                  compareByStorageSort(
                    left,
                    right,
                    sortMode,
                    (item) => item.batch,
                    (item) => ({
                      created: parseSortTime(item.created_at),
                      uploaded: parseSortTime(item.created_at),
                      modified: parseSortTime(item.created_at),
                    })
                  )
                )}
              units={data?.units || []}
              selectedSessionId={activeSessionId}
              selectedUnitKey={
                focus?.kind === "unit" || focus?.kind === "file" ? selectedKey : null
              }
              canDeleteSession={canDeleteUploadSession}
              canDownload={canDownloadItems}
              currentUserId={user?.id}
              onDownload={(units) => handleDownloadItems([], units)}
              onSelectSession={(session) => {
                setActiveSessionId(session.id);
                setFocus({ kind: "upload_session", key: session.id });
                setSelectedKey(null);
              }}
              onSelectUnit={(session, unit) => {
                setActiveSessionId(session.id);
                setSelectedKey(unit.key);
                previewUnitFile(unit, false);
                if (!unit.files.some((file) => isVisualizableStorageFile(file))) {
                  setFocus({ kind: "unit", key: unit.key });
                }
              }}
              onDeleteSession={(session) => void handleDeleteUploadSession(session)}
              onDeleteSessionUnit={(session, unit) => {
                const paths = sessionUnitPaths(session, unit);
                void handleDeleteUploadSession(
                  session,
                  paths,
                  `确认删除这次上传到「${unit.name}」的 ${paths.length} 个文件？\n不会删除该单元里其它上传留下的文件。`
                );
              }}
            />
          )}
          {mode === "folder" && (
            <UnitTree
              data={displayData || { updated_at: "", modalities: [], ontologies: [], uploaders: [], batches: [], units: [], files: [] }}
              selectedUnit={focus?.kind === "unit" || focus?.kind === "file" ? selectedKey : null}
              selectedNodeKey={focus?.kind === "node" ? focus.key : null}
              onSelectUnit={(unit) => {
                setActiveSessionId(null);
                setSelectedKey(unit.key);
                previewUnitFile(unit, false);
                if (!unit.files.some((file) => isVisualizableStorageFile(file))) {
                  setFocus({ kind: "unit", key: unit.key });
                }
              }}
              onSelectNode={(key) => {
                setActiveSessionId(null);
                setSelectedKey(null);
                setFocus({ kind: "node", key });
                const splitAt = key.indexOf("::");
                const batchName = splitAt >= 0 ? key.slice(0, splitAt) : key;
                const dirPath = splitAt >= 0 ? key.slice(splitAt + 2) : "";
                const batch = displayData?.batches.find((item) => item.name === batchName);
                if (batch) previewRandomUnit(unitsUnderPath(batch.units, dirPath), true);
              }}
              canEdit={canManageItems}
              canDownload={canDownloadItems}
              currentUserId={user?.id}
              onRenameBatch={(batch) => void handleRenameBatch(batch)}
              onRenameUnit={(unit) => void handleRenameUnit(unit)}
              onDelete={(batches, units) => void handleDeleteItems(batches, units)}
              onDownload={(batches, units) => void handleDownloadItems(batches, units)}
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
          {focus?.kind === "node" && focusedNode && (
            <>
              <div>
                <h2 style={{ margin: 0 }}>{focusedNode.dirPath || focusedNode.batchName}</h2>
                <span className="muted">
                  {focusedNode.batchName}
                  {focusedNode.dirPath ? ` / ${focusedNode.dirPath}` : ""} · {focusedNode.units.length} 个单元 ·{" "}
                  {focusedNode.units.reduce((sum, item) => sum + item.file_count, 0)} 个文件
                </span>
              </div>
              <div className="storage-preview-empty">
                已选中数据节点。请在右侧查看或批量设置其下所有数据单元的标签。
              </div>
            </>
          )}
          {focus?.kind === "upload_session" && focusedSession && (
            <>
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                <div>
                  <h2 style={{ margin: 0 }}>
                    {formatSessionTime(focusedSession.created_at)} ·{" "}
                    {UPLOAD_SOURCE_LABEL[focusedSession.source] || "上传"}
                  </h2>
                  <span className="muted">
                    {focusedSession.batch || "未分批次"} · {focusedSession.file_count} 个文件 ·{" "}
                    {focusedSession.username || "上传者未知"}
                  </span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {(canDownloadItems || focusedSession.user_id === user?.id) && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        const sessionUnits = (data?.units || []).filter((unit) =>
                          focusedSession.unit_names.includes(unit.name) &&
                          unit.batch === focusedSession.batch
                        );
                        handleDownloadItems([], sessionUnits);
                      }}
                    >
                      下载本次上传
                    </button>
                  )}
                  {canDeleteUploadSession(focusedSession) && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void handleDeleteUploadSession(focusedSession)}
                    >
                      删除本次上传
                    </button>
                  )}
                </div>
              </div>
              <div className="storage-preview-empty">
                这是一次独立上传记录，不会和同批次的其它上传合并。请在右侧修改本次上传时设置的款式、姓名等参数，保存后只作用于这次上传的文件。也可从左侧展开后选择其中的数据单元。
              </div>
            </>
          )}
          {focus?.kind !== "batch" && focus?.kind !== "node" && focus?.kind !== "upload_session" && !selected && (
            <div className="storage-preview-empty">请选择一个数据批次、上传记录或数据单元</div>
          )}
          {focus?.kind !== "batch" && focus?.kind !== "node" && focus?.kind !== "upload_session" && selected && (
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
                  {(canDownloadItems || unitOwnedBy(selected, user?.id)) && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleDownloadItems([], [selected])}
                    >
                      下载此单元
                    </button>
                  )}
                  {selectedFile &&
                    (canDownloadItems || selectedFile.uploader?.id === user?.id) && (
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
                  {selectedFile && canManageItems && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void handleRenameFile(selectedFile)}
                    >
                      重命名当前文件
                    </button>
                  )}
                  {selectedFile &&
                    (canDelete ||
                      !!(
                        focusedSession &&
                        canDeleteUploadSession(focusedSession) &&
                        focusedSession.paths.includes(selectedFile.path)
                      )) && (
                    <button
                      type="button"
                      className="danger"
                      onClick={async () => {
                        if (!confirm(`确认删除 ${selectedFile.name}？`)) return;
                        try {
                          if (
                            focusedSession &&
                            focusedSession.paths.includes(selectedFile.path)
                          ) {
                            await api.storageDeleteUploadSession(focusedSession.id, [
                              selectedFile.path,
                            ]);
                          } else {
                            await api.storageDeleteFile(selectedFile.path);
                          }
                          preview.removeByPaths([selectedFile.path]);
                          await load();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "删除失败");
                        }
                      }}
                    >
                      删除当前文件
                    </button>
                  )}
                </div>
              </div>

              <UnitMatrix
                unit={selected}
                selectedFile={focus?.kind === "file" ? focusedFile : null}
                onFile={(file) => {
                  setSelectedKey(`${file.batch}::${file.unit_name}`);
                  setFocus({ kind: "file", key: file.path });
                  preview.add(file);
                }}
                canUpload={canUpload}
                onQuickUpload={setQuickPreset}
                showEmpty={variant === "upload" || variant === "manage"}
              />

            </>
          )}
          <FilePreviewDock
            onActivate={(file) => {
              setSelectedKey(`${file.batch}::${file.unit_name}`);
              setFocus({ kind: "file", key: file.path });
            }}
          />
        </main>
        <EntityDetailPanel
          kind={focus?.kind || null}
          batch={
            focusedBatch ||
            displayData?.batches.find(
              (item) => item.name === (selected?.batch || focusedFile?.batch || focusedNode?.batchName)
            ) ||
            null
          }
          unit={selected}
          file={focus?.kind === "file" ? focusedFile : null}
          session={focusedSession}
          nodeInfo={focusedNode}
          schemes={schemes}
          nodes={nodes}
          canEdit={variant !== "browse" && canAnnotateSelected}
          canCreate={variant !== "browse" && canCreateTaxonomy}
          onReload={async () => {
            await load(true);
          }}
          onNodesReload={reloadTaxonomies}
          onError={setError}
          onMessage={setMessage}
        />
      </div>

      {downloadPick && (
        <DownloadPicker
          batches={downloadPick.batches}
          units={downloadPick.units}
          busy={downloadBusy}
          onClose={() => {
            if (!downloadBusy) setDownloadPick(null);
          }}
          onConfirm={(payload) => void confirmDownload(payload)}
        />
      )}
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
