import {
  useMemo,
  useState,
  type DragEvent,
} from "react";
import { api } from "../api";
import type { TaxonomyNode, TaxonomyScheme } from "../types";
import { taxonomySchemeLabel } from "../types";

const DND_TAXONOMY = "application/x-noetix-taxonomy-id";

type TreeNode = TaxonomyNode & { children: TreeNode[] };
type DropPos = "before" | "into" | "after";

function buildTree(nodes: TaxonomyNode[]): TreeNode[] {
  const map = new Map<number, TreeNode>();
  nodes.forEach((n) => map.set(n.id, { ...n, children: [] }));
  const roots: TreeNode[] = [];
  for (const n of map.values()) {
    if (n.parent_id != null && map.has(n.parent_id)) {
      map.get(n.parent_id)!.children.push(n);
    } else {
      roots.push(n);
    }
  }
  const sortRec = (list: TreeNode[]) => {
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "zh"));
    list.forEach((c) => sortRec(c.children));
  };
  sortRec(roots);
  return roots;
}

function siblingIds(nodes: TaxonomyNode[], parentId: number | null): number[] {
  return nodes
    .filter((n) => (parentId == null ? n.parent_id == null : n.parent_id === parentId))
    .sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "zh")
    )
    .map((n) => n.id);
}

function isDescendantPath(nodePath: string, ancestorPath: string) {
  return nodePath === ancestorPath || nodePath.startsWith(ancestorPath);
}

function canDropOnto(
  dragging: TaxonomyNode,
  targetId: number | null,
  nodes: TaxonomyNode[]
): boolean {
  if (targetId === dragging.id) return false;
  if (targetId === dragging.parent_id) return false;
  if (targetId == null) return dragging.parent_id != null;
  const target = nodes.find((n) => n.id === targetId);
  if (!target) return false;
  if (isDescendantPath(target.path, dragging.path)) return false;
  return true;
}

