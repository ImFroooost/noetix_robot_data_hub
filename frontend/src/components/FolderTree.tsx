import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import type { Folder } from "../types";

const DND_FOLDER = "application/x-noetix-folder-id";
const DND_CLIP = "application/x-noetix-clip-id";

export { DND_CLIP, DND_FOLDER };

interface ClipboardState {
  mode: "cut" | "copy";
  folderId: number;
}

interface Props {
  folders: Folder[];
  selectedPath?: string | null;
  selectedId?: number | null;
  onSelect?: (folder: Folder | null) => void;
  allowRoot?: boolean;
  manageable?: boolean;
  canManagePath?: (path: string) => boolean;
  onCreate?: (name: string, parentId: number | null) => Promise<Folder | void>;
  onRename?: (folder: Folder, name: string) => Promise<void>;
  onMove?: (folder: Folder, parentId: number | null) => Promise<void>;
  onDelete?: (folder: Folder) => Promise<void>;
  /** 将动作条目拖入文件夹 */
  onDropClip?: (clipId: number, folderId: number | null) => Promise<void>;
}

type Node = Folder & { children: Node[] };

function buildTree(folders: Folder[]): Node[] {
  const map = new Map<number, Node>();
  folders.forEach((f) => map.set(f.id, { ...f, children: [] }));
  const roots: Node[] = [];
  map.forEach((node) => {
    if (node.parent_id != null && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  const sortRec = (nodes: Node[]) => {
    nodes.sort((a, b) => a.path.localeCompare(b.path, "zh"));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

function isDescendantPath(folderPath: string, ancestorPath: string) {
  return folderPath === ancestorPath || folderPath.startsWith(ancestorPath);
}

function canDropFolderOnto(
  dragging: Folder,
  targetId: number | null,
  folders: Folder[]
): boolean {
  if (targetId === dragging.id) return false;
  if (targetId === dragging.parent_id) return false; // already there
  if (targetId == null) return dragging.parent_id != null; // move to root only if not already root
  const target = folders.find((f) => f.id === targetId);
  if (!target) return false;
  // cannot drop into self or descendant
  if (isDescendantPath(target.path, dragging.path)) return false;
  return true;
}

function TreeNode({
  node,
  depth,
  selectedPath,
  selectedId,
  onSelect,
  renamingId,
  renameValue,
  setRenameValue,
  onCommitRename,
  onCancelRename,
  onStartRename,
  manageable,
  dragOverId,
  cutId,
  onDragStartFolder,
  onDragOverTarget,
  onDragLeaveTarget,
  onDropOnTarget,
}: {
  node: Node;
  depth: number;
  selectedPath?: string | null;
  selectedId?: number | null;
  onSelect?: (folder: Folder) => void;
  renamingId: number | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onStartRename: (folder: Folder) => void;
  manageable: boolean;
  dragOverId: number | "root" | null;
  cutId: number | null;
  onDragStartFolder: (e: DragEvent, folder: Folder) => void;
  onDragOverTarget: (e: DragEvent, targetId: number) => void;
  onDragLeaveTarget: (e: DragEvent, targetId: number) => void;
  onDropOnTarget: (e: DragEvent, targetId: number) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const inputRef = useRef<HTMLInputElement>(null);
  const active =
    (selectedId != null && selectedId === node.id) ||
    (selectedPath != null && selectedPath === node.path);
  const isRenaming = renamingId === node.id;
  const isCut = cutId === node.id;
  const isDropTarget = dragOverId === node.id;

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onCommitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancelRename();
    }
  };

  return (
    <div>
      <div
        className={`folder-row browse-folder-row ${active ? "active" : ""} ${isDropTarget ? "drop-target" : ""} ${
          isCut ? "cut" : ""
        }`}
        style={
          {
            paddingLeft: 8 + depth * 14,
            "--tree-depth": depth,
          } as CSSProperties
        }
        draggable={manageable && !isRenaming}
        onDragStart={(e) => onDragStartFolder(e, node)}
        onDragOver={(e) => onDragOverTarget(e, node.id)}
        onDragLeave={(e) => onDragLeaveTarget(e, node.id)}
        onDrop={(e) => onDropOnTarget(e, node.id)}
        onClick={() => !isRenaming && onSelect?.(node)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onStartRename(node);
        }}
      >
        <button
          type="button"
          className="folder-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {node.children.length ? (open ? "▾" : "▸") : "·"}
        </button>
        {isRenaming ? (
          <input
            ref={inputRef}
            className="folder-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={onKey}
            onBlur={onCommitRename}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="folder-name" title={`${node.path}\n拖到其他文件夹可移动`}>
            {node.name}
          </span>
        )}
        {!isRenaming && (
          <span className="muted folder-meta">
            {node.clip_count}条{node.child_count ? ` · ${node.child_count}夹` : ""}
          </span>
        )}
      </div>
      {open &&
        node.children.map((c) => (
          <TreeNode
            key={c.id}
            node={c}
            depth={depth + 1}
            selectedPath={selectedPath}
            selectedId={selectedId}
            onSelect={onSelect}
            renamingId={renamingId}
            renameValue={renameValue}
            setRenameValue={setRenameValue}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
            onStartRename={onStartRename}
            manageable={manageable}
            dragOverId={dragOverId}
            cutId={cutId}
            onDragStartFolder={onDragStartFolder}
            onDragOverTarget={onDragOverTarget}
            onDragLeaveTarget={onDragLeaveTarget}
            onDropOnTarget={onDropOnTarget}
          />
        ))}
    </div>
  );
}

export function FolderTree({
  folders,
  selectedPath,
  selectedId,
  onSelect,
  allowRoot = true,
  manageable = false,
  canManagePath,
  onCreate,
  onRename,
  onMove,
  onDelete,
  onDropClip,
}: Props) {
  const tree = useMemo(() => buildTree(folders), [folders]);
  const selected = folders.find((f) => f.id === selectedId) || null;
  const canManageSelected =
    !!selected && (!canManagePath || canManagePath(selected.path));
  const canManageRoot = !canManagePath || canManagePath("/");

  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [localMsg, setLocalMsg] = useState("");
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [dragOverId, setDragOverId] = useState<number | "root" | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const childrenOf = useCallback(
    (parentId: number | null) =>
      folders.filter((f) =>
        parentId == null ? f.parent_id == null : f.parent_id === parentId
      ),
    [folders]
  );

  const uniqueName = (base: string, parentId: number | null) => {
    const siblings = childrenOf(parentId);
    const names = new Set(siblings.map((s) => s.name));
    if (!names.has(base)) return base;
    let i = 1;
    while (names.has(`${base} 副本${i === 1 ? "" : i}`)) i += 1;
    return i === 1 ? `${base} 副本` : `${base} 副本${i}`;
  };

  const startRename = (folder: Folder) => {
    if (!manageable || (canManagePath && !canManagePath(folder.path))) return;
    setRenamingId(folder.id);
    setRenameValue(folder.name);
    setLocalError("");
  };

  const commitRename = async () => {
    if (renamingId == null) return;
    const folder = folders.find((f) => f.id === renamingId);
    const name = renameValue.trim();
    setRenamingId(null);
    if (!folder || !name || name === folder.name || !onRename) return;
    setBusy(true);
    setLocalError("");
    try {
      await onRename(folder, name);
      setLocalMsg(`已重命名为「${name}」`);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "重命名失败");
    } finally {
      setBusy(false);
    }
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
  };

  const doMove = async (folder: Folder, parentId: number | null) => {
    if (!onMove) return;
    if (!canDropFolderOnto(folder, parentId, folders)) {
      setLocalError("不能移动到该位置");
      return;
    }
    const destPath =
      parentId == null ? "/" : folders.find((f) => f.id === parentId)?.path || "";
    if (canManagePath && !canManagePath(folder.path)) {
      setLocalError("没有源文件夹的编辑权限");
      return;
    }
    if (canManagePath && !canManagePath(destPath === "/" ? "/" : destPath)) {
      setLocalError("没有目标位置的编辑权限");
      return;
    }
    setBusy(true);
    setLocalError("");
    try {
      await onMove(folder, parentId);
      setLocalMsg(`已移动「${folder.name}」`);
      setClipboard((c) => (c?.folderId === folder.id && c.mode === "cut" ? null : c));
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "移动失败");
    } finally {
      setBusy(false);
    }
  };

  const copyTreeRecursive = async (
    source: Folder,
    parentId: number | null
  ): Promise<void> => {
    if (!onCreate) return;
    const name = uniqueName(source.name, parentId);
    const created = await onCreate(name, parentId);
    const newId =
      created && typeof created === "object" && "id" in created
        ? (created as Folder).id
        : null;
    if (newId == null) return;
    const kids = childrenOf(source.id).sort((a, b) => a.name.localeCompare(b.name, "zh"));
    for (const kid of kids) {
      await copyTreeRecursive(kid, newId);
    }
  };

  const doPaste = async (targetParentId: number | null) => {
    if (!clipboard) return;
    const src = folders.find((f) => f.id === clipboard.folderId);
    if (!src) {
      setLocalError("剪贴板中的文件夹已不存在");
      setClipboard(null);
      return;
    }
    const destPath =
      targetParentId == null
        ? "/"
        : folders.find((f) => f.id === targetParentId)?.path || "";
    if (canManagePath && !canManagePath(destPath === "/" ? "/" : destPath)) {
      setLocalError("没有目标位置的编辑权限");
      return;
    }
    setBusy(true);
    setLocalError("");
    try {
      if (clipboard.mode === "cut") {
        await doMove(src, targetParentId);
      } else {
        if (targetParentId != null && isDescendantPath(
          folders.find((f) => f.id === targetParentId)!.path,
          src.path
        )) {
          setLocalError("不能粘贴到自身或子文件夹内");
          return;
        }
        await copyTreeRecursive(src, targetParentId);
        setLocalMsg(`已复制「${src.name}」及其子文件夹结构（不含动作条目）`);
      }
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "粘贴失败");
    } finally {
      setBusy(false);
    }
  };

  const onDragStartFolder = (e: DragEvent, folder: Folder) => {
    if (!manageable) return;
    e.dataTransfer.setData(DND_FOLDER, String(folder.id));
    e.dataTransfer.setData("text/plain", folder.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOverTarget = (e: DragEvent, targetId: number | "root") => {
    const hasFolder = e.dataTransfer.types.includes(DND_FOLDER);
    const hasClip = e.dataTransfer.types.includes(DND_CLIP);
    if (!hasFolder && !hasClip) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = hasFolder ? "move" : "move";
    setDragOverId(targetId);
  };

  const onDragLeaveTarget = (e: DragEvent, targetId: number | "root") => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOverId((cur) => (cur === targetId ? null : cur));
  };

  const onDropOnTarget = async (e: DragEvent, targetId: number | "root") => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverId(null);
    const parentId = targetId === "root" ? null : targetId;

    const clipRaw = e.dataTransfer.getData(DND_CLIP);
    if (clipRaw && onDropClip) {
      const clipId = Number(clipRaw);
      if (!Number.isFinite(clipId)) return;
      const destPath =
        parentId == null ? "/未分类/" : folders.find((f) => f.id === parentId)?.path || "";
      if (canManagePath && parentId != null && !canManagePath(destPath)) {
        setLocalError("没有目标文件夹的编辑权限");
        return;
      }
      setBusy(true);
      setLocalError("");
      try {
        await onDropClip(clipId, parentId);
        setLocalMsg("已将动作条目移入文件夹");
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : "移动条目失败");
      } finally {
        setBusy(false);
      }
      return;
    }

    const folderRaw = e.dataTransfer.getData(DND_FOLDER);
    if (!folderRaw || !onMove) return;
    const folder = folders.find((f) => f.id === Number(folderRaw));
    if (!folder) return;
    await doMove(folder, parentId);
  };

  // keyboard shortcuts when tree focused
  useEffect(() => {
    const el = treeRef.current;
    if (!el || !manageable) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (renamingId != null) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!el.contains(document.activeElement) && document.activeElement !== el) {
        // allow when selection is inside tree panel
        if (!el.contains(e.target as Node)) return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "x" && selected && canManageSelected) {
        e.preventDefault();
        setClipboard({ mode: "cut", folderId: selected.id });
        setLocalMsg(`已剪切「${selected.name}」，请选择目标后粘贴`);
      } else if (mod && e.key.toLowerCase() === "c" && selected && canManageSelected) {
        e.preventDefault();
        setClipboard({ mode: "copy", folderId: selected.id });
        setLocalMsg(`已复制「${selected.name}」，请选择目标后粘贴`);
      } else if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void doPaste(selected?.id ?? null);
      } else if (e.key === "F2" && selected && canManageSelected) {
        e.preventDefault();
        startRename(selected);
      } else if (e.key === "Delete" && selected && canManageSelected && onDelete) {
        e.preventDefault();
        if (
          confirm(
            `确认删除空文件夹「${selected.name}」？\n（含条目或子文件夹时无法删除）`
          )
        ) {
          void (async () => {
            setBusy(true);
            try {
              await onDelete(selected);
              setLocalMsg("已删除");
            } catch (err) {
              setLocalError(err instanceof Error ? err.message : "删除失败");
            } finally {
              setBusy(false);
            }
          })();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const clipInfo = clipboard
    ? folders.find((f) => f.id === clipboard.folderId)
    : null;

  return (
    <div
      className="folder-tree stack"
      ref={treeRef}
      tabIndex={0}
      onClick={(e) => {
        // 勿从输入框/按钮抢走焦点（否则松开鼠标后无法输入）
        const t = e.target as HTMLElement | null;
        if (t?.closest("input, textarea, select, button, a, label, [contenteditable='true']")) {
          return;
        }
        treeRef.current?.focus();
      }}
    >
      <div className="folder-tree-list">
        {allowRoot && (
          <div
            className={`folder-row ${!selectedId && !selectedPath ? "active" : ""} ${
              dragOverId === "root" ? "drop-target" : ""
            }`}
            onClick={() => onSelect?.(null)}
            onDragOver={(e) => onDragOverTarget(e, "root")}
            onDragLeave={(e) => onDragLeaveTarget(e, "root")}
            onDrop={(e) => onDropOnTarget(e, "root")}
          >
            <span className="folder-toggle">⌂</span>
            <span className="folder-name">全部 / 根目录</span>
          </div>
        )}
        {tree.map((n) => (
          <TreeNode
            key={n.id}
            node={n}
            depth={0}
            selectedPath={selectedPath}
            selectedId={selectedId}
            onSelect={onSelect || undefined}
            renamingId={renamingId}
            renameValue={renameValue}
            setRenameValue={setRenameValue}
            onCommitRename={commitRename}
            onCancelRename={cancelRename}
            onStartRename={startRename}
            manageable={manageable}
            dragOverId={dragOverId}
            cutId={clipboard?.mode === "cut" ? clipboard.folderId : null}
            onDragStartFolder={onDragStartFolder}
            onDragOverTarget={onDragOverTarget}
            onDragLeaveTarget={onDragLeaveTarget}
            onDropOnTarget={onDropOnTarget}
          />
        ))}
        {!tree.length && <div className="muted" style={{ padding: 8 }}>暂无文件夹</div>}
      </div>

      {manageable && (
        <div className="folder-toolbar stack">
          {selected && (
            <div className="muted" style={{ fontSize: "0.8rem", wordBreak: "break-all" }}>
              当前：{selected.path}
            </div>
          )}
          {clipInfo && (
            <div className="clipboard-banner">
              剪贴板：{clipboard?.mode === "cut" ? "剪切" : "复制"}「{clipInfo.name}」
              <button
                type="button"
                className="secondary"
                style={{ marginLeft: 8, padding: "0.15rem 0.5rem" }}
                onClick={() => setClipboard(null)}
              >
                清除
              </button>
            </div>
          )}
          {localError && <div className="error">{localError}</div>}
          {localMsg && <div className="success">{localMsg}</div>}

          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <input
              placeholder={selected ? "在选中目录下新建…" : "在根目录新建…"}
              value={newName}
              disabled={busy || (selected ? !canManageSelected : !canManageRoot)}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key !== "Enter" || !newName.trim() || !onCreate) return;
                setBusy(true);
                setLocalError("");
                try {
                  await onCreate(newName.trim(), selected?.id ?? null);
                  setNewName("");
                  setLocalMsg("已新建");
                } catch (err) {
                  setLocalError(err instanceof Error ? err.message : "创建失败");
                } finally {
                  setBusy(false);
                }
              }}
            />
            <button
              type="button"
              className="secondary"
              disabled={
                busy ||
                !newName.trim() ||
                !onCreate ||
                (selected ? !canManageSelected : !canManageRoot)
              }
              onClick={async () => {
                if (!newName.trim() || !onCreate) return;
                setBusy(true);
                setLocalError("");
                try {
                  await onCreate(newName.trim(), selected?.id ?? null);
                  setNewName("");
                  setLocalMsg("已新建");
                } catch (err) {
                  setLocalError(err instanceof Error ? err.message : "创建失败");
                } finally {
                  setBusy(false);
                }
              }}
            >
              新建
            </button>
          </div>

          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <button
              type="button"
              className="secondary"
              disabled={busy || !selected || !canManageSelected}
              onClick={() => selected && startRename(selected)}
              title="F2 或双击"
            >
              重命名
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || !selected || !canManageSelected}
              onClick={() => {
                if (!selected) return;
                setClipboard({ mode: "cut", folderId: selected.id });
                setLocalMsg(`已剪切「${selected.name}」`);
              }}
              title="Ctrl+X"
            >
              剪切
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || !selected || !canManageSelected}
              onClick={() => {
                if (!selected) return;
                setClipboard({ mode: "copy", folderId: selected.id });
                setLocalMsg(`已复制「${selected.name}」`);
              }}
              title="Ctrl+C"
            >
              复制
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || !clipboard}
              onClick={() => void doPaste(selected?.id ?? null)}
              title="Ctrl+V，粘贴到当前选中目录（或根）"
            >
              粘贴
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy || !selected || !canManageSelected || !onDelete}
              onClick={async () => {
                if (!selected || !onDelete) return;
                if (
                  !confirm(
                    `确认删除空文件夹「${selected.name}」？\n（含条目或子文件夹时无法删除）`
                  )
                ) {
                  return;
                }
                setBusy(true);
                setLocalError("");
                try {
                  await onDelete(selected);
                  setLocalMsg("已删除");
                } catch (err) {
                  setLocalError(err instanceof Error ? err.message : "删除失败");
                } finally {
                  setBusy(false);
                }
              }}
              title="Delete"
            >
              删除
            </button>
          </div>
          <div className="muted" style={{ fontSize: "0.75rem", lineHeight: 1.45 }}>
            拖动文件夹到目标位置可移动；也可将右侧动作条目拖入文件夹。
            <br />
            快捷键：Ctrl+X 剪切 · Ctrl+C 复制 · Ctrl+V 粘贴 · F2 重命名
            <br />
            复制仅复制文件夹结构，不复制动作条目。
          </div>
        </div>
      )}
    </div>
  );
}

export function FolderSelect({
  folders,
  value,
  onChange,
  required,
  disabled,
}: {
  folders: Folder[];
  value: number | "";
  onChange: (id: number | "") => void;
  required?: boolean;
  disabled?: boolean;
}) {
  const sorted = useMemo(
    () => [...folders].sort((a, b) => a.path.localeCompare(b.path, "zh")),
    [folders]
  );
  return (
    <select
      required={required}
      disabled={disabled}
      value={value === "" ? "" : String(value)}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : "")}
    >
      <option value="">选择文件夹…</option>
      {sorted.map((f) => (
        <option key={f.id} value={f.id}>
          {f.path}
        </option>
      ))}
    </select>
  );
}
