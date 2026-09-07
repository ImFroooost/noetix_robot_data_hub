import { Children, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, downloadAuth, downloadAuthPost } from "../api";
import { useAuth } from "../auth";
import { usePreview } from "../preview/PreviewContext";
import { FilePreviewDock } from "./FilePreviewDock";
import { FolderBatchImport, UploadTaxonomyFields } from "./FolderBatchImport";
import {
  RobotStyleFields,
  robotDescriptionVersions,
  robotVersionLabel,
} from "./RobotStyleFields";
import { TaxonomySelect } from "./TaxonomyTree";
import { fetchStorageOverview } from "../storageOverviewCache";
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
import { needsManualCsvFps, parseCsvFps, taxonomySchemeLabel } from "../types";

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

function TreeToolbar({
  onCollapseAll,
  onExpandAll,
  extra,
}: {
  onCollapseAll: () => void;
  onExpandAll: () => void;
  extra?: ReactNode;
}) {
  return (
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
      </div>
      {extra}
    </div>
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
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  actions?: ReactNode;
}) {
  const activate = () => {
    onToggle();
    onSelect();
  };
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
  if (nested) return <div className="storage-tree-nested">{body}</div>;
  return <div className={`storage-tree-node ${open ? "is-open" : ""}`}>{body}</div>;
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

function UnitTree({
  data,
  selectedUnit,
  selectedBatch,
  onSelectUnit,
  onSelectBatch,
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
  selectedBatch: string | null;
  onSelectUnit: (unit: StorageUnit) => void;
  onSelectBatch: (batch: StorageBatch) => void;
  canEdit?: boolean;
  canDownload?: boolean;
  currentUserId?: number;
  onRenameBatch: (batch: StorageBatch) => void;
  onRenameUnit: (unit: StorageUnit) => void;
  onDelete: (batches: StorageBatch[], units: StorageUnit[]) => void;
  onDownload: (batches: StorageBatch[], units: StorageUnit[]) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [checkedBatches, setCheckedBatches] = useState<Record<string, boolean>>({});
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
  const toggleUnit = (key: string, value: boolean) => {
    setCheckedUnits((current) => ({ ...current, [key]: value }));
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
                {batch.units.map((unit) => (
                  <TreeUnitItem
                    key={unit.key}
                    title={unit.name}
                    meta={uploaderLabel(unit.uploaders)}
                    selected={selectedUnit === unit.key}
                    onClick={() => onSelectUnit(unit)}
                    checked={!!checkedUnits[unit.key]}
                    onCheck={canManage ? (value) => toggleUnit(unit.key, value) : undefined}
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
  onSelectSession,
  onSelectUnit,
  onDeleteSession,
  onDeleteSessionUnit,
}: {
  sessions: StorageUploadSession[];
  units: StorageUnit[];
  selectedSessionId: string | null;
  selectedUnitKey: string | null;
  canDeleteSession?: (session: StorageUploadSession) => boolean;
  onSelectSession: (session: StorageUploadSession) => void;
  onSelectUnit: (session: StorageUploadSession, unit: StorageUnit) => void;
  onDeleteSession?: (session: StorageUploadSession) => void;
  onDeleteSessionUnit?: (session: StorageUploadSession, unit: StorageUnit) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const unitsByKey = new Map(units.map((unit) => [unit.key, unit]));
  const unitsByName = new Map<string, StorageUnit[]>();
  units.forEach((unit) => {
    const list = unitsByName.get(`${unit.batch}::${unit.name}`) || [];
    list.push(unit);
    unitsByName.set(`${unit.batch}::${unit.name}`, list);
  });

  return (
    <div className="storage-tree storage-structure-tree">
      <TreeToolbar
        onCollapseAll={() =>
          setExpanded(Object.fromEntries(sessions.map((item) => [item.id, false])))
        }
        onExpandAll={() =>
          setExpanded(Object.fromEntries(sessions.map((item) => [item.id, true])))
        }
      />
      {sessions.map((session) => {
        const sessionUnits = session.unit_names
          .map(
            (name) =>
              unitsByKey.get(`${session.batch}::${name}`) ||
              unitsByName.get(`${session.batch}::${name}`)?.[0]
          )
          .filter((item): item is StorageUnit => !!item);
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
            actions={
              allowDelete && onDeleteSession ? (
                <TreeActions
                  canEdit
                  onDelete={() => onDeleteSession(session)}
                />
              ) : undefined
            }
          >
            {open ? (
              <>
                {sessionUnits.map((unit) => {
                  const unitPaths = sessionUnitPaths(session, unit);
                  return (
                    <TreeUnitItem
                      key={`${session.id}:${unit.key}`}
                      title={unit.name}
                      meta={`${unitPaths.length || unit.file_count} 个文件`}
                      selected={
                        selectedSessionId === session.id && selectedUnitKey === unit.key
                      }
                      onClick={() => onSelectUnit(session, unit)}
                      actions={
                        allowDelete && onDeleteSessionUnit && unitPaths.length ? (
                          <TreeActions
                            canEdit
                            onDelete={() => onDeleteSessionUnit(session, unit)}
                          />
                        ) : undefined
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
  const [robotVersion, setRobotVersion] = useState("");
  const [personName, setPersonName] = useState("");
  const [gender, setGender] = useState("");
  const [height, setHeight] = useState("");
  const [fps, setFps] = useState("30");
  const [robotInstances, setRobotInstances] = useState<ModelInstance[]>([]);
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
        setRobotInstances(data.instances.filter((item) => item.ontology === "robot"));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "机器人款式加载失败");
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
              }),
          ...(needsManualCsvFps(ontology, resolvedFormat) ? { fps: parseCsvFps(fps) } : {}),
        })
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
          <input
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            placeholder="选文件后自动用后缀，也可改"
          />
        </label>
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

type DetailKind = "batch" | "unit" | "file" | "upload_session";

function schemesForKind(_kind: DetailKind, schemes: TaxonomySchemeDef[]) {
  return schemes;
}

function EntityDetailPanel({
  kind,
  batch,
  unit,
  file,
  session,
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
  const [personName, setPersonName] = useState("");
  const [gender, setGender] = useState("");
  const [height, setHeight] = useState("");
  const [fps, setFps] = useState("30");
  const [robotInstances, setRobotInstances] = useState<ModelInstance[]>([]);
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
        : kind === "upload_session"
          ? session?.annotation || {}
          : batch?.annotation || {};
  const tagIds =
    kind === "file"
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
    kind === "file"
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
    setPersonName(String(annotation.person_name || ""));
    setGender(String(annotation.gender || ""));
    setHeight(String(annotation.height || ""));
    setFps(String(parseCsvFps(annotation.fps)));
    setSaved(false);
  }, [
    kind,
    batch?.name,
    unit?.key,
    file?.path,
    session?.id,
    annotation.note,
    annotation.quality,
    annotation.robot_style,
    annotation.robot_version,
    annotation.person_name,
    annotation.gender,
    annotation.height,
    annotation.fps,
  ]);

  useEffect(() => {
    if (
      (kind !== "file" && kind !== "upload_session") ||
      (kind === "file" && file?.ontology !== "robot" && detail?.ontology !== "robot") ||
      (kind === "upload_session" && session?.ontology !== "robot")
    ) {
      return;
    }
    let cancelled = false;
    api
      .storageModels()
      .then((data) => {
        if (cancelled) return;
        setRobotInstances(data.instances.filter((item) => item.ontology === "robot"));
      })
      .catch((e) => {
        if (!cancelled) onError(e instanceof Error ? e.message : "机器人款式加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [kind, file?.ontology, detail?.ontology, session?.ontology]);

  const paramOntology =
    kind === "upload_session" ? session?.ontology : viewFile?.ontology;
  const detailNeedsFps = needsManualCsvFps(
    paramOntology,
    kind === "upload_session" ? session?.format : viewFile?.format
  );

  const title =
    kind === "batch"
      ? "批次详情"
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
      const fileAnnotation =
        viewFile?.ontology === "robot" || session?.ontology === "robot"
          ? { quality, note, robot_style: robotStyle, robot_version: robotVersion, ...csvFps }
          : viewFile?.ontology === "human" || session?.ontology === "human"
            ? { quality, note, person_name: personName.trim(), gender, height: height.trim(), ...csvFps }
            : { quality, note, ...csvFps };
      const body = {
        annotation:
          kind === "file" || kind === "upload_session" ? fileAnnotation : { note },
      };
      if (kind === "batch" && batch) {
        await api.storageUpdateBatch(batch.name, body);
      } else if (kind === "unit" && unit) {
        await api.storageUpdateUnit(unit.batch, unit.name, body);
      } else if (kind === "file" && file) {
        await api.storageUpdateFileMeta(file.path, body);
        const row = await api.storageFileDetail(file.path);
        setDetail(row);
      } else if (kind === "upload_session" && session) {
        await api.storageUpdateUploadSession(session.id, {
          ...body,
          paths: session.paths,
        });
      }
      setSaved(true);
      onMessage(
        kind === "upload_session"
          ? "本次上传参数已保存，已同步到该次上传的文件"
          : "标签已保存"
      );
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
      } else if (kind === "upload_session" && session) {
        await api.storageUpdateUploadSession(session.id, {
          ...body,
          paths: session.paths,
        });
      }
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
              {robotDescriptionVersions(
                robotInstances.find((item) => item.name === robotStyle)
              ).length > 1 || robotVersion ? (
                <DetailRow
                  label="机器人版本"
                  value={robotVersionLabel(
                    robotDescriptionVersions(
                      robotInstances.find((item) => item.name === robotStyle)
                    ),
                    robotVersion
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

const ONTOLOGIES = ["human", "robot"] as const;

function downloadKindKey(ontology: string, modality: string) {
  return `${ontology}:${modality}`;
}

function filesFromDownloadTargets(batches: StorageBatch[], units: StorageUnit[]) {
  const covered = new Set(batches.map((item) => item.name));
  const leftover = units.filter((unit) => !covered.has(unit.batch));
  const files = [
    ...batches.flatMap((batch) => batch.units.flatMap((unit) => unit.files)),
    ...leftover.flatMap((unit) => unit.files),
  ];
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

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
  onConfirm: (kinds: { ontology: string; modality: string }[]) => void;
}) {
  const leftover = units.filter(
    (unit) => !batches.some((batch) => batch.name === unit.batch)
  );
  const files = filesFromDownloadTargets(batches, leftover);
  const available = new Set(
    files.map((file) => downloadKindKey(file.ontology, file.modality))
  );
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries([...available].map((key) => [key, true]))
  );
  const selectedKinds = ONTOLOGIES.flatMap((ontology) =>
    Object.keys(MODALITY_LABEL)
      .filter((modality) => checked[downloadKindKey(ontology, modality)])
      .map((modality) => ({ ontology, modality }))
  );
  const selectedCount = files.filter((file) =>
    checked[downloadKindKey(file.ontology, file.modality)]
  ).length;
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
        </p>
        <div className="storage-unit-matrix">
          {ONTOLOGIES.map((ontology) => (
            <section key={ontology} className="storage-ontology-card">
              <h3>{ontology === "human" ? "人体数据" : "机器人数据"}</h3>
              {Object.entries(MODALITY_LABEL).map(([modality, label]) => {
                const key = downloadKindKey(ontology, modality);
                const rowFiles = files.filter(
                  (file) => file.ontology === ontology && file.modality === modality
                );
                const formats = [...new Set(rowFiles.map((file) => file.format))];
                const enabled = rowFiles.length > 0;
                return (
                  <label
                    key={modality}
                    className={`storage-download-row ${enabled ? "" : "is-empty"}`}
                  >
                    <input
                      type="checkbox"
                      disabled={!enabled || busy}
                      checked={enabled && !!checked[key]}
                      onChange={(e) =>
                        setChecked((current) => ({
                          ...current,
                          [key]: e.target.checked,
                        }))
                      }
                    />
                    <span className={`storage-modality-name ${enabled ? "" : "missing"}`}>
                      {label}
                    </span>
                    <span className="storage-file-pills">
                      {enabled ? (
                        <span className="muted">
                          {formats.join(" / ")} · {rowFiles.length} 个文件
                        </span>
                      ) : (
                        <span className="muted">缺省</span>
                      )}
                    </span>
                  </label>
                );
              })}
            </section>
          ))}
        </div>
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            disabled={busy || !selectedKinds.length}
            onClick={() => onConfirm(selectedKinds)}
          >
            {busy ? "打包中…" : "开始下载"}
          </button>
        </div>
      </div>
    </div>
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
                      onQuickUpload({ ontology, modality });
                    }}
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
  const { user, hasPerm } = useAuth();
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
  const preview = usePreview();
  const [quickPreset, setQuickPreset] = useState<{
    ontology: string;
    modality: string;
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
    try {
      await api.storageRenameBatch(batch.name, next);
      setMessage(`批次已重命名为 ${next}`);
      setFocus({ kind: "batch", key: next });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "重命名失败");
    }
  };

  const handleRenameUnit = async (unit: StorageUnit) => {
    const next = promptName("新的数据单元名称", unit.name);
    if (!next || next === unit.name) return;
    try {
      await api.storageRenameUnit(unit.batch, unit.name, next);
      setMessage(`数据单元已重命名为 ${next}`);
      setSelectedKey(`${unit.batch}::${next}`);
      setFocus({ kind: "unit", key: `${unit.batch}::${next}` });
      await load();
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

  const confirmDownload = async (kinds: { ontology: string; modality: string }[]) => {
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
    <div className="page storage-page stack">
      <div className="storage-toolbar card">
        {variant === "upload" && (
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
              className={mode === "upload_order" ? "active" : "secondary"}
              onClick={() => {
                setMode("upload_order");
                setTagId(null);
              }}
            >
              上传顺序
            </button>
          </div>
        )}
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
        {mode !== "folder" && mode !== "uploader" && mode !== "upload_order" && (
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

      {variant === "upload" && (
        <section className="card storage-upload-preset is-bar">
          <div className="storage-upload-preset-head">
            <strong>预设分类标签</strong>
            <span className="muted">先选标签再拖入；弹窗和导入后都还能改。</span>
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
      )}

      <div className="storage-workspace">
        <aside className="card storage-left-pane">
          {variant === "upload" && (
            <>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>
                {mode === "upload_order" ? "上传顺序" : "存储结构"}
              </h3>
              <FolderBatchImport
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
            </>
          )}
          {mode !== "folder" && mode !== "uploader" && mode !== "upload_order" && (
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
                }}
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
                .sort((left, right) => {
                  if (sortMode === "created_asc") {
                    return left.created_at.localeCompare(right.created_at);
                  }
                  if (sortMode === "name_asc") {
                    return left.batch.localeCompare(right.batch, "zh");
                  }
                  if (sortMode === "name_desc") {
                    return right.batch.localeCompare(left.batch, "zh");
                  }
                  return right.created_at.localeCompare(left.created_at);
                })}
              units={data?.units || []}
              selectedSessionId={activeSessionId}
              selectedUnitKey={
                focus?.kind === "unit" || focus?.kind === "file" ? selectedKey : null
              }
              canDeleteSession={canDeleteUploadSession}
              onSelectSession={(session) => {
                setActiveSessionId(session.id);
                setFocus({ kind: "upload_session", key: session.id });
                setSelectedKey(null);
              }}
              onSelectUnit={(session, unit) => {
                setActiveSessionId(session.id);
                setFocus({ kind: "unit", key: unit.key });
                setSelectedKey(unit.key);
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
              selectedBatch={focus?.kind === "batch" ? focus.key : selected?.batch || null}
              onSelectUnit={(unit) => {
                setActiveSessionId(null);
                setSelectedKey(unit.key);
                setFocus({ kind: "unit", key: unit.key });
              }}
              onSelectBatch={(batch) => {
                setActiveSessionId(null);
                setFocus({ kind: "batch", key: batch.name });
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
              <div className="storage-preview-empty">
                这是一次独立上传记录，不会和同批次的其它上传合并。请在右侧修改本次上传时设置的款式、姓名等参数，保存后只作用于这次上传的文件。也可从左侧展开后选择其中的数据单元。
              </div>
            </>
          )}
          {focus?.kind !== "batch" && focus?.kind !== "upload_session" && !selected && (
            <div className="storage-preview-empty">请选择一个数据批次、上传记录或数据单元</div>
          )}
          {focus?.kind !== "batch" && focus?.kind !== "upload_session" && selected && (
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
              (item) => item.name === (selected?.batch || focusedFile?.batch)
            ) ||
            null
          }
          unit={selected}
          file={focus?.kind === "file" ? focusedFile : null}
          session={focusedSession}
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
          onConfirm={(kinds) => void confirmDownload(kinds)}
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
