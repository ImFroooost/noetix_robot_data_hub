import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ResizableColumns, ResizableHeight } from "../components/ResizableColumns";
import { TaxonomyTree } from "../components/TaxonomyTree";
import type { TaxonomyNode, TaxonomySchemeDef } from "../types";
import { taxonomySchemeLabel } from "../types";

export function TaxonomyManagePage() {
  const { hasPerm } = useAuth();
  const canManageTaxonomy = hasPerm("manage_data");
  const [schemes, setSchemes] = useState<TaxonomySchemeDef[]>([]);
  const [scheme, setScheme] = useState<string>("style");
  const [nodes, setNodes] = useState<TaxonomyNode[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [newSchemeName, setNewSchemeName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [s, all] = await Promise.all([
      api.listTaxonomySchemes(),
      api.listTaxonomies(),
    ]);
    setSchemes(s);
    setNodes(all);
    if (s.length && !s.some((x) => x.key === scheme)) {
      setScheme(s[0].key);
      setRenameValue(s[0].name);
    } else {
      const cur = s.find((x) => x.key === scheme);
      if (cur) setRenameValue(cur.name);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const rows = await api.listTaxonomySchemes();
        for (const row of rows) {
          await api.renumberTaxonomyScheme(row.key);
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "加载失败");
      }
    })();
  }, []);

  const schemeNodes = useMemo(
    () => nodes.filter((n) => n.scheme === scheme),
    [nodes, scheme]
  );
  const selected = schemeNodes.find((n) => n.id === selectedId) || null;
  const currentScheme = schemes.find((s) => s.key === scheme) || null;
  const schemeIndex = schemes.findIndex((s) => s.key === scheme);

  if (!canManageTaxonomy) {
    return <div className="page error">需要管理数据权限</div>;
  }

  const selectScheme = (key: string) => {
    setScheme(key);
    setSelectedId(null);
    const cur = schemes.find((s) => s.key === key);
    setRenameValue(cur?.name || "");
  };

  const onRestoreScheme = async () => {
    if (!currentScheme?.builtin) return;
    const ok = window.confirm(
      `把「${currentScheme.name}」恢复成内置标准树？\n会按标准结构改回父子层级和编码，已有节点和已打标签会保留。`
    );
    if (!ok) return;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const result = await api.restoreTaxonomyScheme(currentScheme.key);
      await load();
      setMsg(
        result.missing.length
          ? `已恢复标准结构，调整 ${result.moved} 个节点；标准中缺少：${result.missing.join("、")}`
          : `已恢复标准结构，调整 ${result.moved} 个节点`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "恢复失败");
    } finally {
      setBusy(false);
    }
  };

  const onRenameScheme = async () => {
    if (!currentScheme) return;
    const name = renameValue.trim();
    if (!name || name === currentScheme.name) return;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await api.updateTaxonomyScheme(currentScheme.key, { name });
      await load();
      setMsg(`已重命名为「${name}」`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "重命名失败");
      setRenameValue(currentScheme.name);
    } finally {
      setBusy(false);
    }
  };

  const onMoveScheme = async (dir: -1 | 1) => {
    if (schemeIndex < 0) return;
    const target = schemeIndex + dir;
    if (target < 0 || target >= schemes.length) return;
    const keys = schemes.map((s) => s.key);
    const tmp = keys[schemeIndex];
    keys[schemeIndex] = keys[target];
    keys[target] = tmp;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const next = await api.reorderTaxonomySchemes(keys);
      setSchemes(next);
      await load();
      setMsg(dir < 0 ? "已左移，序号已重编" : "已右移，序号已重编");
    } catch (e) {
      setError(e instanceof Error ? e.message : "排序失败");
    } finally {
      setBusy(false);
    }
  };

  const onCreateScheme = async () => {
    const name = newSchemeName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const created = await api.createTaxonomyScheme({ name });
      setNewSchemeName("");
      setScheme(created.key);
      setRenameValue(created.name);
      setSelectedId(null);
      await load();
      setMsg(`已添加分类标准「${created.name}」（${created.code_prefix}）`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const onDeleteScheme = async () => {
    if (!currentScheme || currentScheme.builtin) return;
    const cascade = (currentScheme.node_count || 0) > 0;
    const ok = confirm(
      cascade
        ? `确认删除分类标准「${currentScheme.name}」？\n将同时删除其下 ${currentScheme.node_count} 个节点及条目标签，不可恢复。`
        : `确认删除分类标准「${currentScheme.name}」？`
    );
    if (!ok) return;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await api.deleteTaxonomyScheme(currentScheme.key, cascade);
      await load();
      setScheme("style");
      setSelectedId(null);
      setMsg("已删除分类标准");
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page stack tax-page">
      <p className="muted" style={{ margin: 0 }}>
        可维护多套独立分类标准：支持重命名、左右排序；内置标准不可删除。树节点支持拖拽排序/移入、↑↓
        同级调整；序号码随顺序自动重编。双击可重命名；「+」新建子节点。
      </p>
      {error && <div className="error">{error}</div>}
      {msg && <div className="success">{msg}</div>}

      <div className="browse-tabs tax-scheme-tabs" style={{ flexWrap: "wrap", gap: 6 }}>
        {schemes.map((s) => (
          <button
            key={s.key}
            type="button"
            className={scheme === s.key ? "" : "secondary"}
            onClick={() => selectScheme(s.key)}
          >
            {s.name}
            {s.builtin ? "" : " ·自定"}
          </button>
        ))}
      </div>

      {currentScheme && (
        <div className="card row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 200px", margin: 0 }}>
            当前标准名称
            <input
              value={renameValue}
              disabled={busy}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onRenameScheme();
                }
              }}
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy || !renameValue.trim() || renameValue.trim() === currentScheme.name}
            onClick={() => void onRenameScheme()}
          >
            重命名
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || schemeIndex <= 0}
            title="在 Tab 中左移"
            onClick={() => void onMoveScheme(-1)}
          >
            ← 左移
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || schemeIndex < 0 || schemeIndex >= schemes.length - 1}
            title="在 Tab 中右移"
            onClick={() => void onMoveScheme(1)}
          >
            右移 →
          </button>
          {currentScheme.builtin && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              title="按内置标准树恢复父子层级和编码，已有节点和标签不会删除"
              onClick={() => void onRestoreScheme()}
            >
              恢复标准结构
            </button>
          )}
          <span
            className="muted"
            style={{ fontSize: "0.85rem" }}
            title="编码前缀随上方 Tab 从左到右自动为 A、B、C…；左移/右移后会重编"
          >
            编码 {currentScheme.code_prefix}
            （第 {schemeIndex + 1} 位）
            {currentScheme.builtin ? " ·内置" : " ·自定"}
          </span>
          {!currentScheme.builtin && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void onDeleteScheme()}
            >
              删除当前标准
            </button>
          )}
        </div>
      )}

      <form
        className="card row"
        style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}
        onSubmit={(e) => {
          e.preventDefault();
          void onCreateScheme();
        }}
      >
        <label style={{ flex: "1 1 160px", margin: 0 }}>
          新分类标准名称
          <input
            value={newSchemeName}
            disabled={busy}
            placeholder="例如：场景语境"
            onChange={(e) => setNewSchemeName(e.target.value)}
          />
        </label>
        <span className="muted" style={{ fontSize: "0.85rem", paddingBottom: 8 }}>
          编码按 Tab 顺序自动分配（A/B/C…）
        </span>
        <button type="submit" disabled={busy || !newSchemeName.trim()}>
          添加分类标准
        </button>
      </form>

      <ResizableColumns
        storageKey="taxonomy-manage"
        defaults={[360]}
        mins={[240]}
        maxes={[720]}
      >
        <div className="card stack tax-panel">
          <h2>
            {taxonomySchemeLabel(scheme, schemes)}
            {currentScheme ? `（${currentScheme.code_prefix}）` : ""}
          </h2>
          <ResizableHeight storageKey="taxonomy-tree" defaultHeight={480} min={220} max={900}>
            <TaxonomyTree
              nodes={schemeNodes}
              scheme={scheme}
              selectedId={selectedId}
              onSelect={(n) => setSelectedId(n?.id ?? null)}
              manageable
              onCreateChild={async (parent, name) => {
                setError("");
                setMsg("");
                try {
                  await api.createTaxonomyNode({
                    scheme,
                    parent_id: parent.id,
                    name,
                  });
                  await load();
                  setMsg(`已创建「${name}」`);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "创建失败");
                }
              }}
              onRename={async (node, name) => {
                setError("");
                try {
                  await api.updateTaxonomyNode(node.id, { name });
                  await load();
                  setMsg("已重命名");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "重命名失败");
                }
              }}
              onDelete={async (node) => {
                setError("");
                try {
                  await api.deleteTaxonomyNode(node.id);
                  if (selectedId === node.id) setSelectedId(null);
                  await load();
                  setMsg("已删除");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "删除失败");
                }
              }}
              onCreateRoot={async (name) => {
                setError("");
                try {
                  await api.createTaxonomyNode({ scheme, parent_id: null, name });
                  await load();
                  setMsg(`已创建根节点「${name}」`);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "创建失败");
                }
              }}
              onMove={async (node, parentId) => {
                setError("");
                setMsg("");
                try {
                  await api.updateTaxonomyNode(node.id, { parent_id: parentId });
                  await load();
                  setMsg("已移动节点（序号已重编）");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "移动失败");
                  throw e;
                }
              }}
              onReorder={async (parentId, orderedIds) => {
                setError("");
                setMsg("");
                try {
                  await api.reorderTaxonomyNodes(parentId, orderedIds);
                  await load();
                  setMsg("已调整排序（序号已重编）");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "排序失败");
                  throw e;
                }
              }}
            />
          </ResizableHeight>
        </div>
        <div className="card stack tax-panel tax-detail">
          <h2>节点详情</h2>
          {selected ? (
            <>
              <div>
                <div className="muted">路径</div>
                <div>{selected.path}</div>
              </div>
              <div>
                <div className="muted">编码 / 序号</div>
                <div>{selected.code || "—"}</div>
              </div>
              <div>
                <div className="muted">同级顺序</div>
                <div>{selected.sort_order}</div>
              </div>
              <div>
                <div className="muted">条目数（含子孙）</div>
                <div>{selected.clip_count}</div>
              </div>
              <div>
                <div className="muted">子节点数</div>
                <div>{selected.child_count}</div>
              </div>
              {selected.parent_id != null ||
              schemeNodes.filter((n) => n.parent_id == null).length > 1 ? (
                <label>
                  上级节点
                  <select
                    value={selected.parent_id ?? ""}
                    onChange={async (e) => {
                      const raw = e.target.value;
                      const parentId = raw === "" ? null : Number(raw);
                      if (parentId === selected.parent_id) return;
                      setError("");
                      setMsg("");
                      try {
                        await api.updateTaxonomyNode(selected.id, {
                          parent_id: parentId,
                        });
                        await load();
                        setMsg("已调整层级（序号已重编）");
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "移动失败");
                      }
                    }}
                  >
                    <option value="">顶级（与根节点同级）</option>
                    {schemeNodes
                      .filter((n) => {
                        if (n.id === selected.id) return false;
                        if (n.path.startsWith(selected.path)) return false;
                        return true;
                      })
                      .sort(
                        (a, b) =>
                          a.path.localeCompare(b.path, "zh") ||
                          a.sort_order - b.sort_order
                      )
                      .map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.code ? `${n.code} ${n.name}` : n.name}
                        </option>
                      ))}
                  </select>
                  <small className="muted">
                    拖乱后在这里选回正确的上级即可，不必再拖拽
                  </small>
                </label>
              ) : null}
              <div>
                <div className="muted">编码规则</div>
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  序号随同级顺序自动重编（A1、A2、A2.1…）。数据标签按节点绑定，改名或调序不会换绑到别的类别。
                </div>
              </div>
              <label>
                描述
                <textarea
                  key={`desc-${selected.id}`}
                  defaultValue={selected.description}
                  onBlur={async (e) => {
                    const description = e.target.value;
                    if (description === (selected.description || "")) return;
                    try {
                      await api.updateTaxonomyNode(selected.id, { description });
                      await load();
                      setMsg("描述已更新");
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "更新失败");
                    }
                  }}
                />
              </label>
            </>
          ) : (
            <p className="muted">选择左侧节点查看详情</p>
          )}
        </div>
      </ResizableColumns>
    </div>
  );
}
