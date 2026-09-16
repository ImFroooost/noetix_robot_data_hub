import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
} from "react";
import { api, getToken } from "../api";
import { DND_CLIP, DND_FOLDER } from "./FolderTree";
import type { ClipListItem, Folder } from "../types";

const DND_CLIPS = "application/x-noetix-clip-ids";
const TRASH_PATH = "/回收站/";
const UNCLASSIFIED_PATH = "/未分类/";

type FolderNode = Folder & { children: FolderNode[] };

function buildFolderTree(folders: Folder[]): FolderNode[] {
  const map = new Map<number, FolderNode>();
  folders.forEach((f) => map.set(f.id, { ...f, children: [] }));
  const roots: FolderNode[] = [];
  map.forEach((node) => {
    if (node.parent_id != null && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  const sortRec = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => {
      const ao = a.sort_order ?? 0;
      const bo = b.sort_order ?? 0;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name, "zh");
    });
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

function isSystemFolder(folder: Folder): boolean {
  return folder.path === TRASH_PATH || folder.path === UNCLASSIFIED_PATH;
}

function Thumb({ clipId }: { clipId: number; hasThumb?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className="browse-clip-dot" />;
  const src = `/api/thumbnails/${clipId}?token=${encodeURIComponent(getToken() || "")}`;
  return (
    <img
      className="browse-clip-thumb"
      src={src}
      alt=""
      onError={() => setBroken(true)}
    />
  );
}

function FolderBranch({
  node,
  depth,
  selectedClipId,
  selectedFolderId,
  selectedClipIds,
  onSelectClip,
  onSelectFolder,
  onToggleClip,
  onRangeSelect,
  clipsByFolder,
  loadClips,
  openIds,
  setOpenIds,
  dropFolderId,
  setDropFolderId,
  canManage,
  onDropClips,
  onDropFolder,
}: {
  node: FolderNode;
  depth: number;
  selectedClipId: number | null;
  selectedFolderId: number | null;
  selectedClipIds: Set<number>;
  onSelectClip: (clip: ClipListItem) => void;
  onSelectFolder?: (folder: Folder | null) => void;
  onToggleClip: (id: number, additive: boolean) => void;
  onRangeSelect: (folderId: number, clipId: number) => void;
  clipsByFolder: Record<number, ClipListItem[] | undefined>;
  loadClips: (folderId: number) => void;
  openIds: Set<number>;
  setOpenIds: (fn: (prev: Set<number>) => Set<number>) => void;
  dropFolderId: number | null;
  setDropFolderId: (id: number | null) => void;
  canManage: boolean;
  onDropClips?: (clipIds: number[], folderId: number) => Promise<void>;
  onDropFolder?: (folderId: number, parentId: number | null) => Promise<void>;
}) {
  const open = openIds.has(node.id);
  const clips = clipsByFolder[node.id];
  const folderActive = selectedFolderId === node.id && selectedClipId == null;
  const isDrop = dropFolderId === node.id;

  useEffect(() => {
    if (open && clips === undefined) loadClips(node.id);
  }, [open, clips, node.id, loadClips]);

  const toggle = () => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  };

  const onDragOver = (e: DragEvent) => {
    if (!canManage) return;
    const types = [...e.dataTransfer.types];
    if (
      types.includes(DND_CLIPS) ||
      types.includes(DND_CLIP) ||
      types.includes(DND_FOLDER)
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropFolderId(node.id);
    }
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropFolderId(null);
    if (!canManage) return;

    const multi = e.dataTransfer.getData(DND_CLIPS);
    if (multi && onDropClips) {
      try {
        const ids = JSON.parse(multi) as number[];
        if (Array.isArray(ids) && ids.length) await onDropClips(ids, node.id);
      } catch {
        /* ignore */
      }
      return;
    }
    const one = e.dataTransfer.getData(DND_CLIP);
    if (one && onDropClips) {
      const id = Number(one);
      if (Number.isFinite(id)) await onDropClips([id], node.id);
      return;
    }
    const fid = e.dataTransfer.getData(DND_FOLDER);
    if (fid && onDropFolder) {
      const id = Number(fid);
      if (Number.isFinite(id) && id !== node.id) await onDropFolder(id, node.id);
    }
  };

  return (
    <div>
      <div
        className={`folder-row browse-folder-row ${folderActive ? "active" : ""} ${
          isDrop ? "drop-target" : ""
        }`}
        style={
          {
            paddingLeft: 8 + depth * 14,
            "--tree-depth": depth,
          } as CSSProperties
        }
        onClick={() => {
          onSelectFolder?.(node);
          if (!open) toggle();
        }}
        onDragOver={onDragOver}
        onDragLeave={() => {
          if (dropFolderId === node.id) setDropFolderId(null);
        }}
        onDrop={(e) => void onDrop(e)}
        draggable={canManage && !isSystemFolder(node)}
        onDragStart={(e) => {
          if (!canManage || isSystemFolder(node)) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.setData(DND_FOLDER, String(node.id));
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <button
          type="button"
          className="folder-toggle"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="folder-name" title={node.path}>
          {node.name}
        </span>
        <span className="muted folder-meta">
          {node.clip_count ?? 0}条
          {node.children.length ? ` · ${node.children.length}夹` : ""}
        </span>
      </div>
      {open && (
        <>
          {node.children.map((c) => (
            <FolderBranch
              key={c.id}
              node={c}
              depth={depth + 1}
              selectedClipId={selectedClipId}
              selectedFolderId={selectedFolderId}
              selectedClipIds={selectedClipIds}
              onSelectClip={onSelectClip}
              onSelectFolder={onSelectFolder}
              onToggleClip={onToggleClip}
              onRangeSelect={onRangeSelect}
              clipsByFolder={clipsByFolder}
              loadClips={loadClips}
              openIds={openIds}
              setOpenIds={setOpenIds}
              dropFolderId={dropFolderId}
              setDropFolderId={setDropFolderId}
              canManage={canManage}
              onDropClips={onDropClips}
              onDropFolder={onDropFolder}
            />
          ))}
          {clips === undefined && (
            <div
              className="muted"
              style={{ paddingLeft: 24 + depth * 14, fontSize: "0.8rem" }}
            >
              加载条目…
            </div>
          )}
          {clips?.map((clip) => {
            const checked = selectedClipIds.has(clip.id);
            const active = selectedClipId === clip.id || checked;
            return (
              <div
                key={clip.id}
                className={`folder-row browse-clip-row ${active ? "active" : ""} ${
                  checked ? "batch-checked" : ""
                }`}
                style={{ paddingLeft: 24 + depth * 14 }}
                title={clip.action_name || clip.summary}
                draggable={canManage}
                onDragStart={(e) => {
                  if (!canManage) {
                    e.preventDefault();
                    return;
                  }
                  const ids = selectedClipIds.has(clip.id)
                    ? [...selectedClipIds]
                    : [clip.id];
                  e.dataTransfer.setData(DND_CLIP, String(clip.id));
                  e.dataTransfer.setData(DND_CLIPS, JSON.stringify(ids));
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={(e: MouseEvent) => {
                  if (e.shiftKey) {
                    onRangeSelect(node.id, clip.id);
                    return;
                  }
                  if (e.ctrlKey || e.metaKey) {
                    onToggleClip(clip.id, true);
                    return;
                  }
                  onSelectClip(clip);
                }}
              >
                {canManage && (
                  <input
                    type="checkbox"
                    className="browse-clip-check"
                    checked={checked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      e.stopPropagation();
                      onToggleClip(clip.id, true);
                    }}
                    title="多选（也可 Ctrl/Shift 点击）"
                  />
                )}
                <Thumb clipId={clip.id} />
                <span className="folder-name">
                  {clip.action_name || clip.summary || `条目 #${clip.id}`}
                </span>
                <span className="muted folder-meta">
                  {(clip.human_formats || []).slice(0, 3).join("/")}
                </span>
              </div>
            );
          })}
          {clips && clips.length === 0 && node.children.length === 0 && (
            <div
              className="muted"
              style={{ paddingLeft: 24 + depth * 14, fontSize: "0.8rem" }}
            >
              （空文件夹）
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface Props {
  folders: Folder[];
  selectedClipId: number | null;
  onSelectClip: (clip: ClipListItem) => void;
  onSelectFolder?: (folder: Folder | null) => void;
  selectedFolderId?: number | null;
  refreshKey?: number;
  extraFilters?: Record<string, string | number | boolean | undefined | null>;
  /** 可管理文件夹与批量处理条目 */
  manageable?: boolean;
  onFoldersChanged?: () => void;
  onClipsChanged?: () => void;
}

export function BrowseTree({
  folders,
  selectedClipId,
  onSelectClip,
  onSelectFolder,
  selectedFolderId = null,
  refreshKey = 0,
  extraFilters = {},
  manageable = false,
  onFoldersChanged,
  onClipsChanged,
}: Props) {
  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set());
  const [clipsByFolder, setClipsByFolder] = useState<
    Record<number, ClipListItem[] | undefined>
  >({});
  const [selectedClipIds, setSelectedClipIds] = useState<Set<number>>(
    () => new Set()
  );
  const [anchorClip, setAnchorClip] = useState<{
    folderId: number;
    clipId: number;
  } | null>(null);
  const [dropFolderId, setDropFolderId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [moveTarget, setMoveTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [localMsg, setLocalMsg] = useState("");

  const selectedFolder =
    selectedFolderId != null
      ? folders.find((f) => f.id === selectedFolderId) || null
      : null;

  useEffect(() => {
    if (!tree.length) return;
    setOpenIds((prev) => {
      if (prev.size) return prev;
      return new Set(tree.slice(0, 8).map((n) => n.id));
    });
  }, [tree]);

  useEffect(() => {
    setClipsByFolder({});
  }, [refreshKey]);

  const filterKey = JSON.stringify(extraFilters);
  useEffect(() => {
    setClipsByFolder({});
  }, [filterKey]);

  const loadClips = useCallback(
    async (folderId: number) => {
      try {
        const pageSize = 100;
        const first = await api.search({
          folder_id: folderId,
          page: 1,
          page_size: pageSize,
          sort_by: "sort_order",
          sort_dir: "asc",
          ...extraFilters,
        });
        const items = [...first.items];
        const totalPages = Math.max(1, Math.ceil(first.total / pageSize));
        for (let p = 2; p <= totalPages; p++) {
          const more = await api.search({
            folder_id: folderId,
            page: p,
            page_size: pageSize,
            sort_by: "sort_order",
            sort_dir: "asc",
            ...extraFilters,
          });
          items.push(...more.items);
        }
        setClipsByFolder((prev) => ({ ...prev, [folderId]: items }));
      } catch {
        setClipsByFolder((prev) => ({ ...prev, [folderId]: [] }));
      }
    },
    [extraFilters]
  );

  const reloadOpen = useCallback(() => {
    openIds.forEach((id) => void loadClips(id));
  }, [openIds, loadClips]);

  useEffect(() => {
    if (refreshKey) reloadOpen();
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const onToggleClip = (id: number, additive: boolean) => {
    setSelectedClipIds((prev) => {
      const next = additive ? new Set(prev) : new Set<number>();
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchorClip((prev) => {
      // find folder of this clip among loaded
      for (const [fid, list] of Object.entries(clipsByFolder)) {
        if (list?.some((c) => c.id === id)) {
          return { folderId: Number(fid), clipId: id };
        }
      }
      return prev;
    });
  };

  const onRangeSelect = (folderId: number, clipId: number) => {
    const list = clipsByFolder[folderId] || [];
    const end = list.findIndex((c) => c.id === clipId);
    if (end < 0) return;
    let start = end;
    if (anchorClip?.folderId === folderId) {
      const a = list.findIndex((c) => c.id === anchorClip.clipId);
      if (a >= 0) start = a;
    }
    const [lo, hi] = start < end ? [start, end] : [end, start];
    setSelectedClipIds((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(list[i].id);
      return next;
    });
    setAnchorClip({ folderId, clipId });
  };

  const clearSelection = () => setSelectedClipIds(new Set());

  const selectAllInFolder = async () => {
    if (selectedFolderId == null) return;
    let list = clipsByFolder[selectedFolderId];
    if (list === undefined) {
      await loadClips(selectedFolderId);
      list = undefined; // will read from state asynchronously — refetch below
      try {
        const data = await api.search({
          folder_id: selectedFolderId,
          page: 1,
          page_size: 100,
          sort_by: "sort_order",
          sort_dir: "asc",
          ...extraFilters,
        });
        setSelectedClipIds(new Set(data.items.map((c) => c.id)));
        return;
      } catch {
        return;
      }
    }
    setSelectedClipIds(new Set(list.map((c) => c.id)));
  };

  const refreshAfterClipChange = async () => {
    clearSelection();
    setClipsByFolder({});
    onClipsChanged?.();
    onFoldersChanged?.();
    openIds.forEach((id) => void loadClips(id));
  };

  const batchMove = async (folderId: number) => {
    const ids = [...selectedClipIds];
    if (!ids.length) return;
    setBusy(true);
    setLocalError("");
    setLocalMsg("");
    try {
      const r = await api.batchClips({
        action: "move",
        clip_ids: ids,
        folder_id: folderId,
      });
      setLocalMsg(`已移动 ${r.count} 条到目标文件夹`);
      setOpenIds((prev) => new Set(prev).add(folderId));
      await refreshAfterClipChange();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "批量移动失败");
    } finally {
      setBusy(false);
    }
  };

  const batchDelete = async () => {
    const ids = [...selectedClipIds];
    if (!ids.length) return;
    if (!confirm(`确认删除选中的 ${ids.length} 条动作？此操作不可撤销。`)) return;
    setBusy(true);
    setLocalError("");
    setLocalMsg("");
    try {
      const r = await api.batchClips({ action: "delete", clip_ids: ids });
      setLocalMsg(`已删除 ${r.count} 条`);
      await refreshAfterClipChange();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "批量删除失败");
    } finally {
      setBusy(false);
    }
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setLocalError("");
    try {
      await api.createFolder({
        name,
        parent_id: selectedFolder?.id ?? null,
      });
      setNewName("");
      setLocalMsg("已新建文件夹");
      onFoldersChanged?.();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "新建失败");
    } finally {
      setBusy(false);
    }
  };

  const renameFolder = async () => {
    if (!selectedFolder || isSystemFolder(selectedFolder)) return;
    const name = prompt("重命名文件夹", selectedFolder.name);
    if (!name || !name.trim() || name.trim() === selectedFolder.name) return;
    setBusy(true);
    setLocalError("");
    try {
      await api.updateFolder(selectedFolder.id, { name: name.trim() });
      setLocalMsg("已重命名");
      onFoldersChanged?.();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "重命名失败");
    } finally {
      setBusy(false);
    }
  };

  const deleteFolder = async () => {
    if (!selectedFolder || isSystemFolder(selectedFolder)) return;
    if (
      !confirm(
        `确认将「${selectedFolder.name}」移入回收站？\n其下条目与子文件夹一并移入。`
      )
    ) {
      return;
    }
    setBusy(true);
    setLocalError("");
    try {
      await api.deleteFolder(selectedFolder.id);
      setLocalMsg("已移入回收站");
      onSelectFolder?.(null);
      onFoldersChanged?.();
      onClipsChanged?.();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const folderOptions = useMemo(
    () =>
      [...folders]
        .filter((f) => f.path !== TRASH_PATH)
        .sort((a, b) => a.path.localeCompare(b.path, "zh")),
    [folders]
  );

  return (
    <div className="folder-tree browse-tree">
      {manageable && (
        <div className="browse-tree-toolbar stack">
          <div className="muted" style={{ fontSize: "0.78rem" }}>
            {selectedFolder
              ? `当前文件夹：${selectedFolder.path}`
              : "当前：全部（新建将在根目录）"}
            {selectedClipIds.size > 0 && ` · 已选 ${selectedClipIds.size} 条`}
          </div>
          {localError && <div className="error">{localError}</div>}
          {localMsg && <div className="success">{localMsg}</div>}

          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <input
              placeholder={selectedFolder ? "在选中目录下新建…" : "在根目录新建…"}
              value={newName}
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createFolder();
              }}
              style={{ flex: "1 1 120px", minWidth: 0 }}
            />
            <button
              type="button"
              className="secondary"
              disabled={busy || !newName.trim()}
              onClick={() => void createFolder()}
            >
              新建夹
            </button>
            <button
              type="button"
              className="secondary"
              disabled={
                busy || !selectedFolder || isSystemFolder(selectedFolder)
              }
              onClick={() => void renameFolder()}
            >
              重命名
            </button>
            <button
              type="button"
              className="secondary"
              disabled={
                busy || !selectedFolder || isSystemFolder(selectedFolder)
              }
              onClick={() => void deleteFolder()}
            >
              删文件夹
            </button>
          </div>

          <div className="row" style={{ flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <button
              type="button"
              className="secondary"
              disabled={busy || selectedFolderId == null}
              onClick={selectAllInFolder}
              title="选中当前文件夹内已加载的全部条目"
            >
              全选本夹
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || selectedClipIds.size === 0}
              onClick={clearSelection}
            >
              清空选择
            </button>
            <select
              value={moveTarget}
              disabled={busy || selectedClipIds.size === 0}
              onChange={(e) => setMoveTarget(e.target.value)}
              style={{ flex: "1 1 140px", minWidth: 0 }}
              title="批量移动目标"
            >
              <option value="">移动到…</option>
              {folderOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || selectedClipIds.size === 0 || !moveTarget}
              onClick={() => void batchMove(Number(moveTarget))}
            >
              移动
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || selectedClipIds.size === 0}
              onClick={() => void batchDelete()}
            >
              删除条目
            </button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: "0.72rem" }}>
            勾选 / Ctrl 多选 / Shift 连选；拖拽条目到文件夹可移动；拖拽文件夹可改父级。
          </p>
        </div>
      )}

      <div
        className={`folder-row ${
          selectedFolderId == null && selectedClipId == null ? "active" : ""
        }`}
        onClick={() => onSelectFolder?.(null)}
        onDragOver={(e) => {
          if (!manageable) return;
          if ([...e.dataTransfer.types].includes(DND_FOLDER)) {
            e.preventDefault();
          }
        }}
        onDrop={async (e) => {
          if (!manageable) return;
          e.preventDefault();
          const fid = e.dataTransfer.getData(DND_FOLDER);
          if (!fid) return;
          const id = Number(fid);
          if (!Number.isFinite(id)) return;
          try {
            await api.updateFolder(id, { parent_id: null });
            setLocalMsg("已移到根目录");
            onFoldersChanged?.();
          } catch (err) {
            setLocalError(err instanceof Error ? err.message : "移动失败");
          }
        }}
      >
        <span className="folder-name">全部文件夹</span>
      </div>
      <div className="folder-tree-list browse-tree-list">
        {tree.map((n) => (
          <FolderBranch
            key={n.id}
            node={n}
            depth={0}
            selectedClipId={selectedClipId}
            selectedFolderId={selectedFolderId}
            selectedClipIds={selectedClipIds}
            onSelectClip={(c) => {
              if (selectedClipIds.size && !selectedClipIds.has(c.id)) {
                clearSelection();
              }
              onSelectClip(c);
            }}
            onSelectFolder={onSelectFolder}
            onToggleClip={onToggleClip}
            onRangeSelect={onRangeSelect}
            clipsByFolder={clipsByFolder}
            loadClips={loadClips}
            openIds={openIds}
            setOpenIds={setOpenIds}
            dropFolderId={dropFolderId}
            setDropFolderId={setDropFolderId}
            canManage={manageable}
            onDropClips={async (ids, folderId) => {
              setBusy(true);
              setLocalError("");
              try {
                const r = await api.batchClips({
                  action: "move",
                  clip_ids: ids,
                  folder_id: folderId,
                });
                setLocalMsg(`已移动 ${r.count} 条`);
                setOpenIds((prev) => new Set(prev).add(folderId));
                await refreshAfterClipChange();
              } catch (e) {
                setLocalError(e instanceof Error ? e.message : "移动失败");
              } finally {
                setBusy(false);
              }
            }}
            onDropFolder={async (folderId, parentId) => {
              try {
                await api.updateFolder(folderId, { parent_id: parentId });
                setLocalMsg("已调整文件夹位置");
                onFoldersChanged?.();
              } catch (e) {
                setLocalError(e instanceof Error ? e.message : "移动文件夹失败");
              }
            }}
          />
        ))}
        {!tree.length && <div className="muted">暂无文件夹</div>}
      </div>
    </div>
  );
}
