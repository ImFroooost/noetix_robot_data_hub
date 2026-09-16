import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { api, getToken } from "../api";
import type { ClipListItem, RepoPack, TaxonomyNode } from "../types";

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

function NodeBranch({
  node,
  depth,
  scheme,
  selectedNodeId,
  selectedClipId,
  onSelectNode,
  onSelectClip,
  clipsByNode,
  packsByNode,
  loadChildren,
  openIds,
  setOpenIds,
  extraFilters,
}: {
  node: TreeNode;
  depth: number;
  scheme: string;
  selectedNodeId: number | null;
  selectedClipId: number | null;
  onSelectNode: (n: TaxonomyNode) => void;
  onSelectClip: (clip: ClipListItem) => void;
  clipsByNode: Record<number, ClipListItem[] | undefined>;
  packsByNode: Record<number, RepoPack[] | undefined>;
  loadChildren: (nodeId: number) => void;
  openIds: Set<number>;
  setOpenIds: (fn: (prev: Set<number>) => Set<number>) => void;
  extraFilters: Record<string, string | number | boolean | undefined | null>;
}) {
  const open = openIds.has(node.id);
  const clips = clipsByNode[node.id];
  const packs = packsByNode[node.id];
  const active = selectedNodeId === node.id;
  const label = node.code ? `${node.code} ${node.name}` : node.name;
  const count = node.clip_count ?? 0;
  const loading = open && (clips === undefined || packs === undefined);

  useEffect(() => {
    if (open && (clips === undefined || packs === undefined)) loadChildren(node.id);
  }, [open, clips, packs, node.id, loadChildren]);

  const toggle = () => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  };

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
          onSelectNode(node);
          if (!open) toggle();
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
          {node.children.length || count > 0 ? (open ? "▾" : "▸") : "·"}
        </button>
        <span className="folder-name" title={node.path}>
          {label}
        </span>
        <span className="muted folder-meta">{count}</span>
      </div>
      {open && (
        <>
          {node.children.map((c) => (
            <NodeBranch
              key={c.id}
              node={c}
              depth={depth + 1}
              scheme={scheme}
              selectedNodeId={selectedNodeId}
              selectedClipId={selectedClipId}
              onSelectNode={onSelectNode}
              onSelectClip={onSelectClip}
              clipsByNode={clipsByNode}
              packsByNode={packsByNode}
              loadChildren={loadChildren}
              openIds={openIds}
              setOpenIds={setOpenIds}
              extraFilters={extraFilters}
            />
          ))}
          {loading && (
            <div className="muted" style={{ paddingLeft: 24 + depth * 14, fontSize: "0.8rem" }}>
              加载条目…
            </div>
          )}
          {packs?.map((pack) => (
            <div
              key={pack.key}
              className="folder-row browse-clip-row"
              style={{
                paddingLeft: 24 + depth * 14,
                display: "flex",
              }}
              title={`${pack.source_name} · ${pack.file_count} 文件`}
            >
              <span className="browse-clip-dot" style={{ background: "var(--accent, #3b82f6)" }} />
              <span className="folder-name">{pack.source_name}</span>
              <span className="muted folder-meta">{pack.file_count}文件</span>
            </div>
          ))}
          {clips?.map((clip) => (
            <div
              key={clip.id}
              className={`folder-row browse-clip-row ${
                selectedClipId === clip.id ? "active" : ""
              }`}
              style={{ paddingLeft: 24 + depth * 14 }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectClip(clip);
              }}
              title={clip.action_name || clip.summary}
            >
              <Thumb clipId={clip.id} />
              <span className="folder-name">
                {clip.action_name || clip.summary || `#${clip.id}`}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

interface Props {
  nodes: TaxonomyNode[];
  scheme: string;
  selectedNodeId: number | null;
  selectedClipId: number | null;
  onSelectNode: (n: TaxonomyNode | null) => void;
  onSelectClip: (clip: ClipListItem) => void;
  refreshKey?: number;
  extraFilters?: Record<string, string | number | boolean | undefined | null>;
}

export function TaxonomyBrowseTree({
  nodes,
  scheme,
  selectedNodeId,
  selectedClipId,
  onSelectNode,
  onSelectClip,
  refreshKey = 0,
  extraFilters = {},
}: Props) {
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set());
  const [clipsByNode, setClipsByNode] = useState<
    Record<number, ClipListItem[] | undefined>
  >({});
  const [packsByNode, setPacksByNode] = useState<
    Record<number, RepoPack[] | undefined>
  >({});

  useEffect(() => {
    if (!tree.length) return;
    setOpenIds((prev) => {
      if (prev.size) return prev;
      return new Set(tree.slice(0, 4).map((n) => n.id));
    });
  }, [tree]);

  useEffect(() => {
    setClipsByNode({});
    setPacksByNode({});
    setOpenIds(new Set());
  }, [scheme, refreshKey]);

  const filterKey = JSON.stringify(extraFilters);
  useEffect(() => {
    setClipsByNode({});
    setPacksByNode({});
  }, [filterKey]);

  const loadChildren = useCallback(
    async (nodeId: number) => {
      try {
        const pageSize = 100;
        const [first, packs] = await Promise.all([
          api.search({
            taxonomy_scheme: scheme,
            tag_id: nodeId,
            tag_exact: true,
            page: 1,
            page_size: pageSize,
            sort_by: "created_at",
            sort_dir: "desc",
            ...extraFilters,
          }),
          api.repoListPacks({
            taxonomy_scheme: scheme,
            tag_id: nodeId,
            tag_exact: true,
            q: typeof extraFilters.q === "string" ? extraFilters.q : undefined,
          }),
        ]);
        const items = [...first.items];
        const totalPages = Math.max(1, Math.ceil(first.total / pageSize));
        for (let p = 2; p <= totalPages; p++) {
          const more = await api.search({
            taxonomy_scheme: scheme,
            tag_id: nodeId,
            tag_exact: true,
            page: p,
            page_size: pageSize,
            sort_by: "created_at",
            sort_dir: "desc",
            ...extraFilters,
          });
          items.push(...more.items);
        }
        setClipsByNode((prev) => ({ ...prev, [nodeId]: items }));
        setPacksByNode((prev) => ({ ...prev, [nodeId]: packs }));
      } catch {
        setClipsByNode((prev) => ({ ...prev, [nodeId]: [] }));
        setPacksByNode((prev) => ({ ...prev, [nodeId]: [] }));
      }
    },
    [scheme, extraFilters]
  );

  return (
    <div className="folder-tree browse-tree">
      <div
        className={`folder-row ${selectedNodeId == null ? "active" : ""}`}
        onClick={() => onSelectNode(null)}
      >
        <span className="folder-name">全部（本分类标准）</span>
      </div>
      <div className="folder-tree-list browse-tree-list">
        {tree.map((n) => (
          <NodeBranch
            key={n.id}
            node={n}
            depth={0}
            scheme={scheme}
            selectedNodeId={selectedNodeId}
            selectedClipId={selectedClipId}
            onSelectNode={onSelectNode}
            onSelectClip={onSelectClip}
            clipsByNode={clipsByNode}
            packsByNode={packsByNode}
            loadChildren={loadChildren}
            openIds={openIds}
            setOpenIds={setOpenIds}
            extraFilters={extraFilters}
          />
        ))}
        {!tree.length && <div className="muted">暂无分类节点</div>}
      </div>
    </div>
  );
}