function NodeRow({
  node,
  depth,
  selectedId,
  onSelect,
  manageable,
  onCreateChild,
  onRename,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  dragOverId,
  dragOverPos,
  onDragStartNode,
  onDragOverTarget,
  onDragLeaveTarget,
  onDropOnTarget,
}: {
  node: TreeNode;
  depth: number;
  selectedId: number | null;
  onSelect: (n: TaxonomyNode | null) => void;
  manageable?: boolean;
  onCreateChild?: (parent: TaxonomyNode, name: string) => Promise<void>;
  onRename?: (node: TaxonomyNode, name: string) => Promise<void>;
  onDelete?: (node: TaxonomyNode) => Promise<void>;
  onMoveUp?: (node: TaxonomyNode) => Promise<void>;
  onMoveDown?: (node: TaxonomyNode) => Promise<void>;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  dragOverId: number | "root" | null;
  dragOverPos: DropPos | null;
  onDragStartNode: (e: DragEvent, node: TaxonomyNode) => void;
  onDragOverTarget: (e: DragEvent, targetId: number) => void;
  onDragLeaveTarget: (e: DragEvent, targetId: number) => void;
  onDropOnTarget: (e: DragEvent, targetId: number) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(node.name);
  const selected = selectedId === node.id;
  const label = node.code ? `${node.code} ${node.name}` : node.name;
  const isDropTarget = dragOverId === node.id;

  return (
    <div>
      <div
        className={`folder-row ${selected ? "active" : ""} ${
          isDropTarget && dragOverPos === "into" ? "drop-target" : ""
        } ${isDropTarget && dragOverPos === "before" ? "drop-before" : ""} ${
          isDropTarget && dragOverPos === "after" ? "drop-after" : ""
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={Boolean(manageable && !renaming)}
        onDragStart={(e) => onDragStartNode(e, node)}
        onDragOver={(e) => onDragOverTarget(e, node.id)}
        onDragLeave={(e) => onDragLeaveTarget(e, node.id)}
        onDrop={(e) => onDropOnTarget(e, node.id)}
        onClick={() => onSelect(node)}
        onDoubleClick={() => {
          if (manageable && onRename) {
            setRenaming(true);
            setRenameVal(node.name);
          }
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
        {renaming ? (
          <input
            className="folder-rename-input"
            autoFocus
            value={renameVal}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && onRename) {
                await onRename(node, renameVal.trim());
                setRenaming(false);
              }
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={async () => {
              if (onRename && renameVal.trim() && renameVal.trim() !== node.name) {
                await onRename(node, renameVal.trim());
              }
              setRenaming(false);
            }}
          />
        ) : (
          <span
            className="folder-name"
            title={
              manageable
                ? `${node.path}\n拖拽可排序或移入其他节点；↑↓ 同级调整`
                : node.path
            }
          >
            {label}
            {node.clip_count > 0 && (
              <span className="muted folder-meta"> ({node.clip_count})</span>
            )}
          </span>
        )}
        {manageable && onMoveUp && (
          <button
            type="button"
            className="secondary"
            title="上移"
            disabled={!canMoveUp}
            style={{ padding: "0 0.3rem", fontSize: "0.75rem" }}
            onClick={async (e) => {
              e.stopPropagation();
              await onMoveUp(node);
            }}
          >
            ↑
          </button>
        )}
        {manageable && onMoveDown && (
          <button
            type="button"
            className="secondary"
            title="下移"
            disabled={!canMoveDown}
            style={{ padding: "0 0.3rem", fontSize: "0.75rem" }}
            onClick={async (e) => {
              e.stopPropagation();
              await onMoveDown(node);
            }}
          >
            ↓
          </button>
        )}
        {manageable && onCreateChild && (
          <button
            type="button"
            className="secondary"
            title="新建子节点"
            style={{ padding: "0 0.35rem", fontSize: "0.8rem" }}
            onClick={async (e) => {
              e.stopPropagation();
              const name = prompt("新节点名称");
              if (!name?.trim()) return;
              await onCreateChild(node, name.trim());
            }}
          >
            +
          </button>
        )}
        {manageable && onDelete && (
          <button
            type="button"
            className="danger"
            title="删除"
            style={{ padding: "0 0.35rem", fontSize: "0.8rem" }}
            onClick={async (e) => {
              e.stopPropagation();
              if (!confirm(`删除「${node.name}」？`)) return;
              await onDelete(node);
            }}
          >
            ×
          </button>
        )}
      </div>
      {open &&
        node.children.map((c, idx) => (
          <NodeRow
            key={c.id}
            node={c}
            depth={depth + 1}
            selectedId={selectedId}
            onSelect={onSelect}
            manageable={manageable}
            onCreateChild={onCreateChild}
            onRename={onRename}
            onDelete={onDelete}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            canMoveUp={idx > 0}
            canMoveDown={idx < node.children.length - 1}
            dragOverId={dragOverId}
            dragOverPos={dragOverPos}
            onDragStartNode={onDragStartNode}
            onDragOverTarget={onDragOverTarget}
            onDragLeaveTarget={onDragLeaveTarget}
            onDropOnTarget={onDropOnTarget}
          />
        ))}
    </div>
  );
}

export function TaxonomyTree({
  nodes,
  selectedId,
  onSelect,
  manageable = false,
  onCreateChild,
  onRename,
  onDelete,
  onCreateRoot,
  onMove,
  onReorder,
  scheme,
}: {
  nodes: TaxonomyNode[];
  selectedId: number | null;
  onSelect: (n: TaxonomyNode | null) => void;
  manageable?: boolean;
  onCreateChild?: (parent: TaxonomyNode, name: string) => Promise<void>;
  onRename?: (node: TaxonomyNode, name: string) => Promise<void>;
  onDelete?: (node: TaxonomyNode) => Promise<void>;
  onCreateRoot?: (name: string) => Promise<void>;
  onMove?: (node: TaxonomyNode, parentId: number | null) => Promise<void>;
  onReorder?: (parentId: number | null, orderedIds: number[]) => Promise<void>;
  scheme?: TaxonomyScheme;
}) {
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const [dragOverId, setDragOverId] = useState<number | "root" | null>(null);
  const [dragOverPos, setDragOverPos] = useState<DropPos | null>(null);
  const [busy, setBusy] = useState(false);

  const onDragStartNode = (e: DragEvent, node: TaxonomyNode) => {
    if (!manageable) return;
    e.dataTransfer.setData(DND_TAXONOMY, String(node.id));
    e.dataTransfer.setData("text/plain", node.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const calcDropPos = (e: DragEvent): DropPos => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const ratio = y / Math.max(rect.height, 1);
    if (ratio < 0.28) return "before";
    if (ratio > 0.72) return "after";
    return "into";
  };

  const onDragOverTarget = (e: DragEvent, targetId: number | "root") => {
    const types = Array.from(e.dataTransfer.types || []);
    const hasTax = types.some(
      (t) => t === DND_TAXONOMY || t.toLowerCase() === DND_TAXONOMY
    );
    if (!hasTax && !types.includes("text/plain")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(targetId);
    setDragOverPos(targetId === "root" ? "into" : calcDropPos(e));
  };

  const onDragLeaveTarget = (e: DragEvent, targetId: number | "root") => {
    const related = e.relatedTarget as globalThis.Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setDragOverId((cur) => (cur === targetId ? null : cur));
    setDragOverPos(null);
  };

  const reorderAmong = async (
    dragging: TaxonomyNode,
    target: TaxonomyNode,
    pos: "before" | "after"
  ) => {
    if (!onReorder) return;
    const parentId = target.parent_id;
    if (dragging.parent_id !== parentId) {
      if (!onMove) return;
      await onMove(dragging, parentId);
      const ids = siblingIds(nodes, parentId).filter((id) => id !== dragging.id);
      const tIdx = ids.indexOf(target.id);
      const insertAt = pos === "before" ? tIdx : tIdx + 1;
      ids.splice(Math.max(0, insertAt), 0, dragging.id);
      await onReorder(parentId, ids);
      return;
    }
    const ids = siblingIds(nodes, parentId).filter((id) => id !== dragging.id);
    const tIdx = ids.indexOf(target.id);
    const insertAt = pos === "before" ? tIdx : tIdx + 1;
    ids.splice(Math.max(0, insertAt), 0, dragging.id);
    setBusy(true);
    try {
      await onReorder(parentId, ids);
    } finally {
      setBusy(false);
    }
  };

  const onDropOnTarget = async (e: DragEvent, targetId: number | "root") => {
    e.preventDefault();
    e.stopPropagation();
    const pos = targetId === "root" ? "into" : dragOverPos || calcDropPos(e);
    setDragOverId(null);
    setDragOverPos(null);
    if (!manageable || busy) return;

    const raw = e.dataTransfer.getData(DND_TAXONOMY);
    if (!raw) return;
    const dragging = nodes.find((n) => n.id === Number(raw));
    if (!dragging) return;

    if (targetId === "root") {
      if (onMove && canDropOnto(dragging, null, nodes)) {
        setBusy(true);
        try {
          await onMove(dragging, null);
        } finally {
          setBusy(false);
        }
      }
      return;
    }

    const target = nodes.find((n) => n.id === targetId);
    if (!target) return;

    if (pos === "into") {
      if (!onMove || !canDropOnto(dragging, target.id, nodes)) return;
      setBusy(true);
      try {
        await onMove(dragging, target.id);
      } finally {
        setBusy(false);
      }
      return;
    }

    if (onReorder) {
      if (isDescendantPath(target.path, dragging.path) && target.id !== dragging.id) {
        return;
      }
      await reorderAmong(dragging, target, pos);
    } else if (onMove) {
      await onMove(dragging, target.id);
    }
  };

  const moveSibling = async (node: TaxonomyNode, dir: -1 | 1) => {
    if (!onReorder) return;
    const ids = siblingIds(nodes, node.parent_id);
    const idx = ids.indexOf(node.id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= ids.length) return;
    const next = [...ids];
    next[idx] = ids[target];
    next[target] = ids[idx];
    setBusy(true);
    try {
      await onReorder(node.parent_id, next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="folder-tree">
      <div
        className={`folder-row ${selectedId == null ? "active" : ""} ${
          dragOverId === "root" ? "drop-target" : ""
        }`}
        onClick={() => onSelect(null)}
        onDragOver={(e) => onDragOverTarget(e, "root")}
        onDragLeave={(e) => onDragLeaveTarget(e, "root")}
        onDrop={(e) => onDropOnTarget(e, "root")}
      >
        <span className="folder-name">
          全部{scheme ? `（${taxonomySchemeLabel(scheme)}）` : ""}
        </span>
      </div>
      {manageable && (
        <p className="muted" style={{ margin: "0 0 6px", fontSize: "0.8rem" }}>
          拖拽：上/下边缘同级排序，中间移入父节点；↑↓ 也可调序（序号随序更新）
        </p>
      )}
      <div className="folder-tree-list">
        {tree.map((n, idx) => (
          <NodeRow
            key={n.id}
            node={n}
            depth={0}
            selectedId={selectedId}
            onSelect={onSelect}
            manageable={manageable}
            onCreateChild={onCreateChild}
            onRename={onRename}
            onDelete={onDelete}
            onMoveUp={(node) => moveSibling(node, -1)}
            onMoveDown={(node) => moveSibling(node, 1)}
            canMoveUp={idx > 0}
            canMoveDown={idx < tree.length - 1}
            dragOverId={dragOverId}
            dragOverPos={dragOverPos}
            onDragStartNode={onDragStartNode}
            onDragOverTarget={onDragOverTarget}
            onDragLeaveTarget={onDragLeaveTarget}
            onDropOnTarget={onDropOnTarget}
          />
        ))}
      </div>
      {manageable && onCreateRoot && (
        <button
          type="button"
          className="secondary"
          style={{ marginTop: 8 }}
          onClick={async () => {
            const name = prompt("根节点名称");
            if (!name?.trim()) return;
            await onCreateRoot(name.trim());
          }}
        >
          新建根节点
        </button>
      )}
    </div>
  );
}

function optionLabel(n: TaxonomyNode): string {
  return n.code ? `${n.code} ${n.name}` : n.name;
}

/** 一级一级联动选择；可停在任意层级；可在当前级快速新建缺失类别。 */
export function TaxonomySelect({
  nodes,
  value,
  onChange,
  disabled,
  allowEmpty = true,
  scheme,
  canCreate = false,
  onNodesReload,
}: {
  nodes: TaxonomyNode[];
  value: number | "";
  onChange: (id: number | "") => void;
  disabled?: boolean;
  allowEmpty?: boolean;
  scheme?: TaxonomyScheme;
  canCreate?: boolean;
  /** 新建成功后刷新节点列表 */
  onNodesReload?: () => Promise<void> | void;
}) {
  const [addingParentId, setAddingParentId] = useState<number | null | undefined>(
    undefined
  );
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  const resolvedScheme = scheme || nodes[0]?.scheme;

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const childrenOf = useMemo(() => {
    const m = new Map<number | null, TaxonomyNode[]>();
    for (const n of nodes) {
      const pid = n.parent_id;
      if (!m.has(pid)) m.set(pid, []);
      m.get(pid)!.push(n);
    }
    for (const list of m.values()) {
      list.sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "zh")
      );
    }
    return m;
  }, [nodes]);

  const schemeRoot = useMemo(() => {
    const roots = childrenOf.get(null) || [];
    return roots.length === 1 ? roots[0] : null;
  }, [childrenOf]);

  /** 从体系根之下到当前选中的 id 链 */
  const chain = useMemo(() => {
    if (value === "" || value == null) return [] as number[];
    const path: number[] = [];
    let cur: TaxonomyNode | undefined = byId.get(Number(value));
    while (cur) {
      path.unshift(cur.id);
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
    }
    if (schemeRoot && path[0] === schemeRoot.id) {
      return path.slice(1);
    }
    return path;
  }, [value, byId, schemeRoot]);

  const levels = useMemo(() => {
    const result: {
      parentId: number | null;
      options: TaxonomyNode[];
      selected: number | "";
    }[] = [];
    let parentId: number | null = schemeRoot ? schemeRoot.id : null;
    for (let depth = 0; depth < 24; depth++) {
      const options = childrenOf.get(parentId) || [];
      const selected = (chain[depth] as number | undefined) ?? "";
      if (!options.length) {
        if (canCreate && (depth === 0 || chain[depth - 1] != null)) {
          result.push({ parentId, options: [], selected: "" });
        }
        break;
      }
      result.push({ parentId, options, selected });
      if (selected === "") break;
      parentId = selected;
    }
    if (canCreate && result.length) {
      const last = result[result.length - 1];
      if (last.selected !== "" && !(childrenOf.get(last.selected) || []).length) {
        result.push({ parentId: last.selected as number, options: [], selected: "" });
      }
    }
    return result;
  }, [childrenOf, schemeRoot, chain, canCreate]);

  const current = value === "" || value == null ? null : byId.get(Number(value)) || null;

  const onLevelChange = (depth: number, next: number | "") => {
    setAddingParentId(undefined);
    setLocalError("");
    if (next === "") {
      if (depth === 0) {
        onChange("");
      } else {
        onChange(chain[depth - 1] ?? "");
      }
      return;
    }
    onChange(next);
  };

  const submitCreate = async () => {
    if (!resolvedScheme || addingParentId === undefined) return;
    const name = newName.trim();
    if (!name) {
      setLocalError("请输入名称");
      return;
    }
    setBusy(true);
    setLocalError("");
    try {
      const created = await api.createTaxonomyNode({
        scheme: resolvedScheme,
        parent_id: addingParentId,
        name,
      });
      setNewName("");
      setAddingParentId(undefined);
      await onNodesReload?.();
      onChange(created.id);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  if (!nodes.length && !canCreate) {
    return <div className="muted">暂无分类节点</div>;
  }

  return (
    <div className={`taxonomy-cascade ${disabled ? "is-disabled" : ""}`}>
      <div className="taxonomy-cascade-levels">
        {levels.map((level, depth) => (
          <div key={depth} className="taxonomy-cascade-level">
            <span className="taxonomy-cascade-level-label">{depth + 1} 级</span>
            <div className="taxonomy-cascade-level-row">
              <select
                disabled={disabled || busy}
                value={level.selected === "" ? "" : String(level.selected)}
                onChange={(e) =>
                  onLevelChange(depth, e.target.value ? Number(e.target.value) : "")
                }
              >
                <option value="">
                  {level.options.length
                    ? depth === 0
                      ? "请选择…"
                      : "（停在上一级）"
                    : "（尚无子类，可新建）"}
                </option>
                {level.options.map((n) => (
                  <option key={n.id} value={n.id}>
                    {optionLabel(n)}
                  </option>
                ))}
              </select>
              {canCreate && !disabled && (
                <button
                  type="button"
                  className="secondary"
                  title="在此级新建类别"
                  disabled={busy}
                  onClick={() => {
                    setLocalError("");
                    setNewName("");
                    setAddingParentId(level.parentId);
                  }}
                >
                  +
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {canCreate && addingParentId !== undefined && !disabled && (
        <div className="taxonomy-cascade-add">
          <input
            autoFocus
            placeholder="新类别名称"
            value={newName}
            disabled={busy}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitCreate();
              }
              if (e.key === "Escape") setAddingParentId(undefined);
            }}
          />
          <button type="button" disabled={busy} onClick={() => void submitCreate()}>
            {busy ? "创建中…" : "创建并选用"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setAddingParentId(undefined)}
          >
            取消
          </button>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {addingParentId == null
              ? "将创建为根级"
              : `父级：${byId.get(addingParentId)?.path || `#${addingParentId}`}`}
          </span>
        </div>
      )}

      {localError && <div className="error">{localError}</div>}

      <div className="taxonomy-cascade-footer">
        {current ? (
          <span className="muted taxonomy-cascade-current" title={current.path}>
            已选：{optionLabel(current)}
            <span className="taxonomy-cascade-path"> {current.path}</span>
          </span>
        ) : (
          <span className="muted">未选择</span>
        )}
        {allowEmpty && current && !disabled && (
          <button type="button" className="secondary" onClick={() => onChange("")}>
            清除
          </button>
        )}
        {canCreate && current && !disabled && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setLocalError("");
              setNewName("");
              setAddingParentId(current.id);
            }}
          >
            在已选下新建
          </button>
        )}
      </div>
    </div>
  );
}
