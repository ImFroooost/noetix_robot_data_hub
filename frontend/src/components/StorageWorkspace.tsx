import { Children, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { clampPane, SplitHandle, useStoredNumber } from "./SplitHandle";
import { TaxonomyTagPicker } from "./TaxonomyTagPicker";
import { setPresenceDetail } from "../presence";
import { fetchStorageOverview, INDEX_UPDATED_EVENT } from "../storageOverviewCache";
import { useUndo } from "../undo/UndoContext";
import { patchStorageMeta, type StorageMetaTarget } from "../undo/storageMeta";
import { formatFromFileName } from "../utils/folderUpload";
import {
  ORIGINAL_FILE_VERSION,
  fileVersionName,
  filesForVersion,
  latestVersionName,
  normalizeFileVersions,
  type FileVersionInfo,
} from "../utils/fileVersion";
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
  childrenByParent,
  sameTagIds,
  selectionAfterCheck,
  selectionCovers,
  specificSelection,
  specificTagIds,
  tagBriefList,
  tagIdList,
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

function applyCheckedKeys(
  current: Record<string, boolean>,
  keys: string[],
  on: boolean
): Record<string, boolean> {
  const next = { ...current };
  for (const key of keys) {
    if (on) next[key] = true;
    else delete next[key];
  }
  return next;
}

function checkedKeyCount(keys: string[], checked: Record<string, boolean>) {
  let count = 0;
  for (const key of keys) if (checked[key]) count += 1;
  return count;
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
  canPrioritize,
  onDownload,
  onRename,
  onPrioritize,
  onDelete,
}: {
  canDownload?: boolean;
  canEdit?: boolean;
  canPrioritize?: boolean;
  onDownload?: () => void;
  onRename?: () => void;
  onPrioritize?: () => void;
  onDelete?: () => void;
}) {
  if (!canDownload && !canEdit && !canPrioritize) return null;
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
      {canPrioritize && onPrioritize && (
        <button type="button" className="secondary" onClick={(e) => { e.stopPropagation(); onPrioritize(); }}>
          重定向
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
  indeterminate,
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
  indeterminate?: boolean;
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
            ref={(el) => {
              if (el) el.indeterminate = !!indeterminate && !checked;
            }}
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

function unitsInDir(node: DirTreeNode): StorageUnit[] {
  const units = [...node.units];
  for (const child of node.children.values()) units.push(...unitsInDir(child));
  return units;
}

function unitsUnderPath(units: StorageUnit[], dirPath: string): StorageUnit[] {
  if (!dirPath) return units;
  return units.filter((unit) => {
    const subPath = unitSubPath(unit);
    return subPath === dirPath || subPath.startsWith(`${dirPath}/`);
  });
}

function sharedUnitTag(
  units: StorageUnit[],
  scheme: string,
  nodes: TaxonomyNode[]
): { ids: number[]; mixed: boolean } {
  const schemeNodes = nodes.filter((node) => node.scheme === scheme);
  let current: number[] | undefined;
  for (const unit of units) {
    const ids = specificTagIds(tagIdList(unit.taxonomy_tag_ids?.[scheme]), schemeNodes);
    if (current === undefined) {
      current = ids;
      continue;
    }
    if (!sameTagIds(current, ids)) return { ids: [], mixed: true };
  }
  return { ids: current || [], mixed: false };
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
  onDownload: (batches: StorageBatch[], units: StorageUnit[]) => void,
  canPrioritize?: boolean,
  onPrioritize?: (units: StorageUnit[]) => void
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
            checked={(() => {
              const keys = unitsInDir(child).map((unit) => unit.key);
              return keys.length > 0 && checkedKeyCount(keys, checkedUnits) === keys.length;
            })()}
            indeterminate={(() => {
              const keys = unitsInDir(child).map((unit) => unit.key);
              const count = checkedKeyCount(keys, checkedUnits);
              return count > 0 && count < keys.length;
            })()}
            onCheck={
              canManage
                ? (value) => {
                    const keys = unitsInDir(child).map((unit) => unit.key);
                    setCheckedUnits((current) => applyCheckedKeys(current, keys, value));
                  }
                : undefined
            }
            actions={
              canPrioritize && onPrioritize ? (
                <TreeActions
                  canPrioritize
                  onPrioritize={() => onPrioritize(unitsInDir(child))}
                />
              ) : undefined
            }
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
                  onDownload,
                  canPrioritize,
                  onPrioritize
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
                  canPrioritize={canPrioritize}
                  onDownload={() => onDownload([], [unit])}
                  onRename={() => onRenameUnit(unit)}
                  onPrioritize={onPrioritize ? () => onPrioritize([unit]) : undefined}
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
                canPrioritize={canPrioritize}
                onDownload={() => onDownload([], [unit])}
                onRename={() => onRenameUnit(unit)}
                onPrioritize={onPrioritize ? () => onPrioritize([unit]) : undefined}
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
  onPrioritize,
  canPrioritize,
  onSelectionChange,
  ready = true,
}: {
  data: StorageOverview;
  ready?: boolean;
  selectedUnit: string | null;
  selectedNodeKey: string | null;
  onSelectUnit: (unit: StorageUnit) => void;
  onSelectNode: (key: string) => void;
  canEdit?: boolean;
  canDownload?: boolean;
  canPrioritize?: boolean;
  currentUserId?: number;
  onRenameBatch: (batch: StorageBatch) => void;
  onRenameUnit: (unit: StorageUnit) => void;
  onDelete: (batches: StorageBatch[], units: StorageUnit[]) => void;
  onDownload: (batches: StorageBatch[], units: StorageUnit[]) => void;
  onPrioritize?: (units: StorageUnit[]) => void;
  onSelectionChange?: (units: StorageUnit[]) => void;
}) {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const scopedEmpty =
    !isSuperRole(user?.role) &&
    !(user?.permissions || []).some(
      (item) => item.capability === "browse" || item.capability === "manage_data"
    );
  const [checkedUnits, setCheckedUnits] = useState<Record<string, boolean>>({});
  const batchKeys = data.batches.map((batch) => batch.name);
  const displayedUnits = data.batches.flatMap((batch) => batch.units);
  const displayedKeys = displayedUnits.map((unit) => unit.key);
  const selectedUnits = displayedUnits.filter((unit) => checkedUnits[unit.key]);
  const selectedCount = selectedUnits.length;
  useEffect(() => {
    const visible = new Set(displayedKeys);
    setCheckedUnits((current) => {
      const stale = Object.keys(current).some((key) => !visible.has(key));
      if (!stale) return current;
      const next: Record<string, boolean> = {};
      for (const key of Object.keys(current)) if (visible.has(key)) next[key] = true;
      return next;
    });
  }, [displayedKeys.join("\0")]);
  useReportSelection(selectedUnits, onSelectionChange);
  const canDownloadAny =
    !!canDownload || data.batches.some((batch) => batchOwnedBy(batch, currentUserId));
  const canManage = !!(canEdit || canDownloadAny);

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
                total={displayedUnits.length}
                selected={selectedCount}
                onChange={(checked) =>
                  setCheckedUnits((current) => applyCheckedKeys(current, displayedKeys, checked))
                }
              />
              <span className="muted">已选 {selectedCount} 项</span>
              {canDownloadAny && (
                <button
                  type="button"
                  className="secondary"
                  disabled={!selectedCount}
                  onClick={() => onDownload([], selectedUnits)}
                >
                  下载
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  className="secondary"
                  disabled={selectedUnits.length !== 1}
                  onClick={() => {
                    if (selectedUnits.length === 1) onRenameUnit(selectedUnits[0]);
                  }}
                >
                  重命名
                </button>
              )}
              {canPrioritize && onPrioritize && (
                <button
                  type="button"
                  className="secondary"
                  disabled={!selectedCount && !selectedNodeKey}
                  onClick={() => {
                    if (selectedUnits.length) {
                      onPrioritize(selectedUnits);
                      return;
                    }
                    if (!selectedNodeKey) return;
                    const splitAt = selectedNodeKey.indexOf("::");
                    const batchName = splitAt >= 0 ? selectedNodeKey.slice(0, splitAt) : selectedNodeKey;
                    const dirPath = splitAt >= 0 ? selectedNodeKey.slice(splitAt + 2) : "";
                    const batch = data.batches.find((item) => item.name === batchName);
                    if (batch) onPrioritize(unitsUnderPath(batch.units, dirPath));
                  }}
                >
                  重定向
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  className="danger"
                  disabled={!selectedCount}
                  onClick={() => onDelete([], selectedUnits)}
                >
                  删除
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={!selectedCount}
                onClick={() => setCheckedUnits({})}
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
            checked={
              batch.units.length > 0 &&
              checkedKeyCount(
                batch.units.map((unit) => unit.key),
                checkedUnits
              ) === batch.units.length
            }
            indeterminate={(() => {
              const count = checkedKeyCount(
                batch.units.map((unit) => unit.key),
                checkedUnits
              );
              return count > 0 && count < batch.units.length;
            })()}
            onCheck={
              canManage
                ? (value) =>
                    setCheckedUnits((current) =>
                      applyCheckedKeys(
                        current,
                        batch.units.map((unit) => unit.key),
                        value
                      )
                    )
                : undefined
            }
            actions={
              <TreeActions
                canDownload={!!canDownload || batchOwnedBy(batch, currentUserId)}
                canEdit={canEdit}
                onDownload={() => onDownload([batch], [])}
                onRename={() => onRenameBatch(batch)}
                canPrioritize={canPrioritize}
                onPrioritize={onPrioritize ? () => onPrioritize(batch.units) : undefined}
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
                    onDownload,
                    canPrioritize,
                    onPrioritize
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
          {!ready
            ? "正在加载数据…"
            : scopedEmpty
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
  onSelectionChange,
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
  onSelectionChange?: (units: StorageUnit[]) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [checkedUnits, setCheckedUnits] = useState<Record<string, boolean>>({});
  const uploaderKeys = uploaders.map((item) => String(item.id));
  const unitsOf = (uploader: StorageUploader) =>
    units.filter((unit) =>
      unit.files.some((file) =>
        uploader.id === -1 ? !file.uploader : file.uploader?.id === uploader.id
      )
    );
  const displayedUnits = uniqueUnits(uploaders.flatMap((item) => unitsOf(item)));
  const displayedKeys = displayedUnits.map((unit) => unit.key);
  const selectedUnits = displayedUnits.filter((unit) => checkedUnits[unit.key]);
  const selectedCount = selectedUnits.length;
  useEffect(() => {
    const visible = new Set(displayedKeys);
    setCheckedUnits((current) => {
      if (!Object.keys(current).some((key) => !visible.has(key))) return current;
      const next: Record<string, boolean> = {};
      for (const key of Object.keys(current)) if (visible.has(key)) next[key] = true;
      return next;
    });
  }, [displayedKeys.join("\0")]);
  useReportSelection(selectedUnits, onSelectionChange);
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
            total={displayedUnits.length}
            selectedForAll={selectedCount}
            canDownload={canDownloadAny}
            onSelectAll={(checked) =>
              setCheckedUnits((current) => applyCheckedKeys(current, displayedKeys, checked))
            }
            onDownload={() => onDownload?.(selectedUnits)}
            onClear={() => setCheckedUnits({})}
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
            checked={
              uploaderUnits.length > 0 &&
              checkedKeyCount(
                uploaderUnits.map((unit) => unit.key),
                checkedUnits
              ) === uploaderUnits.length
            }
            indeterminate={(() => {
              const count = checkedKeyCount(
                uploaderUnits.map((unit) => unit.key),
                checkedUnits
              );
              return count > 0 && count < uploaderUnits.length;
            })()}
            onCheck={
              canDownloadAny
                ? (value) =>
                    setCheckedUnits((current) =>
                      applyCheckedKeys(
                        current,
                        uploaderUnits.map((unit) => unit.key),
                        value
                      )
                    )
                : undefined
            }
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
  onSelectionChange,
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
  onSelectionChange?: (units: StorageUnit[]) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
  const displayedKeys = sessions.flatMap((session) =>
    unitsOf(session).map((unit) => unitCheckKey(session.id, unit.key))
  );
  const selectedUnits = sessions.flatMap((session) =>
    unitsOf(session).filter((unit) => checkedUnits[unitCheckKey(session.id, unit.key)])
  );
  const selectedCount = selectedUnits.length;
  useEffect(() => {
    const visible = new Set(displayedKeys);
    setCheckedUnits((current) => {
      if (!Object.keys(current).some((key) => !visible.has(key))) return current;
      const next: Record<string, boolean> = {};
      for (const key of Object.keys(current)) if (visible.has(key)) next[key] = true;
      return next;
    });
  }, [displayedKeys.join("\0")]);
  useReportSelection(selectedUnits, onSelectionChange);
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
            total={displayedKeys.length}
            selectedForAll={selectedCount}
            canDownload={canDownloadAny}
            onSelectAll={(checked) =>
              setCheckedUnits((current) => applyCheckedKeys(current, displayedKeys, checked))
            }
            onDownload={() => onDownload?.(uniqueUnits(selectedUnits))}
            onClear={() => setCheckedUnits({})}
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
            checked={
              sessionUnits.length > 0 &&
              checkedKeyCount(
                sessionUnits.map((unit) => unitCheckKey(session.id, unit.key)),
                checkedUnits
              ) === sessionUnits.length
            }
            indeterminate={(() => {
              const count = checkedKeyCount(
                sessionUnits.map((unit) => unitCheckKey(session.id, unit.key)),
                checkedUnits
              );
              return count > 0 && count < sessionUnits.length;
            })()}
            onCheck={
              canDownloadAny
                ? (value) =>
                    setCheckedUnits((current) =>
                      applyCheckedKeys(
                        current,
                        sessionUnits.map((unit) => unitCheckKey(session.id, unit.key)),
                        value
                      )
                    )
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
  onSelectionChange,
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
  onSelectionChange?: (units: StorageUnit[]) => void;
}) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(nodes.map((node) => [node.id, false]))
  );
  const [unspecifiedOpen, setUnspecifiedOpen] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(nodes.map((node) => [node.id, false]))
  );
  const [groupByBatch, setGroupByBatch] = useState(true);
  const [batchExpanded, setBatchExpanded] = useState<Record<string, boolean>>({});
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
    units.filter((unit) =>
      specificTagIds(tagIdList(unit.taxonomy_tag_ids?.[scheme]), nodes).some((taggedId) => {
        const tagged = nodes.find((item) => item.id === taggedId);
        return !!tagged && tagged.path.startsWith(node.path);
      })
    );
  const unspecifiedUnitsOf = (node: TaxonomyNode) =>
    units.filter((unit) =>
      specificTagIds(tagIdList(unit.taxonomy_tag_ids?.[scheme]), nodes).includes(node.id)
    );
  const displayedKeys = units.map((unit) => unit.key);
  const selectedUnits = units.filter((unit) => checkedUnits[unit.key]);
  const selectedCount = selectedUnits.length;
  useEffect(() => {
    const visible = new Set(displayedKeys);
    setCheckedUnits((current) => {
      if (!Object.keys(current).some((key) => !visible.has(key))) return current;
      const next: Record<string, boolean> = {};
      for (const key of Object.keys(current)) if (visible.has(key)) next[key] = true;
      return next;
    });
  }, [displayedKeys.join("\0")]);
  useReportSelection(selectedUnits, onSelectionChange);
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
        checked={
          bucket.length > 0 &&
          checkedKeyCount(
            bucket.map((unit) => unit.key),
            checkedUnits
          ) === bucket.length
        }
        indeterminate={(() => {
          const count = checkedKeyCount(
            bucket.map((unit) => unit.key),
            checkedUnits
          );
          return count > 0 && count < bucket.length;
        })()}
        onCheck={
          canDownloadAny
            ? (value) =>
                setCheckedUnits((current) =>
                  applyCheckedKeys(
                    current,
                    bucket.map((unit) => unit.key),
                    value
                  )
                )
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
                  selected={false}
                  title={batchName}
                  meta={<span>{batchUnits.length} 个单元</span>}
                  toggleLabel={bOpen ? "收起批次" : "展开批次"}
                  onSelect={() => onSelect(node.id, true)}
                  onToggle={() =>
                    setBatchExpanded((current) => ({ ...current, [bKey]: !bOpen }))
                  }
                  checked={
                    batchUnits.length > 0 &&
                    checkedKeyCount(
                      batchUnits.map((unit) => unit.key),
                      checkedUnits
                    ) === batchUnits.length
                  }
                  indeterminate={(() => {
                    const count = checkedKeyCount(
                      batchUnits.map((unit) => unit.key),
                      checkedUnits
                    );
                    return count > 0 && count < batchUnits.length;
                  })()}
                  onCheck={
                    canDownloadAny
                      ? (value) =>
                          setCheckedUnits((current) =>
                            applyCheckedKeys(
                              current,
                              batchUnits.map((unit) => unit.key),
                              value
                            )
                          )
                      : undefined
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
          checked={
            nodeUnits.length > 0 &&
            checkedKeyCount(
              nodeUnits.map((unit) => unit.key),
              checkedUnits
            ) === nodeUnits.length
          }
          indeterminate={(() => {
            const count = checkedKeyCount(
              nodeUnits.map((unit) => unit.key),
              checkedUnits
            );
            return count > 0 && count < nodeUnits.length;
          })()}
          onCheck={
            canDownloadAny
              ? (value) =>
                  setCheckedUnits((current) =>
                    applyCheckedKeys(
                      current,
                      nodeUnits.map((unit) => unit.key),
                      value
                    )
                  )
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
            total={displayedKeys.length}
            selectedForAll={selectedCount}
            canDownload={canDownloadAny}
            onSelectAll={(checked) =>
              setCheckedUnits((current) => applyCheckedKeys(current, displayedKeys, checked))
            }
            onDownload={() => onDownload?.(selectedUnits)}
            onClear={() => setCheckedUnits({})}
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
  preset?: { ontology: string; modality: string; motionKind?: MotionKind; robotAcquireMethod?: string };
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
      .storageModels({ quiet: true })
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
      if (ontology === "robot" && modality === "motion" && preset?.robotAcquireMethod) {
        form.set("robot_acquire_method", preset.robotAcquireMethod);
      }
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

type DetailKind = "batch" | "unit" | "file" | "upload_session" | "node" | "selection";

function useReportSelection(
  units: StorageUnit[],
  onSelectionChange?: (units: StorageUnit[]) => void
) {
  const selectionKey = [...new Set(units.map((unit) => unit.key))].join("\0");
  useEffect(() => {
    if (!onSelectionChange) return;
    const seen = new Set<string>();
    onSelectionChange(
      units.filter((unit) => {
        if (seen.has(unit.key)) return false;
        seen.add(unit.key);
        return true;
      })
    );
  }, [selectionKey]);
  useEffect(() => {
    return () => onSelectionChange?.([]);
  }, [onSelectionChange]);
}

type StorageNodeFocus = {
  batchName: string;
  dirPath: string;
  units: StorageUnit[];
};

function schemesForKind(_kind: DetailKind, schemes: TaxonomySchemeDef[]) {
  return schemes;
}

function fillTagBriefs(
  tags: Record<string, { path?: string } | { path?: string }[] | undefined>,
  ids: Record<string, number | number[]> | undefined,
  nodes: TaxonomyNode[]
) {
  const next: Record<string, { id: number; scheme: string; code?: string; name: string; path: string }[]> = {};
  for (const [scheme, brief] of Object.entries(tags)) {
    const schemeNodes = nodes.filter((node) => node.scheme === scheme);
    const list = tagBriefList(brief as never).filter((item) => item.path);
    const keep = new Set(specificTagIds(list.map((item) => item.id), schemeNodes));
    const specific = list.filter((item) => keep.has(item.id));
    if (specific.length) next[scheme] = specific;
  }
  for (const [scheme, id] of Object.entries(ids || {})) {
    if (next[scheme]?.length) continue;
    const found = specificTagIds(tagIdList(id), nodes)
      .map((item) => nodes.find((node) => node.id === item))
      .filter((node): node is TaxonomyNode => !!node)
      .map((node) => ({
        id: node.id,
        scheme: node.scheme,
        code: node.code,
        name: node.name,
        path: node.path,
      }));
    if (found.length) next[scheme] = found;
  }
  return next;
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
  selectedUnits = [],
  selectionBatches = [],
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
  selectedUnits?: StorageUnit[];
  selectionBatches?: StorageBatch[];
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
  const [tagOverrides, setTagOverrides] = useState<{
    key: string;
    ids: Record<string, number[]>;
  }>({ key: "", ids: {} });
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

  const shareUnits =
    kind === "node" && nodeInfo
      ? nodeInfo.units
      : kind === "selection"
        ? selectedUnits
        : null;
  const tagShare: Record<string, { ids: number[]; mixed: boolean }> = {};
  if (shareUnits) {
    for (const scheme of schemes) {
      tagShare[scheme.key] = sharedUnitTag(shareUnits, scheme.key, nodes);
    }
  }
  const ownTagIds = shareUnits
    ? Object.fromEntries(
        Object.entries(tagShare)
          .filter(([, value]) => value.ids.length && !value.mixed)
          .map(([key, value]) => [key, value.ids])
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
  const parentTags =
    kind === "file"
      ? fillTagBriefs(
          detail?.unit_taxonomy_tags || unit?.taxonomy_tags || {},
          detail?.unit_taxonomy_tag_ids || unit?.taxonomy_tag_ids,
          nodes
        )
      : {};
  const visibleSchemes = kind ? schemesForKind(kind, schemes) : [];
  const tagEntityKey = [
    kind || "",
    batch?.name || "",
    unit?.key || "",
    file?.path || "",
    session?.id || "",
    nodeInfo ? `${nodeInfo.batchName}/${nodeInfo.dirPath}` : "",
    kind === "selection" ? selectedUnits.map((item) => item.key).join("\0") : "",
  ].join("\n");
  const tagEdits = tagOverrides.key === tagEntityKey ? tagOverrides.ids : {};
  const shownTagIds = (scheme: string) => {
    const schemeNodes = nodes.filter((node) => node.scheme === scheme);
    if (scheme in tagEdits) return specificTagIds(tagEdits[scheme], schemeNodes);
    if (shareUnits) {
      const share = tagShare[scheme];
      return share?.mixed ? [] : share?.ids || [];
    }
    return specificTagIds(tagIdList(ownTagIds[scheme]), schemeNodes);
  };
  const rememberTags = (scheme: string, ids: number[]) => {
    setTagOverrides({
      key: tagEntityKey,
      ids: { ...tagEdits, [scheme]: ids },
    });
    setSaved(false);
  };
  const changedTagPayload = () => {
    const stored = (ids: number[]) => (ids.length ? ids : null);
    const out: Record<string, number[] | null> = {};
    for (const [scheme, ids] of Object.entries(tagEdits)) {
      if (shareUnits && tagShare[scheme]?.mixed) {
        out[scheme] = stored(ids);
        continue;
      }
      const prev = shareUnits
        ? tagShare[scheme]?.ids || []
        : specificTagIds(
              tagIdList(ownTagIds[scheme]),
              nodes.filter((node) => node.scheme === scheme)
            );
      if (!sameTagIds(ids, prev)) out[scheme] = stored(ids);
    }
    return out;
  };

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
      .storageModels({ quiet: true })
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
              : kind === "selection"
                ? "所选数据单元详情"
                : "详情";

  const saveAnnotation = async () => {
    if (!kind) return;
    const tagChanges = changedTagPayload();
    setSaving(true);
    try {
      if (shareUnits && (kind === "node" || kind === "selection")) {
        if (!Object.keys(tagChanges).length) {
          setSaved(true);
          return;
        }
        const stored = (ids: number[]) => (ids.length ? ids : null);
        const batchOf = (item: StorageUnit) => item.batch || nodeInfo?.batchName || "";
        const previous = shareUnits.map((item) => ({
          batch: batchOf(item),
          name: item.name,
          taxonomy_tag_ids: Object.fromEntries(
            Object.keys(tagChanges).map((scheme) => [
              scheme,
              stored(tagIdList(item.taxonomy_tag_ids?.[scheme])),
            ])
          ),
        }));
        const writeGroups = async (
          rows: {
            batch: string;
            name: string;
            taxonomy_tag_ids: Record<string, number[] | null>;
          }[]
        ) => {
          const byBatch = new Map<string, typeof rows>();
          for (const item of rows) {
            const list = byBatch.get(item.batch) || [];
            list.push(item);
            byBatch.set(item.batch, list);
          }
          for (const [batchName, items] of byBatch) {
            await api.storageUpdateNodeTaxonomy({
              batch: batchName,
              units: items.map((item) => ({
                name: item.name,
                taxonomy_tag_ids: item.taxonomy_tag_ids,
              })),
            });
          }
        };
        await execute({
          label: "保存分类标签",
          do: async () => {
            await writeGroups(
              shareUnits.map((item) => ({
                batch: batchOf(item),
                name: item.name,
                taxonomy_tag_ids: tagChanges,
              }))
            );
            setSaved(true);
            onMessage(`已保存，并应用到 ${shareUnits.length} 个数据单元`);
            await onReload();
          },
          undo: async () => {
            await writeGroups(previous);
            setTagOverrides({ key: "", ids: {} });
          },
        });
        return;
      }
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
      const annotationBody =
        kind === "file" || kind === "upload_session" ? fileAnnotation : { note };
      const prevTags = Object.fromEntries(
        Object.keys(tagChanges).map((scheme) => [
          scheme,
          tagIdList(ownTagIds[scheme]).length ? tagIdList(ownTagIds[scheme]) : null,
        ])
      );
      const body = {
        annotation: annotationBody,
        ...(Object.keys(tagChanges).length ? { taxonomy_tag_ids: tagChanges } : {}),
      };
      const target = metaTarget();
      if (!target) return;
      const prevBody = {
        annotation: { ...annotation },
        ...(Object.keys(tagChanges).length ? { taxonomy_tag_ids: prevTags } : {}),
      };
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
          setTagOverrides({ key: "", ids: {} });
        },
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
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
      {kind === "selection" && (
        <dl className="storage-detail-list">
          <DetailRow label="数据单元" value={`${selectedUnits.length} 个`} />
          <DetailRow
            label="数据批次"
            value={String(new Set(selectedUnits.map((item) => item.batch)).size)}
          />
          <DetailRow
            label="文件数"
            value={String(selectedUnits.reduce((sum, item) => sum + item.file_count, 0))}
          />
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
          {shareUnits && (
            <p className="muted">
              {canEdit
                ? "相同的分类显示具体标签，不一致的显示「多个」。保存后，改过的分类会写到全部所选单元上。"
                : "相同的分类显示具体标签，不一致的显示「多个」。"}
            </p>
          )}
          {kind === "batch" && batch && canEdit && (
            <p className="muted">
              这里的标签会写到该批次下 {batch.unit_count} 个数据单元上，每个单元各自保存
            </p>
          )}
          <TaxonomyTagPicker
            schemes={visibleSchemes}
            nodes={nodes}
            value={Object.fromEntries(
              visibleSchemes.map((scheme) => [scheme.key, shownTagIds(scheme.key)])
            )}
            disabled={saving}
            readOnly={!canEdit}
            canCreate={canEdit && canCreate}
            onNodesReload={onNodesReload}
            placeholders={Object.fromEntries(
              visibleSchemes
                .filter((scheme) => tagShare[scheme.key]?.mixed && !(scheme.key in tagEdits))
                .map((scheme) => [scheme.key, "多个"])
            )}
            inherited={Object.fromEntries(
              visibleSchemes
                .filter(
                  (scheme) =>
                    !tagShare[scheme.key]?.mixed && !shownTagIds(scheme.key).length
                )
                .map((scheme) => [
                  scheme.key,
                  (parentTags[scheme.key] || []).map((item) => item.name).join("、"),
                ])
                .filter(([, text]) => text)
            )}
            onChange={rememberTags}
          />
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
          {canEdit ? (
            <>
              {kind !== "node" && kind !== "selection" && (
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
              )}
              <button type="button" disabled={saving} onClick={() => void saveAnnotation()}>
                {saving ? "保存中…" : saved ? "已保存" : "保存标签"}
              </button>
            </>
          ) : kind !== "node" && kind !== "selection" ? (
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

function downloadKindKey(
  ontology: string,
  modality: string,
  format = "",
  motionKind = ""
) {
  return `${ontology}:${modality}:${motionKind}:${format}`;
}

function fileMotionKind(file: StorageFile) {
  return file.modality === "motion" ? resolveMotionKind(file.annotation?.motion_kind) : "";
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

const ROBOT_ACQUIRE_METHODS = ["omniretarget", "umr", "gmr", "frax"] as const;

function fileRobotAcquireMethod(file: StorageFile) {
  const stored = String(file.robot_acquire_method || "").trim();
  if ((ROBOT_ACQUIRE_METHODS as readonly string[]).includes(stored)) return stored;
  const parts = file.path.split("/");
  const motion = parts.indexOf("motion");
  const next = motion >= 0 ? parts[motion + 1] : "";
  if ((ROBOT_ACQUIRE_METHODS as readonly string[]).includes(next)) return next;
  return "omniretarget";
}

type DownloadConfirm = {
  kinds: { ontology: string; modality: string; format: string; motion_kind?: string }[];
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
    files.map((file) =>
      downloadKindKey(file.ontology, file.modality, fileFormatOf(file), fileMotionKind(file))
    )
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
    if (
      !checked[
        downloadKindKey(
          file.ontology,
          file.modality,
          fileFormatOf(file),
          fileMotionKind(file)
        )
      ]
    ) {
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
      ...(file.modality === "motion" ? { motion_kind: fileMotionKind(file) } : {}),
    }))
    .filter((kind, index, list) => {
      const key = downloadKindKey(
        kind.ontology,
        kind.modality,
        kind.format,
        kind.motion_kind || ""
      );
      return (
        list.findIndex(
          (item) =>
            downloadKindKey(item.ontology, item.modality, item.format, item.motion_kind || "") ===
            key
        ) === index
      );
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
              {Object.entries(MODALITY_LABEL).flatMap(([modalityKey, modalityLabel]) =>
                modalityKey === "motion"
                  ? MOTION_KIND_OPTIONS.map(([motionKind, kindLabel]) => ({
                      key: `${modalityKey}:${motionKind}`,
                      label: kindLabel,
                      motionKind,
                    }))
                  : [{ key: modalityKey, label: modalityLabel, motionKind: "" }]
              ).map(({ key: rowKey, label, motionKind }) => {
                const modality = rowKey.startsWith("motion:") ? "motion" : rowKey;
                const rowFiles = files.filter(
                  (file) =>
                    file.ontology === ontology &&
                    file.modality === modality &&
                    (!motionKind || fileMotionKind(file) === motionKind)
                );
                const formats = [...new Set(rowFiles.map((file) => fileFormatOf(file)))].sort();
                const formatKeys = formats.map((format) =>
                  downloadKindKey(ontology, modality, format, motionKind)
                );
                const enabled = rowFiles.length > 0;
                const selectedFormats = formatKeys.filter((key) => checked[key]);
                const allOn = enabled && selectedFormats.length === formatKeys.length;
                const someOn = selectedFormats.length > 0;
                return (
                  <div
                    key={rowKey}
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
                          const key = downloadKindKey(ontology, modality, format, motionKind);
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
  fileVersions,
  selectedFile,
  onFile,
  canUpload,
  onQuickUpload,
  showEmpty = true,
}: {
  unit: StorageUnit;
  fileVersions?: FileVersionInfo[];
  selectedFile: StorageFile | null;
  onFile: (file: StorageFile) => void;
  canUpload: boolean;
  onQuickUpload: (preset: {
    ontology: string;
    modality: string;
    motionKind?: MotionKind;
    robotAcquireMethod?: string;
  }) => void;
  showEmpty?: boolean;
}) {
  const preview = usePreview();
  const versions = useMemo(
    () => normalizeFileVersions(fileVersions, unit.files),
    [fileVersions, unit.files]
  );
  const latest = latestVersionName(versions);
  const [selectedVersion, setSelectedVersion] = useState(latest);
  const pickedRef = useRef(false);
  useEffect(() => {
    pickedRef.current = false;
    setSelectedVersion(latest);
  }, [unit.key]);
  useEffect(() => {
    if (!pickedRef.current) setSelectedVersion(latest);
  }, [latest, unit.key]);
  const activeVersion = versions.some((item) => item.name === selectedVersion)
    ? selectedVersion
    : latest;
  const visibleFiles = useMemo(
    () => filesForVersion(unit.files, versions, activeVersion),
    [unit.files, versions, activeVersion]
  );
  const robotFiles = visibleFiles.filter((f) => f.ontology === "robot");
  const robotStyles = [
    ...new Set(
      robotFiles.map((f) => String(f.robot_style || f.annotation?.robot_style || "").trim()).filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b, "zh"));
  const [robotStyle, setRobotStyle] = useState(robotStyles[0] || "");
  const [robotMethod, setRobotMethod] = useState("omniretarget");
  const activeStyle = robotStyles.includes(robotStyle) ? robotStyle : robotStyles[0] || "";
  const activeMethod = (ROBOT_ACQUIRE_METHODS as readonly string[]).includes(robotMethod)
    ? robotMethod
    : "omniretarget";
  const styleFilter = (file: StorageFile) => {
    if (file.ontology !== "robot") return true;
    if (!robotStyles.length) return true;
    const style = String(file.robot_style || file.annotation?.robot_style || "").trim();
    return style === activeStyle;
  };
  const methodFilter = (file: StorageFile) => {
    if (file.ontology !== "robot") return true;
    return fileRobotAcquireMethod(file) === activeMethod;
  };

  return (
    <div className="storage-unit-matrix">
      <div className="storage-file-version-bar">
        <label>
          文件版本
          <select
            value={activeVersion}
            onChange={(event) => {
              pickedRef.current = true;
              setSelectedVersion(event.target.value);
            }}
          >
            {versions.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
                {item.name === latest ? "（最新）" : ""}
              </option>
            ))}
          </select>
        </label>
        <span className="storage-file-version-note">
          {activeVersion === ORIGINAL_FILE_VERSION
            ? "正在查看最初上传的文件"
            : "没有出现在这个版本里的文件，沿用更早的版本"}
        </span>
      </div>
      {(["human", "robot"] as const).map((ontology) => {
        const hasFiles = visibleFiles.some((file) => file.ontology === ontology);
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
          {ontology === "robot" && (
            <div className="storage-robot-style-tabs">
              {ROBOT_ACQUIRE_METHODS.map((method) => (
                <button
                  key={method}
                  type="button"
                  className={`storage-robot-style-tab ${method === activeMethod ? "active" : "secondary"}`}
                  onClick={() => setRobotMethod(method)}
                >
                  {method}
                </button>
              ))}
            </div>
          )}
          {matrixRows().map(({ key, modality, motionKind, label }) => {
            const files = visibleFiles.filter(
              (f) =>
                f.ontology === ontology &&
                f.modality === modality &&
                (!motionKind || resolveMotionKind(f.annotation?.motion_kind) === motionKind) &&
                styleFilter(f) &&
                methodFilter(f)
            );
            if (!showEmpty && !files.length) return null;
            return (
              <div className="storage-modality-row" key={key}>
                <div
                  className={`storage-modality-name ${files.length ? "" : "missing"}`}
                  title={
                    files.length && !preview.contrastMode ? `查看${label}文件信息` : undefined
                  }
                  onClick={() => {
                    if (preview.contrastMode) return;
                    if (files.length) onFile(files[files.length - 1]);
                  }}
                  style={files.length && !preview.contrastMode ? { cursor: "pointer" } : undefined}
                >
                  {label}
                </div>
                <div className="storage-file-pills">
                  {files.map((file) => {
                    const versionName = fileVersionName(file);
                    const inherited = versionName !== activeVersion;
                    return (
                    <button
                      type="button"
                      key={file.id}
                      className={selectedFile?.id === file.id ? "active" : "secondary"}
                      title={inherited ? `${file.path}（沿用${versionName}）` : file.path}
                      onClick={() => onFile(file)}
                    >
                      {file.channel ? `${file.channel}/` : ""}
                      {file.format}
                      {inherited && (
                        <span className="storage-file-uploader">沿用{versionName}</span>
                      )}
                      <span className="storage-file-uploader">
                        {file.uploader?.username || "未知用户"}
                      </span>
                    </button>
                    );
                  })}
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
                      if (!preview.contrastMode && last && selectedFile?.id !== last.id) {
                        onFile(last);
                        return;
                      }
                      onQuickUpload({
                        ontology,
                        modality,
                        motionKind,
                        robotAcquireMethod: ontology === "robot" ? activeMethod : undefined,
                      });
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

const NAME_COLLATOR = new Intl.Collator("zh", { numeric: true, sensitivity: "base" });

function compareNames(left: string, right: string) {
  return NAME_COLLATOR.compare(left, right);
}

type SortTimes = { created: number; uploaded: number; modified: number };
const sortTimesCache = new WeakMap<object, SortTimes>();

function entitySortTimes(item: {
  created_at?: string;
  uploaded_at?: string;
  modified_at?: string;
}): SortTimes {
  const cached = sortTimesCache.get(item);
  if (cached) return cached;
  const times = {
    created: parseSortTime(item.created_at),
    uploaded: parseSortTime(item.uploaded_at),
    modified: parseSortTime(item.modified_at),
  };
  sortTimesCache.set(item, times);
  return times;
}

function sortStorageUnits(units: StorageUnit[], sortMode: string) {
  return [...units].sort((a, b) =>
    compareByStorageSort(a, b, sortMode, (item) => item.name, entitySortTimes)
  );
}

function sortBatchNames(names: string[], units: StorageUnit[], sortMode: string) {
  const rows = new Map<string, { name: string; created_at: string; uploaded_at: string; modified_at: string }>();
  for (const name of names) rows.set(name, { name, created_at: "", uploaded_at: "", modified_at: "" });
  for (const unit of units) {
    const row = rows.get(unit.batch);
    if (!row) continue;
    if (unit.created_at && (!row.created_at || unit.created_at < row.created_at)) row.created_at = unit.created_at;
    if (unit.uploaded_at && unit.uploaded_at > row.uploaded_at) row.uploaded_at = unit.uploaded_at;
    if (unit.modified_at && unit.modified_at > row.modified_at) row.modified_at = unit.modified_at;
  }
  return [...names].sort((left, right) =>
    compareByStorageSort(
      rows.get(left)!,
      rows.get(right)!,
      sortMode,
      (item) => item.name,
      entitySortTimes
    )
  );
}

function nodeCovers(ancestor: TaxonomyNode, tag: TaxonomyNode) {
  if (ancestor.id === tag.id) return true;
  const base = ancestor.path.endsWith("/") ? ancestor.path : `${ancestor.path}/`;
  return tag.path === ancestor.path || tag.path.startsWith(base);
}

function unitMatchesSchemeFilters(
  unit: StorageUnit,
  batch: { taxonomy_tag_ids?: Record<string, number | number[]> } | undefined,
  filters: Record<string, number[]>,
  nodes: TaxonomyNode[]
) {
  for (const [scheme, ids] of Object.entries(filters)) {
    if (!ids.length) continue;
    const schemeNodes = nodes.filter((node) => node.scheme === scheme);
    const tagIds = specificTagIds(tagIdList(unit.taxonomy_tag_ids?.[scheme]), schemeNodes);
    const tags = schemeNodes.filter((node) => tagIds.includes(node.id));
    const selectedIds = specificTagIds(ids, schemeNodes);
    const selected = schemeNodes.filter((node) => selectedIds.includes(node.id));
    if (!tags.length || !tags.some((tag) => selected.some((node) => nodeCovers(node, tag)))) {
      return false;
    }
  }
  return true;
}

type FacetNode = { id: string; name: string; children?: FacetNode[] };

function fileModalityKey(file: StorageFile) {
  return file.modality === "motion"
    ? `motion:${resolveMotionKind(file.annotation?.motion_kind)}`
    : file.modality;
}

function fileMatchesSubject(file: StorageFile, selected: string[]) {
  const ontology = file.ontology;
  const instance =
    ontology === "robot"
      ? String(file.robot_style || file.annotation?.robot_style || "")
      : String(file.annotation?.human_model || "");
  const version =
    ontology === "robot"
      ? String(file.annotation?.robot_version || "")
      : String(file.annotation?.human_model_file || "");
  return selected.some((id) => {
    const [onto, inst, ver] = id.split("|");
    if (onto !== ontology) return false;
    if (!inst) return true;
    if (inst !== instance) return false;
    if (!ver) return true;
    return ver === version || version.endsWith(ver) || ver.endsWith(version);
  });
}

const NARROWING_FILTERS = ["subject", "format", "modality"] as const;

function narrowingActive(checks: Record<string, string[]>) {
  return NARROWING_FILTERS.some((key) => (checks[key] || []).length > 0);
}

function fileMatchesNarrowing(file: StorageFile, checks: Record<string, string[]>) {
  for (const key of NARROWING_FILTERS) {
    const ids = checks[key] || [];
    if (!ids.length) continue;
    if (key === "subject" && !fileMatchesSubject(file, ids)) return false;
    if (key === "format" && !ids.some((id) => id.toLowerCase() === (file.format || "").toLowerCase())) {
      return false;
    }
    if (key === "modality" && !ids.includes(fileModalityKey(file))) return false;
  }
  return true;
}

function withVisibleFiles(unit: StorageUnit, checks: Record<string, string[]>): StorageUnit {
  if (!narrowingActive(checks)) return unit;
  const files = unit.files.filter((file) => fileMatchesNarrowing(file, checks));
  if (files.length === unit.files.length) return unit;
  return { ...unit, files, file_count: files.length };
}

function unitMatchesExtraFilters(unit: StorageUnit, checks: Record<string, string[]>) {
  for (const [key, ids] of Object.entries(checks)) {
    if (!ids.length) continue;
    if (key === "uploader") {
      const have = new Set<string>();
      unit.uploaders.forEach((item) => have.add(String(item.id)));
      unit.files.forEach((file) => {
        if (file.uploader) have.add(String(file.uploader.id));
      });
      if (!ids.some((id) => have.has(id))) return false;
    } else if (key === "format") {
      const have = new Set(unit.files.map((file) => (file.format || "").toLowerCase()));
      if (!ids.some((id) => have.has(id.toLowerCase()))) return false;
    } else if (key === "modality") {
      const have = new Set(unit.files.map(fileModalityKey));
      if (!ids.some((id) => have.has(id))) return false;
    } else if (key === "subject") {
      if (!unit.files.some((file) => fileMatchesSubject(file, ids))) return false;
    }
  }
  return true;
}

function subjectFacetNodes(instances: ModelInstance[]): FacetNode[] {
  const branch = (ontology: "human" | "robot", label: string): FacetNode => ({
    id: ontology,
    name: label,
    children: instances
      .filter((item) => item.ontology === ontology)
      .map((item) => {
        const versions =
          ontology === "robot" ? robotDescriptionVersions(item) : humanModelFiles(item);
        return {
          id: `${ontology}|${item.name}`,
          name: item.name,
          children: versions.map((file) => ({
            id: `${ontology}|${item.name}|${file.relative_path}`,
            name: file.name,
          })),
        };
      }),
  });
  return [branch("human", "人体"), branch("robot", "机器人")];
}

function facetLinks(
  nodes: FacetNode[],
  parent: string | null = null
): { id: string; parent_id: string | null }[] {
  const out: { id: string; parent_id: string | null }[] = [];
  nodes.forEach((node) => {
    out.push({ id: node.id, parent_id: parent });
    if (node.children?.length) out.push(...facetLinks(node.children, node.id));
  });
  return out;
}

function StringCheckTree({
  nodes,
  checked,
  onToggle,
}: {
  nodes: FacetNode[];
  checked: string[];
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const links = facetLinks(nodes);
  const children = childrenByParent(links);
  const picked = new Set(specificSelection(checked, links));
  const renderNode = (node: FacetNode, depth: number) => {
    const kids = node.children || [];
    const expanded = open[node.id] === true;
    return (
      <div key={node.id}>
        <label className="facet-check" style={{ paddingLeft: depth * 16 }}>
          {kids.length ? (
            <button
              type="button"
              className="facet-twist"
              aria-label={expanded ? "收起" : "展开"}
              onClick={(event) => {
                event.preventDefault();
                setOpen((current) => ({ ...current, [node.id]: !expanded }));
              }}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="facet-twist" />
          )}
          <input
            type="checkbox"
            checked={selectionCovers(node.id, picked, children)}
            onChange={() => onToggle(node.id)}
          />
          <span>{node.name}</span>
        </label>
        {kids.length > 0 && expanded && kids.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };
  if (!nodes.length) return <div className="muted">暂无可选项</div>;
  return <div className="facet-tree">{nodes.map((node) => renderNode(node, 0))}</div>;
}

function facetNameSummary(ids: string[], nodes: FacetNode[]) {
  const names = specificSelection(ids, facetLinks(nodes))
    .map((id) => {
      const walk = (list: FacetNode[]): string | undefined => {
        for (const node of list) {
          if (node.id === id) return node.name;
          const nested = node.children ? walk(node.children) : undefined;
          if (nested) return nested;
        }
        return undefined;
      };
      return walk(nodes);
    })
    .filter((name): name is string => !!name);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}

function filterSummary(ids: number[], nodes: TaxonomyNode[]) {
  const names = specificTagIds(ids, nodes)
    .map((id) => nodes.find((node) => node.id === id)?.name)
    .filter((name): name is string => !!name);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}

function FilterCheckTree({
  nodes,
  checked,
  onToggle,
}: {
  nodes: TaxonomyNode[];
  checked: number[];
  onToggle: (id: number) => void;
}) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const children = childrenByParent(nodes);
  const picked = new Set(specificTagIds(checked, nodes));
  children.forEach((list) =>
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "zh"))
  );
  const roots = children.get(null) || [];
  const top = roots.length === 1 ? children.get(roots[0].id) || [] : roots;

  const renderNode = (node: TaxonomyNode, depth: number) => {
    const kids = children.get(node.id) || [];
    const expanded = open[node.id] === true;
    return (
      <div key={node.id}>
        <label className="facet-check" style={{ paddingLeft: depth * 16 }}>
          {kids.length ? (
            <button
              type="button"
              className="facet-twist"
              aria-label={expanded ? "收起" : "展开"}
              onClick={(event) => {
                event.preventDefault();
                setOpen((current) => ({ ...current, [node.id]: !expanded }));
              }}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="facet-twist" />
          )}
          <input
            type="checkbox"
            checked={selectionCovers(node.id, picked, children)}
            onChange={() => onToggle(node.id)}
          />
          <span>{node.name}</span>
        </label>
        {kids.length > 0 && expanded && kids.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  if (!nodes.length) return <div className="muted">该维度暂无分类</div>;
  return <div className="facet-tree">{top.map((node) => renderNode(node, 0))}</div>;
}

function BrowsePicker({
  label,
  value,
  open,
  options,
  onToggle,
  onPick,
}: {
  label: string;
  value: string;
  open: boolean;
  options: { id: string; label: string }[];
  onToggle: () => void;
  onPick: (id: string) => void;
}) {
  return (
    <div className={`browse-picker${open ? " is-open" : ""}`}>
      <button type="button" className="browse-picker-head" onClick={onToggle}>
        <span className="browse-picker-label">{label}</span>
        <span className="browse-picker-value">{value}</span>
        <span className="browse-picker-chevron">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="browse-picker-menu">
          {options.map((option) => (
            <button
              type="button"
              key={option.id}
              className={`browse-picker-option${option.label === value ? " is-current" : ""}`}
              onClick={() => onPick(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function compareByStorageSort<T>(
  left: T,
  right: T,
  sortMode: string,
  nameOf: (item: T) => string,
  timesOf: (item: T) => { created: number; uploaded: number; modified: number }
) {
  const field =
    sortMode === "created_desc" || sortMode === "created_asc"
      ? "created"
      : sortMode === "uploaded_desc" || sortMode === "uploaded_asc"
        ? "uploaded"
        : sortMode === "modified_desc" || sortMode === "modified_asc"
          ? "modified"
          : null;
  if (!field) {
    const nameCmp = compareNames(nameOf(left), nameOf(right));
    return sortMode === "name_desc" ? -nameCmp : nameCmp;
  }
  const a = timesOf(left)[field];
  const b = timesOf(right)[field];
  const primary = sortMode.endsWith("_desc") ? b - a : a - b;
  return primary || compareNames(nameOf(left), nameOf(right));
}

function omitStorageRecords(
  overview: StorageOverview,
  removedPaths: Set<string>,
  removedBatches: Set<string>
): StorageOverview {
  const trimUnit = (unit: StorageUnit): StorageUnit | null => {
    if (removedBatches.has(unit.batch)) return null;
    const files = unit.files.filter((file) => !removedPaths.has(file.path));
    if (!files.length) return null;
    if (files.length === unit.files.length) return unit;
    return { ...unit, files, file_count: files.length };
  };
  const units = overview.units.flatMap((unit) => {
    const next = trimUnit(unit);
    return next ? [next] : [];
  });
  const batches = overview.batches.flatMap((batch) => {
    if (removedBatches.has(batch.name)) return [];
    const nextUnits = batch.units.flatMap((unit) => {
      const next = trimUnit(unit);
      return next ? [next] : [];
    });
    if (!nextUnits.length) return [];
    return [
      {
        ...batch,
        units: nextUnits,
        unit_count: nextUnits.length,
        file_count: nextUnits.reduce((sum, unit) => sum + unit.file_count, 0),
      },
    ];
  });
  const sessions = (overview.upload_sessions || []).flatMap((session) => {
    const paths = session.paths.filter((path) => !removedPaths.has(path));
    if (paths.length === session.paths.length) return [session];
    if (!paths.length) return [];
    return [{ ...session, paths, file_count: paths.length }];
  });
  return {
    ...overview,
    batches,
    units,
    files: overview.files.filter(
      (file) => !removedPaths.has(file.path) && !removedBatches.has(file.batch)
    ),
    upload_sessions: sessions,
  };
}

export function StorageWorkspace({
  variant = "browse",
}: {
  variant?: WorkspaceVariant;
}) {
  const { user, hasPerm, isAdmin } = useAuth();
  const { execute } = useUndo();
  const [data, setData] = useState<StorageOverview | null>(null);
  const [classificationUnits, setClassificationUnits] = useState<StorageUnit[]>([]);
  const [schemes, setSchemes] = useState<TaxonomySchemeDef[]>([]);
  const [nodes, setNodes] = useState<TaxonomyNode[]>([]);
  const [mode, setMode] = useState("folder");
  const [pickedKeys, setPickedKeys] = useState<string[]>([]);
  const reportPickedUnits = useCallback((units: StorageUnit[]) => {
    setPickedKeys((current) => {
      const next = units.map((unit) => unit.key);
      if (current.length === next.length && current.every((key, index) => key === next[index])) {
        return current;
      }
      return next;
    });
  }, []);
  const [openFilterScheme, setOpenFilterScheme] = useState<string | null>(null);
  const [filterNodeIds, setFilterNodeIds] = useState<Record<string, number[]>>({});
  const [extraChecks, setExtraChecks] = useState<Record<string, string[]>>({});
  const [modelInstances, setModelInstances] = useState<ModelInstance[]>([]);
  const [browseMenu, setBrowseMenu] = useState<"standard" | "sort" | null>(null);
  const [leftPaneWidth, setLeftPaneWidth] = useStoredNumber("hub-pane-left", 320);
  const [rightPaneWidth, setRightPaneWidth] = useStoredNumber("hub-pane-right", 320);
  const [previewHeight, setPreviewHeight] = useStoredNumber("hub-pane-preview", 520);
  useEffect(() => {
    if (!browseMenu && !openFilterScheme) return;
    const onPointerDown = (event: MouseEvent) => {
      const node = event.target instanceof Element ? event.target : null;
      if (browseMenu && !node?.closest(".browse-picker")) setBrowseMenu(null);
      if (openFilterScheme && !node?.closest(".facet-item")) setOpenFilterScheme(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [browseMenu, openFilterScheme]);
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
  const selectedKeyRef = useRef(selectedKey);
  const focusRef = useRef(focus);
  const playingRef = useRef(preview.activeFile);
  selectedKeyRef.current = selectedKey;
  focusRef.current = focus;
  playingRef.current = preview.activeFile;
  const [quickPreset, setQuickPreset] = useState<{
    ontology: string;
    modality: string;
    motionKind?: MotionKind;
    robotAcquireMethod?: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [extraBatches, setExtraBatches] = useState<string[]>([]);
  const [downloadPick, setDownloadPick] = useState<{
    batches: StorageBatch[];
    units: StorageUnit[];
  } | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [retargetUnits, setRetargetUnits] = useState<StorageUnit[] | null>(null);
  const [retargetRobots, setRetargetRobots] = useState<string[]>([]);
  const [retargetOrder, setRetargetOrder] = useState<string[]>([]);
  const [retargetBusy, setRetargetBusy] = useState(false);
  const loadSequence = useRef(0);
  const pendingSelectBatch = useRef<string | null>(null);
  const pendingSelectSession = useRef<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [uploadTagIds, setUploadTagIds] = useState<Record<string, number[]>>({});

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
        include_empty: variant === "manage" || hasPerm("manage_data") ? 1 : undefined,
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
      } else {
        const currentKey = selectedKeyRef.current;
        const currentFocus = focusRef.current;
        const playing = playingRef.current;
        const unitStillThere = !!currentKey && overview.units.some((u) => u.key === currentKey);
        const followPlaying = () => {
          if (!playing) return false;
          setSelectedKey(`${playing.batch}::${playing.unit_name}`);
          setFocus({ kind: "file", key: playing.path });
          return true;
        };
        const selectFirstUnit = () => {
          const first = overview.units[0];
          setSelectedKey(first?.key || null);
          setFocus(first ? { kind: "unit", key: first.key } : null);
        };
        if (keepSelection && unitStillThere) {
          // 索引刷新时保留当前详情。load 闭包里的 selectedKey 经常是过期的空值。
        } else if (keepSelection && currentFocus && currentFocus.kind !== "unit") {
          const focusAlive =
            currentFocus.kind === "batch"
              ? overview.batches.some((batch) => batch.name === currentFocus.key)
              : currentFocus.kind === "upload_session"
                ? (overview.upload_sessions || []).some((item) => item.id === currentFocus.key)
                : currentFocus.kind === "file"
                  ? overview.units.some((unit) => unit.files.some((file) => file.path === currentFocus.key)) ||
                    overview.files.some((file) => file.path === currentFocus.key) ||
                    playing?.path === currentFocus.key
                  : true;
          if (!focusAlive && !followPlaying()) selectFirstUnit();
        } else if (keepSelection && followPlaying()) {
          // 页面重新进入时，预览还在播上一个文件，详情跟播放内容走，而不是列表第一项。
        } else if (!keepSelection || !unitStillThere) {
          selectFirstUnit();
        }
      }
    } catch (e) {
      if (requestId !== loadSequence.current) return;
      setError(e instanceof Error ? e.message : "加载失败");
    }
  };

  useEffect(() => {
    let cancelled = false;
    const loadTaxonomies = () => {
      Promise.all([api.listTaxonomySchemes({ quiet: true }), api.listTaxonomies(undefined, { quiet: true })])
        .then(([schemeRows, nodeRows]) => {
          if (cancelled) return;
          setSchemes(
            [...schemeRows].sort(
              (a, b) =>
                (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
                a.key.localeCompare(b.key)
            )
          );
          setNodes(nodeRows);
        })
        .catch(() => undefined);
    };
    loadTaxonomies();
    const onFocus = () => loadTaxonomies();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    if (variant === "upload") return;
    let cancelled = false;
    api
      .storageModels({ quiet: true })
      .then((overview) => {
        if (!cancelled) setModelInstances(overview.instances);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [variant]);

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

  const displayData = useMemo(() => {
    if (!data) return null;
    const compareUnits = (a: StorageUnit, b: StorageUnit) =>
      compareByStorageSort(a, b, sortMode, (item) => item.name, entitySortTimes);
    const visibleCache = new Map<string, StorageUnit>();
    const showUnit = (unit: StorageUnit) => {
      const cached = visibleCache.get(unit.key);
      if (cached) return cached;
      const next = withVisibleFiles(unit, extraChecks);
      visibleCache.set(unit.key, next);
      return next;
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
    const storedUnitCount = new Map(data.batches.map((batch) => [batch.name, batch.unit_count]));
    const batches = [...data.batches, ...placeholderBatches]
      .map((batch) => {
        const units = batch.units
          .filter(
            (unit) =>
              unitMatchesSchemeFilters(unit, batch, filterNodeIds, nodes) &&
              unitMatchesExtraFilters(unit, extraChecks)
          )
          .map(showUnit)
          .sort(compareUnits);
        return {
          ...batch,
          units,
          unit_count: units.length,
          file_count: units.reduce((sum, unit) => sum + unit.file_count, 0),
        };
      })
      .filter(
        (batch) =>
          batch.units.length > 0 ||
          extraBatches.includes(batch.name) ||
          (storedUnitCount.get(batch.name) ?? 0) === 0
      )
      .sort((a, b) =>
        compareByStorageSort(a, b, sortMode, (item) => item.name, entitySortTimes)
      );
    const batchByName = new Map(data.batches.map((item) => [item.name, item]));
    return { ...data, batches, units: data.units.flatMap((unit) => {
      const batch = batchByName.get(unit.batch);
      const matched =
        unitMatchesSchemeFilters(unit, batch, filterNodeIds, nodes) &&
        unitMatchesExtraFilters(unit, extraChecks);
      return matched ? [showUnit(unit)] : [];
    }) };
  }, [data, extraBatches, sortMode, filterNodeIds, nodes, extraChecks]);

  const selected = useMemo(
    () =>
      displayData?.units.find((unit) => unit.key === selectedKey) ||
      data?.units.find((unit) => unit.key === selectedKey) ||
      null,
    [displayData, data, selectedKey]
  );

  const pickedUnits = useMemo(() => {
    if (!pickedKeys.length) return [];
    const byKey = new Map<string, StorageUnit>();
    for (const unit of data?.units || []) byKey.set(unit.key, unit);
    for (const batch of displayData?.batches || []) {
      for (const unit of batch.units) byKey.set(unit.key, unit);
    }
    return pickedKeys.flatMap((key) => {
      const unit = byKey.get(key);
      return unit ? [unit] : [];
    });
  }, [pickedKeys, displayData, data]);

  const currentNodes = nodes.filter((node) => node.scheme === mode);

  const reloadTaxonomies = async () => {
    setNodes(await api.listTaxonomies(undefined, { quiet: true }));
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

  const latestFilesOf = (unit: StorageUnit) => {
    const listed = data?.batches.find((batch) => batch.name === unit.batch)?.file_versions;
    const versions = normalizeFileVersions(listed, unit.files);
    return filesForVersion(unit.files, versions, latestVersionName(versions));
  };

  const selectUnit = (unit: StorageUnit) => {
    setSelectedKey(unit.key);
    if (preview.contrastMode) {
      setFocus({ kind: "unit", key: unit.key });
      return;
    }
    previewUnitFile(unit, false);
    if (!pickPreviewFile(latestFilesOf(unit), lastVisualizedRef.current)) {
      setFocus({ kind: "unit", key: unit.key });
    }
  };

  const previewUnitFile = (unit: StorageUnit, keepFocus: boolean) => {
    const file = pickPreviewFile(latestFilesOf(unit), lastVisualizedRef.current);
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
      latestFilesOf(unit).some((file) => isVisualizableStorageFile(file))
    );
    if (!playable.length) return;
    const unit = playable[Math.floor(Math.random() * playable.length)];
    previewUnitFile(unit, keepFocus);
  };

  const unitsForTaxonomyNode = (id: number, exact: boolean) => {
    const node = nodes.find((item) => item.id === id);
    if (!node) return [];
    const schemeNodes = nodes.filter((item) => item.scheme === node.scheme);
    return classificationUnits.filter((unit) =>
      specificTagIds(tagIdList(unit.taxonomy_tag_ids?.[node.scheme]), schemeNodes).some(
        (taggedId) => {
          if (exact) return taggedId === node.id;
          const tagged = nodes.find((item) => item.id === taggedId);
          return !!tagged && tagged.path.startsWith(node.path);
        }
      )
    );
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
  const canAnnotatePicked =
    canAnnotate ||
    (!!user &&
      pickedUnits.length > 0 &&
      pickedUnits.every((unit) => unitOwnedBy(unit, user.id)));

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

  useEffect(() => {
    const bits: string[] = [];
    const tree =
      mode === "folder"
        ? "存储结构"
        : mode === "uploader"
          ? "按上传用户"
          : mode === "upload_order"
            ? "按上传记录"
            : `${taxonomySchemeLabel(mode, schemes)}分类`;
    bits.push(tree);
    const keyword = query.trim();
    if (keyword) bits.push(`搜索「${keyword.slice(0, 20)}」`);
    const filters: string[] = [];
    for (const [scheme, ids] of Object.entries(filterNodeIds)) {
      if (!ids.length) continue;
      const summary = filterSummary(ids, nodes);
      if (summary) filters.push(summary);
    }
    for (const [key, ids] of Object.entries(extraChecks)) {
      if (!ids.length) continue;
      if (key === "uploader") {
        const names = ids
          .map((id) => data?.uploaders.find((item) => String(item.id) === id)?.username)
          .filter((name): name is string => !!name);
        if (names.length === 1) filters.push(names[0]);
        else if (names.length) filters.push(`${names[0]} +${names.length - 1}`);
      } else if (key === "modality") {
        const raw = ids[0];
        const name = raw.startsWith("motion:")
          ? motionKindLabel(raw.slice("motion:".length))
          : MODALITY_LABEL[raw] || raw;
        filters.push(ids.length > 1 ? `${name} +${ids.length - 1}` : name);
      } else {
        filters.push(ids.length > 1 ? `${ids[0]} +${ids.length - 1}` : ids[0]);
      }
    }
    if (filters.length) bits.push(`筛选 ${filters.slice(0, 3).join("、")}`);
    if (pickedUnits.length) bits.push(`勾选 ${pickedUnits.length} 个单元`);
    else if (selected) bits.push(`查看「${selected.name.slice(0, 28)}」`);
    else if (focusedBatch) bits.push(`查看批次 ${focusedBatch.name}`);
    else if (focusedFile) bits.push(`查看文件 ${focusedFile.name}`);
    setPresenceDetail(bits.join(" · "));
    return () => setPresenceDetail("");
  }, [
    mode,
    schemes,
    query,
    filterNodeIds,
    nodes,
    extraChecks,
    data,
    pickedUnits,
    selected,
    focusedBatch,
    focusedFile,
  ]);

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

  const retargetItems = (units: StorageUnit[]) => {
    const byBatch = new Map<string, StorageUnit[]>();
    for (const unit of units) {
      const list = byBatch.get(unit.batch) || [];
      list.push(unit);
      byBatch.set(unit.batch, list);
    }
    return [...byBatch.entries()].map(([batch, picked]) => {
      const all = displayData?.batches.find((item) => item.name === batch);
      if (all && picked.length >= all.units.length) return { batch, units: [] as string[] };
      return { batch, units: picked.map((unit) => unit.name) };
    });
  };

  const handlePrioritize = async (units: StorageUnit[]) => {
    const unique = uniqueUnits(units);
    if (!unique.length) {
      setError("没有可优先的数据单元");
      return;
    }
    setError("");
    try {
      const cfg = await api.retargetPriority();
      setRetargetRobots(cfg.robots || []);
      setRetargetOrder([]);
      setRetargetUnits(unique);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取机器人款式失败");
    }
  };

  const confirmPrioritize = async () => {
    if (!retargetUnits?.length) return;
    if (!retargetOrder.length) {
      setError("请至少选择一台机器人");
      return;
    }
    const items = retargetItems(retargetUnits);
    setRetargetBusy(true);
    try {
      await api.pinRetarget(items, retargetOrder);
      const label =
        items.length === 1 && items[0].units.length === 0
          ? `批次「${items[0].batch}」`
          : retargetUnits.length === 1
            ? `「${retargetUnits[0].name}」`
            : `${retargetUnits.length} 个数据单元`;
      setMessage(
        `已把${label}加为最上面的一档。重定向顺序：${retargetOrder.join(" → ")}。当前这一波结束后会按这个顺序扫描。`
      );
      setError("");
      setRetargetUnits(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "设置优先级失败");
    } finally {
      setRetargetBusy(false);
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
    const targetUnits = [...batches.flatMap((item) => item.units), ...leftover];
    const files = targetUnits.flatMap((unit) => unit.files);
    const narrowing = narrowingActive(extraChecks);
    if (!files.length && !batches.length) return;
    const fileCount = files.length;
    const prompt = !fileCount
      ? `确认删除空批次 ${batches.map((item) => item.name).join("、")}？`
      : narrowing
        ? `当前筛选只包含一部分文件。将把符合筛选的 ${fileCount} 个文件移入回收站，同单元里没有出现在筛选中的文件会保留。\n可在「回收站」中恢复，或再永久删除。`
        : `将把所选 ${fileCount} 个文件移入回收站。\n可在「回收站」中恢复，或再永久删除。`;
    if (!window.confirm(prompt)) return;
    const removedPaths = new Set(files.map((file) => file.path));
    const removedBatches = new Set(!narrowing ? batches.map((item) => item.name) : []);
    const removedUnitKeys = new Set(narrowing ? [] : leftover.map((unit) => unit.key));
    loadSequence.current += 1;
    setData((current) =>
      current ? omitStorageRecords(current, removedPaths, removedBatches) : current
    );
    setClassificationUnits((list) =>
      list.flatMap((unit) => {
        if (removedBatches.has(unit.batch) || removedUnitKeys.has(unit.key)) return [];
        const files = unit.files.filter((file) => !removedPaths.has(file.path));
        if (!files.length) return [];
        return files.length === unit.files.length
          ? [unit]
          : [{ ...unit, files, file_count: files.length }];
      })
    );
    setFocus(null);
    setSelectedKey(null);
    preview.removeByPaths([...removedPaths]);
    try {
      const label = narrowing
        ? `筛选后的 ${fileCount} 个文件`
        : batches.length === 1 && !leftover.length
          ? `批次 ${batches[0].name}`
          : leftover.length === 1 && !batches.length
            ? `单元 ${leftover[0].batch}/${leftover[0].name}`
            : `${fileCount} 个文件`;
      await api.storageBulkDelete({
        batches: fileCount ? [] : batches.map((item) => item.name),
        units: [],
        paths: files.map((file) => file.path),
        label,
      });
      setMessage(fileCount ? "已移入回收站" : "已删除空批次");
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
      void load();
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
        ? `确认把这次上传的 ${session.file_count} 个文件移入回收站？\n${formatSessionTime(session.created_at)} · ${session.batch || "未分批次"}\n不会删除同批次其它上传。可在回收站中恢复或永久删除。`
        : `确认把这次上传中的 ${targets.length} 个文件移入回收站？\n不会删除同单元其它上传留下的文件。`);
    if (!window.confirm(text)) return;
    const removedPaths = new Set(targets);
    loadSequence.current += 1;
    setData((current) =>
      current ? omitStorageRecords(current, removedPaths, new Set()) : current
    );
    setClassificationUnits((list) =>
      list.flatMap((unit) => {
        const files = unit.files.filter((file) => !removedPaths.has(file.path));
        if (!files.length) return [];
        return files.length === unit.files.length
          ? [unit]
          : [{ ...unit, files, file_count: files.length }];
      })
    );
    if (whole) {
      if (activeSessionId === session.id) setActiveSessionId(null);
      if (focus?.kind === "upload_session" && focus.key === session.id) {
        setFocus(null);
      }
      setSelectedKey(null);
    }
    preview.removeByPaths(targets);
    try {
      await api.storageDeleteUploadSession(session.id, whole ? undefined : paths);
      setMessage(whole ? "这次上传的文件已移入回收站" : `已把 ${targets.length} 个文件移入回收站`);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
      void load();
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
        <div className="facet-block">
          <div className="facet-title">
            <span>筛选维度</span>
            {(Object.values(filterNodeIds).some((ids) => ids.length > 0) ||
              Object.values(extraChecks).some((ids) => ids.length > 0)) && (
              <button
                type="button"
                className="facet-clear"
                onClick={() => {
                  setFilterNodeIds({});
                  setExtraChecks({});
                }}
              >
                清除
              </button>
            )}
          </div>
          <div className="facet-list">
            {(() => {
              const formatNodes: FacetNode[] = [
                ...new Set(
                  (data?.files || [])
                    .map((file) => (file.format || "").toLowerCase())
                    .filter(Boolean)
                ),
              ]
                .sort((a, b) => a.localeCompare(b))
                .map((format) => ({ id: format, name: format }));
              const modalityNodes: FacetNode[] = matrixRows().map((row) => ({
                id: row.motionKind ? `${row.modality}:${row.motionKind}` : row.modality,
                name: row.label,
              }));
              const uploaderNodes: FacetNode[] = (data?.uploaders || []).map((item) => ({
                id: String(item.id),
                name: item.username,
              }));
              const extraFacets: { key: string; label: string; nodes: FacetNode[] }[] = [
                { key: "uploader", label: "上传用户", nodes: uploaderNodes },
                { key: "subject", label: "数据主体", nodes: subjectFacetNodes(modelInstances) },
                { key: "format", label: "数据格式", nodes: formatNodes },
                { key: "modality", label: "数据模态", nodes: modalityNodes },
              ];
              return extraFacets.map((facet) => {
                const picked = extraChecks[facet.key] || [];
                const open = openFilterScheme === facet.key;
                const summary = facetNameSummary(picked, facet.nodes);
                return (
                  <div className={`facet-item${open ? " is-open" : ""}`} key={facet.key}>
                    <button
                      type="button"
                      className={`facet-chip${open ? " is-open" : ""}${picked.length ? " is-picked" : ""}`}
                      onClick={() =>
                        setOpenFilterScheme((current) => (current === facet.key ? null : facet.key))
                      }
                    >
                      <span>{facet.label}</span>
                      {summary && <span className="facet-summary">{summary}</span>}
                      <span className="facet-chevron">{open ? "▴" : "▾"}</span>
                    </button>
                    {open && (
                      <div className="facet-pop">
                        <StringCheckTree
                          nodes={facet.nodes}
                          checked={picked}
                          onToggle={(id) =>
                            setExtraChecks((current) => {
                              const list = current[facet.key] || [];
                              const next = selectionAfterCheck(id, facetLinks(facet.nodes), list);
                              return { ...current, [facet.key]: next };
                            })
                          }
                        />
                      </div>
                    )}
                  </div>
                );
              });
            })()}
            {schemes.map((scheme) => {
              const picked = filterNodeIds[scheme.key] || [];
              const open = openFilterScheme === scheme.key;
              const summary = filterSummary(picked, nodes);
              return (
                <div className={`facet-item${open ? " is-open" : ""}`} key={scheme.key}>
                  <button
                    type="button"
                    className={`facet-chip${open ? " is-open" : ""}${picked.length ? " is-picked" : ""}`}
                    onClick={() =>
                      setOpenFilterScheme((current) => (current === scheme.key ? null : scheme.key))
                    }
                  >
                    <span>{taxonomySchemeLabel(scheme.key, schemes)}</span>
                    {summary && <span className="facet-summary">{summary}</span>}
                    <span className="facet-chevron">{open ? "▴" : "▾"}</span>
                  </button>
                  {open && (
                    <div className="facet-pop">
                      <FilterCheckTree
                        nodes={nodes.filter((node) => node.scheme === scheme.key)}
                        checked={picked}
                        onToggle={(id) =>
                          setFilterNodeIds((current) => {
                            const list = current[scheme.key] || [];
                            const schemeNodes = nodes.filter((node) => node.scheme === scheme.key);
                            const next = selectionAfterCheck(id, schemeNodes, list);
                            return { ...current, [scheme.key]: next };
                          })
                        }
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="storage-search-line">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(false);
            }}
            placeholder="搜索批次或数据单元"
          />
          <button type="button" onClick={() => void load(false)}>搜索</button>
        </div>
      </div>
      )}

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <div
        className="storage-workspace is-split"
        style={{
          ["--pane-left" as string]: `${leftPaneWidth}px`,
          ["--pane-right" as string]: `${rightPaneWidth}px`,
          ["--pane-preview" as string]: `${previewHeight}px`,
        }}
      >
        <aside className="card storage-left-pane">
          {variant !== "upload" && (
            <div className="browse-pickers">
              <BrowsePicker
                label="分类标准"
                value={
                  mode === "folder"
                    ? "存储结构"
                    : mode === "uploader"
                      ? "上传用户"
                      : taxonomySchemeLabel(mode, schemes)
                }
                open={browseMenu === "standard"}
                options={[
                  { id: "folder", label: "存储结构" },
                  { id: "uploader", label: "上传用户" },
                  ...schemes.map((scheme) => ({
                    id: scheme.key,
                    label: taxonomySchemeLabel(scheme.key, schemes),
                  })),
                ]}
                onToggle={() => setBrowseMenu((current) => (current === "standard" ? null : "standard"))}
                onPick={(id) => {
                  setMode(id);
                  selectTag(null);
                  setBrowseMenu(null);
                }}
              />
              <BrowsePicker
                label="排序方式"
                value={STORAGE_SORT_OPTIONS.find(([value]) => value === sortMode)?.[1] || sortMode}
                open={browseMenu === "sort"}
                options={STORAGE_SORT_OPTIONS.map(([value, label]) => ({ id: value, label }))}
                onToggle={() => setBrowseMenu((current) => (current === "sort" ? null : "sort"))}
                onPick={(id) => {
                  setSortMode(id);
                  setBrowseMenu(null);
                }}
              />
            </div>
          )}
          {variant === "upload" && (
            <div className="storage-upload-browse">
              <div className="storage-upload-dock-title">
                <strong>我的上传</strong>
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
                units={displayData?.units || classificationUnits}
                sortMode={sortMode}
                selectedId={tagId}
                selectedExact={tagExact}
                selectedKey={selectedKey}
                onSelect={(id, exact) => {
                  selectTag(id, exact);
                  if (!preview.contrastMode && id != null) {
                    previewRandomUnit(unitsForTaxonomyNode(id, !!exact), false);
                  }
                }}
                onUnitSelect={(unit) => {
                  setActiveSessionId(null);
                  selectUnit(unit);
                }}
                canDownload={canDownloadItems}
                currentUserId={user?.id}
                onDownload={(units) => handleDownloadItems([], units)}
                onSelectionChange={reportPickedUnits}
              />
            </>
          )}
          {mode === "uploader" && (
            <>
              <h3 style={{ marginTop: 0 }}>上传用户</h3>
              <UploaderTreePanel
                uploaders={data?.uploaders || []}
                units={displayData?.units || []}
                sortMode={sortMode}
                selectedId={tagId}
                selectedKey={selectedKey}
                onSelect={setTagId}
                onUnitSelect={(unit) => {
                  selectUnit(unit);
                }}
                canDownload={canDownloadItems}
                currentUserId={user?.id}
                onDownload={(units) => handleDownloadItems([], units)}
                onSelectionChange={reportPickedUnits}
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
                selectUnit(unit);
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
              onSelectionChange={reportPickedUnits}
            />
          )}
          {mode === "folder" && (
            <UnitTree
              ready={!!displayData}
              data={displayData || { updated_at: "", modalities: [], ontologies: [], uploaders: [], batches: [], units: [], files: [] }}
              selectedUnit={focus?.kind === "unit" || focus?.kind === "file" ? selectedKey : null}
              selectedNodeKey={focus?.kind === "node" ? focus.key : null}
              onSelectUnit={(unit) => {
                setActiveSessionId(null);
                selectUnit(unit);
              }}
              onSelectNode={(key) => {
                setActiveSessionId(null);
                setSelectedKey(null);
                setFocus({ kind: "node", key });
                if (preview.contrastMode) return;
                const splitAt = key.indexOf("::");
                const batchName = splitAt >= 0 ? key.slice(0, splitAt) : key;
                const dirPath = splitAt >= 0 ? key.slice(splitAt + 2) : "";
                const batch = displayData?.batches.find((item) => item.name === batchName);
                if (batch) previewRandomUnit(unitsUnderPath(batch.units, dirPath), true);
              }}
              canEdit={canManageItems}
              canDownload={canDownloadItems}
              canPrioritize={variant === "manage" && isAdmin}
              currentUserId={user?.id}
              onRenameBatch={(batch) => void handleRenameBatch(batch)}
              onRenameUnit={(unit) => void handleRenameUnit(unit)}
              onDelete={(batches, units) => void handleDeleteItems(batches, units)}
              onDownload={(batches, units) => void handleDownloadItems(batches, units)}
              onPrioritize={(units) => void handlePrioritize(units)}
              onSelectionChange={reportPickedUnits}
            />
          )}
        </aside>
        <SplitHandle
          axis="x"
          onDelta={(delta) => setLeftPaneWidth((current) => clampPane(current + delta, 220, 640))}
        />

        <main className="card storage-right-pane pane-stack">
          <div className="pane-stack-body">
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
                        if (!confirm(`确认把 ${selectedFile.name} 移入回收站？可在回收站中恢复或永久删除。`)) return;
                        const removedPaths = new Set([selectedFile.path]);
                        loadSequence.current += 1;
                        setData((current) =>
                          current ? omitStorageRecords(current, removedPaths, new Set()) : current
                        );
                        setClassificationUnits((list) =>
                          list.flatMap((unit) => {
                            const files = unit.files.filter((file) => file.path !== selectedFile.path);
                            if (!files.length) return [];
                            return files.length === unit.files.length
                              ? [unit]
                              : [{ ...unit, files, file_count: files.length }];
                          })
                        );
                        if (focus?.kind === "file" && focus.key === selectedFile.path) {
                          setFocus(null);
                        }
                        preview.removeByPaths([selectedFile.path]);
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
                          void load();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "删除失败");
                          void load();
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
                fileVersions={
                  data?.batches.find((batch) => batch.name === selected.batch)?.file_versions
                }
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
          </div>
          <SplitHandle
            axis="y"
            onDelta={(delta) => setPreviewHeight((current) => clampPane(current - delta, 220, 900))}
          />
          <div className="pane-preview">
            <FilePreviewDock
              onActivate={(file) => {
                setSelectedKey(`${file.batch}::${file.unit_name}`);
                setFocus({ kind: "file", key: file.path });
              }}
            />
          </div>
        </main>
        <SplitHandle
          axis="x"
          onDelta={(delta) => setRightPaneWidth((current) => clampPane(current - delta, 240, 560))}
        />
        <div className="pane-slot">
        <EntityDetailPanel
          kind={pickedUnits.length ? "selection" : focus?.kind || null}
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
          canEdit={variant !== "browse" && (pickedUnits.length ? canAnnotatePicked : canAnnotateSelected)}
          canCreate={variant !== "browse" && canCreateTaxonomy}
          onReload={async () => {
            await load(true);
          }}
          onNodesReload={reloadTaxonomies}
          onError={setError}
          onMessage={setMessage}
          selectedUnits={pickedUnits}
          selectionBatches={displayData?.batches?.length ? displayData.batches : data?.batches || []}
        />
        </div>
      </div>

      {retargetUnits && (
        <div
          className="storage-modal-backdrop"
          onClick={() => {
            if (!retargetBusy) setRetargetUnits(null);
          }}
        >
          <div
            className="storage-modal card stack storage-retarget-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 style={{ margin: 0 }}>选择要重定向的机器人</h3>
            <p className="muted" style={{ margin: 0 }}>
              已选 {retargetUnits.length} 个数据单元。按勾选顺序决定先后，先勾的先做，取消后再勾会排到最后。
            </p>
            <div className="retarget-inline">
              <span className="muted">机器人</span>
              {retargetOrder.map((robot, index) => (
                <button
                  key={robot}
                  type="button"
                  className="retarget-chip"
                  disabled={retargetBusy}
                  onClick={() => setRetargetOrder((current) => current.filter((item) => item !== robot))}
                >
                  {index + 1}. {robot} ×
                </button>
              ))}
              {(retargetRobots.length ? retargetRobots : retargetOrder).map((robot) => {
                const rank = retargetOrder.indexOf(robot);
                return (
                  <label key={robot} className="retarget-check">
                    <input
                      type="checkbox"
                      disabled={retargetBusy}
                      checked={rank >= 0}
                      onChange={() => {
                        setRetargetOrder((current) =>
                          rank >= 0 ? current.filter((item) => item !== robot) : [...current, robot]
                        );
                      }}
                    />
                    {rank >= 0 ? <span className="retarget-rank">{rank + 1}</span> : null}
                    {robot}
                  </label>
                );
              })}
            </div>
            {!retargetRobots.length && <div className="muted">还没有可重定向的机器人款式</div>}
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="secondary"
                disabled={retargetBusy}
                onClick={() => setRetargetUnits(null)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={retargetBusy || !retargetOrder.length}
                onClick={() => void confirmPrioritize()}
              >
                {retargetBusy ? "提交中…" : "开始重定向"}
              </button>
            </div>
          </div>
        </div>
      )}
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
