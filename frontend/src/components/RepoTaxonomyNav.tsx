import { useMemo, useState, type CSSProperties } from "react";
import type { TaxonomyNode } from "../types";

type TreeNode = TaxonomyNode & { children: TreeNode[] };

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

function Branch({
  node,
  depth,
  selectedId,
  openIds,
  setOpenIds,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedId: number | null;
  openIds: Set<number>;
  setOpenIds: (fn: (prev: Set<number>) => Set<number>) => void;
  onSelect: (n: TaxonomyNode) => void;
}) {
  const open = openIds.has(node.id);
  const active = selectedId === node.id;
  const label = node.code ? `${node.code} ${node.name}` : node.name;
  const hasKids = node.children.length > 0;

  return (
    <div>
      <div
        className={`folder-row browse-folder-row ${active ? "active" : ""}`}
        style={
          {
            paddingLeft: 8 + depth * 14,
            "--tree-depth": depth,
          } as CSSProperties
        }
        onClick={() => {
          onSelect(node);
          if (hasKids && !open) {
            setOpenIds((prev) => new Set(prev).add(node.id));
          }
        }}
      >
        <button
          type="button"
          className="folder-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setOpenIds((prev) => {
              const next = new Set(prev);
              if (next.has(node.id)) next.delete(node.id);
              else next.add(node.id);
              return next;
            });
          }}
        >
          {hasKids || (node.clip_count ?? 0) > 0 ? (open ? "▾" : "▸") : "·"}
        </button>
        <span className="folder-name">{label}</span>
        <span className="muted folder-meta">{node.clip_count ?? 0}</span>
      </div>
      {open &&
        node.children.map((c) => (
          <Branch
            key={c.id}
            node={c}
            depth={depth + 1}
            selectedId={selectedId}
            openIds={openIds}
            setOpenIds={setOpenIds}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

/** 维度仓库用的分类树导航（仅选节点，不嵌套条目） */
export function RepoTaxonomyNav(props: {
  nodes: TaxonomyNode[];
  selectedId: number | null;
  onSelect: (n: TaxonomyNode | null) => void;
}) {
  const { nodes, selectedId, onSelect } = props;
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  // 唯一根节点时隐藏它，直接展示其子节点作为顶层
  const visibleRoots = tree.length === 1 ? tree[0].children : tree;
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set());

  if (!nodes.length) {
    return <div className="muted">暂无分类节点，请先到「分类管理」维护</div>;
  }

  return (
    <div className="stack" style={{ gap: 4 }}>
      <button
        type="button"
        className={`secondary ${selectedId == null ? "active" : ""}`}
        style={{ alignSelf: "flex-start" }}
        onClick={() => onSelect(null)}
      >
        全部（当前标准）
      </button>
      {visibleRoots.map((n) => (
        <Branch
          key={n.id}
          node={n}
          depth={0}
          selectedId={selectedId}
          openIds={openIds}
          setOpenIds={setOpenIds}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
