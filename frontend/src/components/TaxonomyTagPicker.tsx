import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { useUndoOptional } from "../undo/UndoContext";
import type { TaxonomyNode, TaxonomySchemeDef } from "../types";
import {
  childrenByParent,
  selectionAfterCheck,
  selectionCovers,
  specificTagIds,
  tagIdList,
  taxonomySchemeLabel,
} from "../types";

function summaryOf(ids: number[], nodes: TaxonomyNode[]) {
  const names = ids
    .map((id) => nodes.find((node) => node.id === id)?.name)
    .filter((name): name is string => !!name);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}

function CheckTree({
  nodes,
  checked,
  onToggle,
  canCreate,
  busy,
  onCreate,
}: {
  nodes: TaxonomyNode[];
  checked: number[];
  onToggle: (id: number) => void;
  canCreate?: boolean;
  busy?: boolean;
  onCreate?: (parentId: number | null, name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [addingParent, setAddingParent] = useState<number | null | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const children = childrenByParent(nodes);
  const picked = new Set(checked);
  children.forEach((list) =>
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "zh"))
  );
  const roots = children.get(null) || [];
  const topParentId = roots.length === 1 ? roots[0].id : null;
  const top = roots.length === 1 ? children.get(roots[0].id) || [] : roots;

  const startAdd = (parentId: number | null) => {
    setDraft("");
    setAddingParent(parentId);
    if (parentId != null) setOpen((current) => ({ ...current, [parentId]: true }));
  };

  const commitAdd = async () => {
    const name = draft.trim();
    if (!name || addingParent === undefined || !onCreate) return;
    await onCreate(addingParent, name);
    setDraft("");
    setAddingParent(undefined);
  };

  const addEditor = (parentId: number | null, depth: number) =>
    addingParent === parentId ? (
      <div className="facet-node-add" style={{ paddingLeft: depth * 16 + 18 }}>
        <input
          autoFocus
          value={draft}
          disabled={busy}
          placeholder="新节点名称"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitAdd();
            } else if (event.key === "Escape") {
              setAddingParent(undefined);
            }
          }}
        />
        <button type="button" disabled={busy || !draft.trim()} onClick={() => void commitAdd()}>
          {busy ? "…" : "确定"}
        </button>
      </div>
    ) : null;

  const renderNode = (node: TaxonomyNode, depth: number) => {
    const kids = children.get(node.id) || [];
    const expanded = open[node.id] === true || addingParent === node.id;
    return (
      <div key={node.id}>
        <div className="facet-check" style={{ paddingLeft: depth * 16 }}>
          {kids.length || addingParent === node.id ? (
            <button
              type="button"
              className="facet-twist"
              aria-label={expanded ? "收起" : "展开"}
              onClick={() => setOpen((current) => ({ ...current, [node.id]: !expanded }))}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="facet-twist" />
          )}
          <label className="facet-check-main">
            <input
              type="checkbox"
              checked={selectionCovers(node.id, picked, children)}
              onChange={() => onToggle(node.id)}
            />
            <span className="facet-node-name" title={node.path || node.name}>
              {node.name}
            </span>
          </label>
          {canCreate && (
            <button
              type="button"
              className="facet-add"
              title={`在「${node.name}」下新建`}
              disabled={busy}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => startAdd(node.id)}
            >
              +
            </button>
          )}
        </div>
        {expanded && addEditor(node.id, depth + 1)}
        {kids.length > 0 && expanded && kids.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  if (!nodes.length && !canCreate) return <div className="muted">该分类暂无标签</div>;
  return (
    <div className="facet-tree">
      {top.map((node) => renderNode(node, 0))}
      {canCreate &&
        (addingParent === topParentId ? (
          addEditor(topParentId, 0)
        ) : (
          <button
            type="button"
            className="facet-add-line"
            disabled={busy}
            onClick={() => startAdd(topParentId)}
          >
            + 新建同级
          </button>
        ))}
    </div>
  );
}

export function TaxonomyTagPicker({
  schemes,
  nodes,
  value,
  onChange,
  canCreate,
  onNodesReload,
  disabled,
  inherited,
  placeholders,
  readOnly,
}: {
  schemes: TaxonomySchemeDef[];
  nodes: TaxonomyNode[];
  value: Record<string, number | number[] | "">;
  onChange: (scheme: string, ids: number[]) => void;
  canCreate?: boolean;
  onNodesReload?: () => Promise<void> | void;
  disabled?: boolean;
  inherited?: Record<string, string>;
  placeholders?: Record<string, string>;
  readOnly?: boolean;
}) {
  const history = useUndoOptional();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (!openKey) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("[data-taxonomy-picker]")) return;
      setOpenKey(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openKey]);

  const submitCreate = async (scheme: string, parentId: number | null, name: string, checked: number[]) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setLocalError("请输入名称");
      return;
    }
    setBusy(true);
    setLocalError("");
    let createdId = 0;
    try {
      const run = async () => {
        const created = await api.createTaxonomyNode({
          scheme,
          parent_id: parentId,
          name: trimmed,
        });
        createdId = created.id;
        await onNodesReload?.();
      };
      if (history) {
        await history.execute({
          label: `新建分类「${trimmed}」`,
          do: run,
          undo: async () => {
            if (createdId) await api.deleteTaxonomyNode(createdId);
            await onNodesReload?.();
          },
        });
      } else {
        await run();
      }
      if (createdId && !checked.includes(createdId)) {
        onChange(
          scheme,
          selectionAfterCheck(
            createdId,
            nodes.filter((node) => node.scheme === scheme),
            checked,
            parentId
          )
        );
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "创建失败");
      throw error;
    } finally {
      setBusy(false);
    }
  };

  if (!schemes.length) return <div className="muted">分类标准加载中…</div>;

  return (
    <div className="facet-list taxonomy-tag-picker" data-taxonomy-picker>
      {schemes.map((scheme) => {
        const schemeNodes = nodes.filter((node) => node.scheme === scheme.key);
        const picked = specificTagIds(tagIdList(value[scheme.key]), schemeNodes);
        const open = openKey === scheme.key;
        const ownSummary = summaryOf(picked, schemeNodes);
        const inheritedText = !ownSummary ? inherited?.[scheme.key] || "" : "";
        const placeholderText =
          !ownSummary && !inheritedText ? placeholders?.[scheme.key] || "" : "";
        const summary =
          ownSummary || (inheritedText ? `沿用 ${inheritedText}` : placeholderText);
        return (
          <TagChip
            key={scheme.key}
            label={taxonomySchemeLabel(scheme.key, schemes)}
            summary={summary}
            picked={picked.length > 0}
            mixed={!!placeholderText}
            open={open && !readOnly}
            disabled={disabled}
            readOnly={readOnly}
            onToggle={() => {
              if (readOnly) return;
              setLocalError("");
              setOpenKey((current) => (current === scheme.key ? null : scheme.key));
            }}
          >
            <CheckTree
              nodes={schemeNodes}
              checked={picked}
              canCreate={canCreate && !disabled}
              busy={busy}
              onToggle={(id) => {
                onChange(scheme.key, selectionAfterCheck(id, schemeNodes, picked));
              }}
              onCreate={async (parentId, name) => {
                await submitCreate(scheme.key, parentId, name, picked);
              }}
            />
            {localError && <div className="error">{localError}</div>}
          </TagChip>
        );
      })}
    </div>
  );
}

function TagChip({
  label,
  summary,
  picked,
  mixed,
  open,
  disabled,
  readOnly,
  onToggle,
  children,
}: {
  label: string;
  summary: string;
  picked: boolean;
  mixed?: boolean;
  open: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const width = 280;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      const upward = spaceBelow < 180 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(120, Math.min(280, upward ? spaceAbove : spaceBelow));
      setBox({
        top: upward ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4,
        left,
        maxHeight,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  return (
    <div className={`facet-item${open ? " is-open" : ""}`}>
      <button
        ref={anchorRef}
        type="button"
        className={`facet-chip${open ? " is-open" : ""}${picked ? " is-picked" : ""}${mixed ? " is-mixed" : ""}${readOnly ? " is-readonly" : ""}`}
        disabled={disabled}
        onClick={onToggle}
      >
        <span>{label}</span>
        {summary && <span className="facet-summary">{summary}</span>}
        {!readOnly && <span className="facet-chevron">{open ? "▴" : "▾"}</span>}
      </button>
      {open && box && (
        <div
          className="facet-pop is-editor"
          style={{
            position: "fixed",
            top: box.top,
            left: box.left,
            maxHeight: box.maxHeight,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
