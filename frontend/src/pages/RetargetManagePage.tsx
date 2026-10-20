import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  childrenByParent,
  selectionAfterCheck,
  selectionCovers,
  specificTagIds,
  taxonomySchemeLabel,
  type TaxonomyNode,
  type TaxonomySchemeDef,
} from "../types";

export type RetargetQueue = {
  key: string;
  rank: string;
  title: string;
  total: number;
  done: number;
  failed: number;
  remaining?: number;
  eta_seconds?: number | null;
  eta_after_seconds?: number | null;
  active?: boolean;
};

export type TaxonomyPick = { scheme: string; name: string };

export type PriorityRule = {
  id: string;
  enabled: boolean;
  robots: string[];
  data_mode: "taxonomy" | "rest";
  scheme: string;
  include_names: string[];
  exclude_names: string[];
  include_picks?: TaxonomyPick[];
  exclude_picks?: TaxonomyPick[];
};

export type PriorityPreset = {
  id: string;
  name: string;
  builtin: boolean;
  rules: PriorityRule[];
};

export type RetargetPin = { batch: string; units: string[] };

export type RetargetPriority = {
  version: number;
  rules: PriorityRule[];
  robots: string[];
  defaults: PriorityRule[];
  presets?: PriorityPreset[];
  pins?: RetargetPin[];
  updated_at?: string | null;
};

export type RetargetJob = {
  batch: string;
  unit: string;
  style: string;
  source?: string;
  queue?: string;
  at?: string;
  status?: string;
  error?: string;
};

export type RetargetStatus = {
  running: boolean;
  phase: string;
  updated_at?: string | null;
  started_at?: string | null;
  priority_style?: string;
  styles?: string[];
  workers?: number;
  reserved_cpus?: number;
  mem_reserve_gb?: number;
  priority_note?: string;
  queues?: RetargetQueue[];
  current?: RetargetJob[];
  recent?: RetargetJob[];
  round_total?: number;
  round_done?: number;
  round_failed?: number;
  round_running?: number;
  round_started_at?: string | null;
  seconds_per_job?: number | null;
  pace_measured?: boolean;
  message?: string;
};

const PHASE_LABEL: Record<string, string> = {
  scanning: "正在扫描",
  running: "正在重定向",
  waiting: "等待可用内存",
  idle: "没有待处理任务",
  stopped: "已停止",
  error: "出错后重试",
};

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.round(ms / 60000);
  if (minutes < 90) return `${Math.max(1, minutes)} 分钟`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} 小时`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours - days * 24);
  if (rest === 0) return `${days} 天`;
  return `${days} 天 ${rest} 小时`;
}

function pinLabel(pin: RetargetPin) {
  if (!pin.units.length) return `${pin.batch}（整批）`;
  if (pin.units.length === 1) return `${pin.batch} / ${pin.units[0]}`;
  const head = pin.units.slice(0, 2).join("、");
  return `${pin.batch} / ${head}${pin.units.length > 2 ? ` 等 ${pin.units.length} 个单元` : ""}`;
}

function rankLabel(rank: string) {
  return /^\d+$/.test(rank) ? `第 ${rank} 档` : rank;
}

function queueRemaining(queue: RetargetQueue) {
  if (typeof queue.remaining === "number") return queue.remaining;
  return Math.max(0, queue.total - queue.done - (queue.failed || 0));
}

function queueTimeText(queue: RetargetQueue) {
  const remaining = queueRemaining(queue);
  if (queue.total === 0) return "这一档没有待处理的数据";
  if (remaining === 0) return "这一档已经跑完";
  const band = queue.eta_seconds;
  const after = queue.eta_after_seconds;
  if (band == null) return "完成时间要等这一波结果出来后再估计";
  const bandText = formatDuration(band * 1000);
  const afterText = after == null ? "" : formatDuration(after * 1000);
  if (after != null && after > band + 60 && afterText !== bandText) {
    return `这一档大约还要 ${bandText}，排到并做完大约还要 ${afterText}`;
  }
  return `大约还要 ${bandText}`;
}

function cloneRules(rules: PriorityRule[]): PriorityRule[] {
  return rules.map((rule) => ({
    ...rule,
    robots: [...(rule.robots || [])],
    include_names: [...(rule.include_names || [])],
    exclude_names: [...(rule.exclude_names || [])],
    include_picks: (rule.include_picks || []).map((pick) => ({ ...pick })),
    exclude_picks: (rule.exclude_picks || []).map((pick) => ({ ...pick })),
  }));
}

function rulePicks(rule: PriorityRule, kind: "include" | "exclude"): TaxonomyPick[] {
  const stored = kind === "include" ? rule.include_picks : rule.exclude_picks;
  if (stored && stored.length) return stored;
  const names = kind === "include" ? rule.include_names : rule.exclude_names;
  if (!rule.scheme) return [];
  return (names || []).map((name) => ({ scheme: rule.scheme, name }));
}

function withPicks(rule: PriorityRule, kind: "include" | "exclude", picks: TaxonomyPick[]): PriorityRule {
  const include = kind === "include" ? picks : rulePicks(rule, "include");
  const exclude = kind === "exclude" ? picks : rulePicks(rule, "exclude");
  return {
    ...rule,
    include_picks: include,
    exclude_picks: exclude,
    include_names: include.map((item) => item.name),
    exclude_names: exclude.map((item) => item.name),
    scheme: include[0]?.scheme || exclude[0]?.scheme || rule.scheme,
  };
}

function ruleTitle(rule: PriorityRule, earlier: Set<string>) {
  const robots = rule.robots.join(" → ") || "未选机器人";
  if (rule.data_mode === "rest") {
    const untouched = rule.robots.length > 0 && rule.robots.every((robot) => !earlier.has(robot));
    return `${robots} · ${untouched ? "全部数据" : "其余数据"}`;
  }
  const includePicks = rulePicks(rule, "include");
  const include = includePicks.map((pick) => pick.name).join(" → ") || "未选分类";
  const exclude = rule.exclude_names.join("、");
  let text = `${robots} · ${include}`;
  if (exclude) text += `（不含 ${exclude}）`;
  if (rule.scheme && rule.scheme !== "custom_6") text += ` · ${rule.scheme}`;
  return text;
}

function blankRule(robots: string[]): PriorityRule {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : `rule-${Date.now().toString(16)}`;
  return {
    id,
    enabled: true,
    robots: robots.slice(0, 1),
    data_mode: "taxonomy",
    scheme: "custom_6",
    include_names: [],
    exclude_names: [],
  };
}

function nodeCovered(
  id: number,
  nodes: TaxonomyNode[],
  picked: ReadonlySet<number>,
) {
  const children = childrenByParent(nodes);
  if (selectionCovers(id, picked, children)) return true;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let parent = byId.get(id)?.parent_id ?? null;
  while (parent != null) {
    if (picked.has(parent)) return true;
    parent = byId.get(parent)?.parent_id ?? null;
  }
  return false;
}

function toggleTaxonomy(id: number, nodes: TaxonomyNode[], checked: number[]) {
  const specific = specificTagIds(checked, nodes);
  const selected = new Set(specific);
  const children = childrenByParent(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (selected.has(id) || selectionCovers(id, selected, children)) {
    return selectionAfterCheck(id, nodes, specific);
  }
  let ancestor: number | null = byId.get(id)?.parent_id ?? null;
  const between: number[] = [];
  while (ancestor != null && !selected.has(ancestor)) {
    between.push(ancestor);
    ancestor = byId.get(ancestor)?.parent_id ?? null;
  }
  if (ancestor == null) return selectionAfterCheck(id, nodes, specific);
  const next = specific.filter((item) => item !== ancestor);
  const path = [...between.reverse(), id];
  let parent = ancestor;
  for (const step of path) {
    for (const child of children.get(parent) || []) {
      if (child.id !== step) next.push(child.id);
    }
    parent = step;
  }
  return specificTagIds(next, nodes);
}

function namesToIds(nodes: TaxonomyNode[], names: string[]) {
  const ids: number[] = [];
  for (const name of names) {
    const node = nodes.find((item) => item.name === name);
    if (node && !ids.includes(node.id)) ids.push(node.id);
  }
  return ids;
}

function mergeSchemePicks(picks: TaxonomyPick[], scheme: string, names: string[]): TaxonomyPick[] {
  const next = new Set(names);
  const kept = picks.filter((pick) => pick.scheme !== scheme || next.has(pick.name));
  const keptNames = new Set(kept.filter((pick) => pick.scheme === scheme).map((pick) => pick.name));
  return [...kept, ...names.filter((name) => !keptNames.has(name)).map((name) => ({ scheme, name }))];
}

function CheckTree({
  nodes,
  checked,
  ranks,
  onToggle,
}: {
  nodes: TaxonomyNode[];
  checked: number[];
  ranks: Map<number, number>;
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
    const rank = ranks.get(node.id);
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
            checked={nodeCovered(node.id, nodes, picked)}
            onChange={() => onToggle(node.id)}
          />
          <span>
            {rank ? <span className="retarget-rank">{rank}</span> : null}
            {node.name}
          </span>
        </label>
        {kids.length > 0 && expanded && kids.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };
  if (!nodes.length) return <div className="muted">该维度暂无分类</div>;
  return <div className="facet-tree">{top.map((node) => renderNode(node, 0))}</div>;
}

function SchemeFacets({
  schemes,
  nodesByScheme,
  picks,
  ranked,
  onChange,
}: {
  schemes: TaxonomySchemeDef[];
  nodesByScheme: Record<string, TaxonomyNode[]>;
  picks: TaxonomyPick[];
  ranked?: boolean;
  onChange: (picks: TaxonomyPick[]) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openKey) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenKey(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openKey]);
  const ranks = new Map<string, number>();
  if (ranked) picks.forEach((pick, index) => ranks.set(`${pick.scheme}:${pick.name}`, index + 1));
  return (
    <div className="retarget-facets" ref={rootRef}>
      {ranked && picks.length > 0 ? (
        <div className="retarget-chips">
          {picks.map((pick, index) => (
            <button
              key={`${pick.scheme}:${pick.name}`}
              type="button"
              className="retarget-chip"
              onClick={() => onChange(picks.filter((item) => item !== pick))}
            >
              {index + 1}. {pick.name} ×
            </button>
          ))}
        </div>
      ) : null}
      <div className="facet-list">
        {schemes.map((scheme) => {
          const nodes = nodesByScheme[scheme.key] || [];
          const names = picks.filter((pick) => pick.scheme === scheme.key).map((pick) => pick.name);
          const open = openKey === scheme.key;
          const summary = names.length === 0 ? "" : names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
          const checked = namesToIds(nodes, names);
          const rankById = new Map<number, number>();
          names.forEach((name) => {
            const node = nodes.find((item) => item.name === name);
            const rank = ranks.get(`${scheme.key}:${name}`);
            if (node && rank) rankById.set(node.id, rank);
          });
          return (
            <div className={`facet-item${open ? " is-open" : ""}`} key={scheme.key}>
              <button
                type="button"
                className={`facet-chip${open ? " is-open" : ""}${names.length ? " is-picked" : ""}`}
                onClick={() => setOpenKey((current) => (current === scheme.key ? null : scheme.key))}
              >
                <span>{taxonomySchemeLabel(scheme.key, schemes)}</span>
                {summary ? <span className="facet-summary">{summary}</span> : null}
                <span className="facet-chevron">{open ? "▴" : "▾"}</span>
              </button>
              {open ? (
                <div className="facet-pop">
                  <CheckTree
                    nodes={nodes}
                    checked={checked}
                    ranks={rankById}
                    onToggle={(id) => {
                      const nextIds = toggleTaxonomy(id, nodes, checked);
                      const nextNames = nextIds
                        .map((nodeId) => nodes.find((node) => node.id === nodeId)?.name || "")
                        .filter(Boolean);
                      onChange(mergeSchemePicks(picks, scheme.key, nextNames));
                    }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RetargetManagePage() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<RetargetStatus | null>(null);
  const [error, setError] = useState("");
  const [rules, setRules] = useState<PriorityRule[]>([]);
  const [savedRules, setSavedRules] = useState<PriorityRule[]>([]);
  const [robots, setRobots] = useState<string[]>([]);
  const [presets, setPresets] = useState<PriorityPreset[]>([]);
  const [pins, setPins] = useState<RetargetPin[]>([]);
  const [presetName, setPresetName] = useState("");
  const [schemes, setSchemes] = useState<TaxonomySchemeDef[]>([]);
  const [nodesByScheme, setNodesByScheme] = useState<Record<string, TaxonomyNode[]>>({});
  const [priorityError, setPriorityError] = useState("");
  const [priorityNote, setPriorityNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rulesRef = useRef(rules);
  const savedRef = useRef(savedRules);
  const savingRef = useRef(false);
  const loadingSchemes = useRef(new Set<string>());
  const collapsedInit = useRef(false);
  rulesRef.current = rules;
  savedRef.current = savedRules;
  savingRef.current = saving;

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    api
      .listTaxonomySchemes()
      .then((next) => {
        if (alive) setSchemes(next);
      })
      .catch(() => undefined);
    const applyPriority = (cfg: RetargetPriority) => {
      const next = cloneRules(cfg.rules || []);
      setRules(next);
      setSavedRules(cloneRules(cfg.rules || []));
      setRobots(cfg.robots || []);
      setPresets(cfg.presets || []);
      setPins(cfg.pins || []);
      if (!collapsedInit.current) {
        collapsedInit.current = true;
        setCollapsed(new Set(next.map((rule) => rule.id)));
      }
    };
    const load = () => {
      api
        .retargetStatus()
        .then((next) => {
          if (!alive) return;
          setData(next);
          setError("");
        })
        .catch((err: Error) => {
          if (!alive) return;
          setError(err.message || "加载失败");
        });
      const untouched = JSON.stringify(rulesRef.current) === JSON.stringify(savedRef.current);
      if (!savingRef.current && untouched) {
        api
          .retargetPriority()
          .then((cfg) => {
            if (!alive || savingRef.current) return;
            if (JSON.stringify(rulesRef.current) !== JSON.stringify(savedRef.current)) return;
            applyPriority(cfg);
          })
          .catch((err: Error) => {
            if (!alive) return;
            setPriorityError(err.message || "优先级加载失败");
          });
      }
    };
    load();
    const timer = window.setInterval(load, 8000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [isAdmin]);

  useEffect(() => {
    for (const scheme of schemes) {
      if (!scheme.key || nodesByScheme[scheme.key] || loadingSchemes.current.has(scheme.key)) continue;
      loadingSchemes.current.add(scheme.key);
      api
        .listTaxonomies(scheme.key)
        .then((nodes) => {
          setNodesByScheme((prev) => ({ ...prev, [scheme.key]: nodes }));
        })
        .catch(() => {
          loadingSchemes.current.delete(scheme.key);
        });
    }
  }, [schemes, nodesByScheme]);

  const dirty = JSON.stringify(rules) !== JSON.stringify(savedRules);

  const toggleRule = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateRule = (id: string, patch: Partial<PriorityRule>) => {
    setRules((prev) => prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
    setPriorityNote("");
  };

  const moveRule = (index: number, delta: number) => {
    setRules((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
    setPriorityNote("");
  };

  const saveRules = () => {
    setSaving(true);
    savingRef.current = true;
    setPriorityError("");
    api
      .saveRetargetPriority(rules)
      .then((cfg) => {
        const next = cloneRules(cfg.rules || []);
        setRules(next);
        setSavedRules(cloneRules(cfg.rules || []));
        setRobots(cfg.robots || []);
        setPresets(cfg.presets || []);
        setPins(cfg.pins || []);
        setPriorityNote("已保存。当前这一波结束后会按新顺序重新扫描。");
      })
      .catch((err: Error) => {
        setPriorityError(err.message || "保存失败");
      })
      .finally(() => {
        setSaving(false);
        savingRef.current = false;
      });
  };

  const adoptConfig = (cfg: RetargetPriority, note: string) => {
    const next = cloneRules(cfg.rules || []);
    setRules(next);
    setSavedRules(cloneRules(cfg.rules || []));
    setRobots(cfg.robots || []);
    setPresets(cfg.presets || []);
    setPins(cfg.pins || []);
    setCollapsed(new Set(next.map((rule) => rule.id)));
    setPriorityNote(note);
    setPriorityError("");
  };

  const saveAsPreset = () => {
    const name = presetName.trim();
    if (!name) {
      setPriorityError("请填写规则名称");
      return;
    }
    setSaving(true);
    savingRef.current = true;
    setPriorityError("");
    api
      .saveRetargetPreset(name, rules)
      .then((cfg) => {
        setPresets(cfg.presets || []);
        setPins(cfg.pins || []);
        setPresetName("");
        setPriorityNote(`已把当前规则存为「${name}」。点这套规则的名称即可切换。`);
      })
      .catch((err: Error) => {
        setPriorityError(err.message || "保存失败");
      })
      .finally(() => {
        setSaving(false);
        savingRef.current = false;
      });
  };

  const applyPreset = (preset: PriorityPreset) => {
    setSaving(true);
    savingRef.current = true;
    setPriorityError("");
    api
      .applyRetargetPreset(preset.id)
      .then((cfg) => {
        adoptConfig(cfg, `已切换到「${preset.name}」。当前这一波结束后会按这套规则重新扫描。`);
      })
      .catch((err: Error) => {
        setPriorityError(err.message || "切换失败");
      })
      .finally(() => {
        setSaving(false);
        savingRef.current = false;
      });
  };

  const removePreset = (preset: PriorityPreset) => {
    setSaving(true);
    savingRef.current = true;
    setPriorityError("");
    api
      .deleteRetargetPreset(preset.id)
      .then((cfg) => {
        setPresets(cfg.presets || []);
        setPins(cfg.pins || []);
        setPriorityNote(`已删除「${preset.name}」。正在执行的规则没有变。`);
      })
      .catch((err: Error) => {
        setPriorityError(err.message || "删除失败");
      })
      .finally(() => {
        setSaving(false);
        savingRef.current = false;
      });
  };

  if (!isAdmin) {
    return <div className="page error">需要超级管理者权限</div>;
  }

  const total = data?.round_total || 0;
  const done = data?.round_done || 0;
  const failed = data?.round_failed || 0;
  const running = data?.round_running || 0;
  const finished = done + failed;
  const remaining = Math.max(0, total - finished);
  const percent = total ? Math.min(100, Math.round((finished / total) * 1000) / 10) : 0;
  const pace = data?.seconds_per_job;
  const roundEta =
    remaining === 0 && total > 0
      ? "本轮已处理完，即将开始下一轮扫描。"
      : remaining > 0 && pace
        ? `${data?.pace_measured ? "按最近几波的速度" : "按以往速度估算"}，本轮剩余大约 ${formatDuration(remaining * pace * 1000)}。`
        : "本轮刚开始，完成时间要等几条结果出来后再估计。";
  const queues = data?.queues || [];
  const current = data?.current || [];
  const recent = data?.recent || [];

  return (
    <div className="page stack retarget-page">
      <section className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <span className={`badge ${data?.running ? "high" : "low"}`}>
              {data ? PHASE_LABEL[data.phase] || data.phase : "正在加载"}
            </span>
            <span className="muted">{data?.message || ""}</span>
          </div>
          <span className="muted">更新于 {formatTime(data?.updated_at)}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {data?.priority_note || "优先级会在扫描完成后显示。"}
          {data?.workers
            ? ` 同时 ${data.workers} 路，留出 ${data.reserved_cpus || 0} 核和 ${data.mem_reserve_gb || 0} GB 内存。`
            : ""}
        </p>
        <div className="retarget-stats">
          <div className="is-total">
            <span>本轮</span>
            <strong>{total}</strong>
          </div>
          <div className="is-done">
            <span>已完成</span>
            <strong>{done}</strong>
          </div>
          <div className="is-running">
            <span>进行中</span>
            <strong>{running}</strong>
          </div>
          <div className="is-failed">
            <span>失败</span>
            <strong>{failed}</strong>
          </div>
          <div className="is-remaining">
            <span>剩余</span>
            <strong>{remaining}</strong>
          </div>
        </div>
        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>本轮进度</span>
            <strong>{percent}%</strong>
          </div>
          <div className="retarget-bar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <span className="retarget-bar-done" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
            {failed > 0 ? (
              <span className="retarget-bar-failed" style={{ width: `${total ? (failed / total) * 100 : 0}%` }} />
            ) : null}
          </div>
          <p className="muted" style={{ margin: "0.45rem 0 0" }}>
            {roundEta}
            启动于 {formatTime(data?.started_at)}。
          </p>
        </div>
      </section>

      <section className="card stack">
        <h2>优先级</h2>
        <p className="muted" style={{ margin: 0 }}>
          {data?.pace_measured
            ? "每档时间按最近几波的完成速度估计，会随后面的结果更新。"
            : data?.seconds_per_job
              ? "本轮还没有新的完成速度，每档时间先按以往的速度估计，这一波结束后会改成实测。"
              : "每档时间会在扫描完成、并有速度样本后显示。"}
        </p>
        {pins.length || queues.length ? (
          <ol className="retarget-queues">
            {pins.length ? (
              <li className={queues.some((queue) => queue.key === "pinned" && queue.active) ? "is-active" : undefined}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>优先{queues.some((queue) => queue.key === "pinned" && queue.active) ? " · 当前" : ""}</strong>
                  <span>
                    {(() => {
                      const live = queues.find((queue) => queue.key === "pinned");
                      return live ? `${live.done} / ${live.total}${live.failed ? `，失败 ${live.failed}` : ""}` : "待开始";
                    })()}
                  </span>
                </div>
                {pins.map((pin) => (
                  <div key={`${pin.batch}:${pin.units.join("|")}`}>{pinLabel(pin)}</div>
                ))}
                <div className="muted">
                  {queues.some((queue) => queue.key === "pinned")
                    ? queueTimeText(queues.find((queue) => queue.key === "pinned") as RetargetQueue)
                    : "已指定。当前这一波结束后会排到所有规则前面。"}
                </div>
              </li>
            ) : null}
            {queues.filter((queue) => queue.key !== "pinned").map((queue) => {
              const queueDone = queue.done + queue.failed;
              const queuePercent = queue.total ? Math.min(100, (queueDone / queue.total) * 100) : 0;
              return (
                <li key={queue.key} className={queue.active ? "is-active" : undefined}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>
                      {rankLabel(queue.rank)}
                      {queue.active ? " · 当前" : ""}
                    </strong>
                    <span>
                      {queue.done} / {queue.total}
                      {queue.failed ? `，失败 ${queue.failed}` : ""}
                    </span>
                  </div>
                  <div>{queue.title}</div>
                  <div className="muted">{queueTimeText(queue)}</div>
                  <div className="retarget-bar">
                    <span className="retarget-bar-done" style={{ width: `${queuePercent}%` }} />
                    {queue.failed ? (
                      <span
                        className="retarget-bar-failed"
                        style={{ width: `${Math.min(100 - queuePercent, (queue.failed / queue.total) * 100)}%` }}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="muted">{data ? "扫描完成后显示各档数量和时间" : "正在读取进度…"}</div>
        )}
      </section>

      <section className="card stack">
        <h2>调整优先级</h2>
        <p className="muted" style={{ margin: 0 }}>
          每条规则同时指定机器人和数据范围，排在上面的先做。同一条规则里，机器人、包含的分类都按勾选顺序分先后：先点的先做，取消后再勾会排到最后。排除的分类不参与排序，会留到后面的规则。选其余数据时，会接住这些机器人里前面规则没选中的动作，机器人之间仍按勾选顺序。保存后，当前这一波结束就会按新顺序重新扫描。
        </p>
        {priorityError ? <div className="error">{priorityError}</div> : null}
        {priorityNote ? <div className="muted">{priorityNote}</div> : null}
        <div className="retarget-editor">
          {rules.map((rule, index) => {
            const earlier = new Set(rules.slice(0, index).flatMap((item) => (item.enabled ? item.robots : [])));
            return (
            <div key={rule.id} className={rule.enabled ? "retarget-rule" : "retarget-rule is-off"}>
              <div className="retarget-rule-head" onClick={() => toggleRule(rule.id)}>
                <div className="retarget-rule-summary">
                  <strong>第 {index + 1} 档</strong>
                  <div className="muted">{rule.enabled ? ruleTitle(rule, earlier) : "已停用，不会参与排序"}</div>
                </div>
                <div className="row" onClick={(event) => event.stopPropagation()}>
                  <button type="button" className="secondary retarget-mini" disabled={index === 0} onClick={() => moveRule(index, -1)}>
                    上移
                  </button>
                  <button
                    type="button"
                    className="secondary retarget-mini"
                    disabled={index === rules.length - 1}
                    onClick={() => moveRule(index, 1)}
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    className="secondary retarget-mini"
                    disabled={rules.length <= 1}
                    onClick={() => {
                      setRules((prev) => prev.filter((item) => item.id !== rule.id));
                      setPriorityNote("");
                    }}
                  >
                    删除
                  </button>
                  <button type="button" className="secondary retarget-mini" onClick={() => toggleRule(rule.id)}>
                    {collapsed.has(rule.id) ? "展开" : "收起"}
                  </button>
                </div>
              </div>
              {!collapsed.has(rule.id) ? (
              <>
              <div className="retarget-inline">
                <label className="retarget-check">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
                  />
                  启用
                </label>
                <span className="muted">机器人</span>
                {rule.robots.map((robot, index) => (
                  <button
                    key={robot}
                    type="button"
                    className="retarget-chip"
                    onClick={() => updateRule(rule.id, { robots: rule.robots.filter((item) => item !== robot) })}
                  >
                    {index + 1}. {robot} ×
                  </button>
                ))}
                {(robots.length ? robots : rule.robots).map((robot) => {
                  const rank = rule.robots.indexOf(robot);
                  return (
                    <label key={robot} className="retarget-check">
                      <input
                        type="checkbox"
                        checked={rank >= 0}
                        onChange={() => {
                          const next = rank >= 0
                            ? rule.robots.filter((item) => item !== robot)
                            : [...rule.robots, robot];
                          updateRule(rule.id, { robots: next });
                        }}
                      />
                      {rank >= 0 ? <span className="retarget-rank">{rank + 1}</span> : null}
                      {robot}
                    </label>
                  );
                })}
                <label className="retarget-check">
                  <input
                    type="radio"
                    name={`mode-${rule.id}`}
                    checked={rule.data_mode === "taxonomy"}
                    onChange={() => updateRule(rule.id, { data_mode: "taxonomy" })}
                  />
                  指定分类
                </label>
                <label className="retarget-check">
                  <input
                    type="radio"
                    name={`mode-${rule.id}`}
                    checked={rule.data_mode === "rest"}
                    onChange={() => updateRule(rule.id, { data_mode: "rest" })}
                  />
                  其余数据
                </label>
              </div>
              {rule.data_mode === "taxonomy" ? (
                <>
                  <div>
                    <div className="muted">包含这些分类。勾选父节点会带上全部下级，先勾的先做。多个维度要同时满足。</div>
                    <SchemeFacets
                      ranked
                      schemes={schemes}
                      nodesByScheme={nodesByScheme}
                      picks={rulePicks(rule, "include")}
                      onChange={(include_picks) => updateRule(rule.id, withPicks(rule, "include", include_picks))}
                    />
                  </div>
                  <div>
                    <div className="muted">排除这些分类。勾选父节点会排除它的全部下级。</div>
                    <SchemeFacets
                      schemes={schemes}
                      nodesByScheme={nodesByScheme}
                      picks={rulePicks(rule, "exclude")}
                      onChange={(exclude_picks) => updateRule(rule.id, withPicks(rule, "exclude", exclude_picks))}
                    />
                  </div>
                </>
              ) : (
                <div className="muted">这些机器人里，没有被更靠前的规则选中的动作会进到这一档。</div>
              )}
              </>
              ) : null}
            </div>
            );
          })}
        </div>
        <div className="retarget-presets">
          {presets.map((preset) => {
            const active = JSON.stringify(savedRules) === JSON.stringify(preset.rules);
            return (
              <span key={preset.id} className={active ? "retarget-preset is-on" : "retarget-preset"}>
                <button type="button" disabled={saving} onClick={() => applyPreset(preset)}>
                  {preset.name}
                </button>
                {preset.builtin ? null : (
                  <button
                    type="button"
                    className="retarget-preset-x"
                    disabled={saving}
                    aria-label={`删除 ${preset.name}`}
                    onClick={() => removePreset(preset)}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
        <div className="row">
          <input
            className="retarget-preset-name"
            value={presetName}
            placeholder="规则名称"
            maxLength={24}
            onChange={(event) => setPresetName(event.target.value)}
          />
          <button type="button" className="secondary" disabled={saving} onClick={saveAsPreset}>
            把当前规则存为默认
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const rule = blankRule(robots);
              setRules((prev) => [...prev, rule]);
              setCollapsed((prev) => {
                const next = new Set(prev);
                next.delete(rule.id);
                return next;
              });
              setPriorityNote("");
            }}
          >
            添加规则
          </button>
          <button type="button" disabled={!dirty || saving} onClick={saveRules}>
            {saving ? "正在保存" : "保存优先级"}
          </button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          没有被任何规则选中的机器人仍会重定向，排在所有规则后面。同一档里，开源数据和其他数据集会稍晚一些，小批次先做。
        </p>
      </section>

      <div className="retarget-split">
      <section className="card stack">
        <h2>正在处理</h2>
        {error ? <div className="error">{error}</div> : null}
        {current.length === 0 ? (
          <div className="muted">当前没有进行中的条目</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>批次</th>
                <th>单元</th>
                <th>机器人</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {current.map((job) => (
                <tr key={`${job.batch}/${job.unit}/${job.style}`}>
                  <td>{job.batch}</td>
                  <td>{job.unit}</td>
                  <td>{job.style}</td>
                  <td>{job.source || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card stack">
        <h2>最近结果</h2>
        {recent.length === 0 ? (
          <div className="muted">这一轮还没有完成的条目</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>批次</th>
                <th>单元</th>
                <th>机器人</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((job, index) => (
                <tr key={`${job.at || ""}-${job.batch}-${job.unit}-${index}`}>
                  <td>{formatTime(job.at)}</td>
                  <td>{job.batch}</td>
                  <td>{job.unit}</td>
                  <td>{job.style}</td>
                  <td>
                    {job.status === "failed" ? (
                      <span className="retarget-status is-failed" title={job.error || ""}>
                        失败{job.error ? ` · ${job.error}` : ""}
                      </span>
                    ) : (
                      <span className="retarget-status is-ok">完成</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      </div>
    </div>
  );
}
