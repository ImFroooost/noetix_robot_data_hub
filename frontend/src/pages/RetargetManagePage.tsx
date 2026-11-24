import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
  data_mode: "taxonomy" | "rest" | "targets";
  scheme: string;
  include_names: string[];
  exclude_names: string[];
  include_picks?: TaxonomyPick[];
  exclude_picks?: TaxonomyPick[];
  targets?: { batch: string; units: string[] }[];
  /** 优先级表里填的序号。几条规则可以共用一个序号。 */
  rank?: number;
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
  redo?: string[];
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
  desired?: "running" | "stopped";
  performance?: "auto" | "light" | "balanced" | "heavy";
  performance_note?: string;
  method?: "omniretarget" | "frax";
};

const PHASE_LABEL: Record<string, string> = {
  scanning: "正在扫描",
  running: "正在重定向",
  waiting: "等待可用内存",
  idle: "没有待处理任务",
  stopped: "已停止",
  stopping: "正在停止",
  error: "出错后重试",
};

const PERFORMANCE_MODES: { id: "auto" | "light" | "balanced" | "heavy"; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "light", label: "轻" },
  { id: "balanced", label: "均衡" },
  { id: "heavy", label: "高" },
];

const RETARGET_METHODS: { id: "omniretarget" | "frax"; label: string }[] = [
  { id: "omniretarget", label: "omniretarget" },
  { id: "frax", label: "frax" },
];

function performanceHint(mode: string, note?: string) {
  if (note && mode === "auto") return note;
  if (mode === "light") return "最多 2 路，多留内存给桌面。当前这一波结束后生效。";
  if (mode === "balanced") return "最多 4 路。当前这一波结束后生效。";
  if (mode === "heavy") return "最多 8 路。内存不够时仍会少开几路。当前这一波结束后生效。";
  return note || "按 CPU 负载和内存压力自动增减路数，空闲时最多 8 路。";
}

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

function queueCountText(queue: RetargetQueue) {
  const failed = queue.failed ? `，失败 ${queue.failed}` : "";
  return `已完成 ${queue.done} / 共 ${queue.total}${failed}`;
}

function queueRemaining(queue: RetargetQueue) {
  if (typeof queue.remaining === "number") return queue.remaining;
  return Math.max(0, queue.total - queue.done - (queue.failed || 0));
}

function queueTimeText(queue: RetargetQueue) {
  const remaining = queueRemaining(queue);
  if (queue.total === 0) return "这一档没有待处理的数据";
  if (remaining === 0 && queue.failed > 0 && queue.done === 0) return "这一档都失败了，可以点本级全部重做再跑一遍";
  if (remaining === 0 && queue.failed > 0) return `成功的已经跑完，失败 ${queue.failed} 条`;
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
    targets: (rule.targets || []).map((item) => ({ batch: item.batch, units: [...item.units] })),
  }));
}

function rulePicks(rule: PriorityRule, kind: "include" | "exclude"): TaxonomyPick[] {
  const stored = kind === "include" ? rule.include_picks : rule.exclude_picks;
  if (stored && stored.length) return stored;
  const names = kind === "include" ? rule.include_names : rule.exclude_names;
  if (!rule.scheme) return [];
  return (names || []).map((name) => ({ scheme: rule.scheme, name }));
}

function ruleTitle(rule: PriorityRule, earlier: Set<string>, rules: PriorityRule[] = []) {
  const robots = rule.robots.join(" → ") || "未选机器人";
  if (rule.data_mode === "targets") {
    const data = (rule.targets || []).map((item) => pinLabel(item)).join("、") || "未选数据";
    return `${data} · ${robots}`;
  }
  if (rule.data_mode === "rest") {
    const carved = rules.some(
      (other) =>
        other.id !== rule.id &&
        other.enabled &&
        other.data_mode !== "rest" &&
        other.robots.some((robot) => rule.robots.includes(robot))
    );
    const untouched =
      !carved && rule.robots.length > 0 && rule.robots.every((robot) => !earlier.has(robot));
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

const REDO_PENDING = "已安排全部重做。当前这一波结束后重新扫描，进度从 0 开始，新的 CSV 写好后覆盖原来的文件。";

function QueueProgress({
  queue,
  title,
  rank,
  onRedo,
  redoBusy,
  redoPending,
}: {
  queue: RetargetQueue;
  title: string;
  rank: string;
  onRedo?: (ruleId: string, title: string) => void;
  redoBusy?: string;
  redoPending?: boolean;
}) {
  const donePercent = queue.total ? Math.min(100, (queue.done / queue.total) * 100) : 0;
  const failedPercent = queue.total ? Math.min(100 - donePercent, (queue.failed / queue.total) * 100) : 0;
  const busy = redoBusy === queue.key;
  const waiting = !!redoPending && queue.total === 0;
  return (
    <li className={queue.active ? "is-active" : undefined}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem" }}>
        <strong>
          {rank}
          {queue.active ? " · 当前" : ""}
        </strong>
        <span className="retarget-queue-actions">
          {onRedo ? (
            <button
              type="button"
              className="secondary retarget-mini"
              disabled={!!redoBusy}
              onClick={() => onRedo(queue.key, title)}
            >
              {busy ? "正在安排" : "本级全部重做"}
            </button>
          ) : null}
          <span>{queueCountText(queue)}</span>
        </span>
      </div>
      <div>{title}</div>
      <div className="muted">{waiting ? REDO_PENDING : queueTimeText(queue)}</div>
      <div className="retarget-bar">
        {waiting ? null : (
          <>
            <span className="retarget-bar-done" style={{ width: `${donePercent}%` }} />
            {failedPercent > 0 ? (
              <span className="retarget-bar-failed" style={{ width: `${failedPercent}%` }} />
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

function PriorityProgress({
  rules,
  queues,
  recounting,
  onRedo,
  redoBusy,
  redoIds,
}: {
  rules: PriorityRule[];
  queues: RetargetQueue[];
  recounting: boolean;
  onRedo: (ruleId: string, title: string) => void;
  redoBusy: string;
  redoIds: ReadonlySet<string>;
}) {
  const byKey = new Map(queues.map((queue) => [queue.key, queue]));
  const unlisted = byKey.get("unlisted");
  const waiting = rules.some((rule) => rule.enabled && !byKey.has(rule.id));
  return (
    <>
      {recounting ? (
        <p className="muted" style={{ margin: 0 }}>
          正在重新统计。下面先显示上一轮已经算好的数量，没有数字的档还在算。
        </p>
      ) : waiting ? (
        <p className="muted" style={{ margin: 0 }}>
          有的档还没有数量，其余档显示的是最近一次统计。
        </p>
      ) : null}
      <ol className="retarget-queues">
        {rules.map((rule, index) => {
          const earlier = new Set(rules.slice(0, index).flatMap((item) => (item.enabled ? item.robots : [])));
          const title = rule.enabled ? ruleTitle(rule, earlier, rules) : "已停用，不会参与排序";
          const queue = rule.enabled ? byKey.get(rule.id) : undefined;
          const tier = `第 ${rule.rank || index + 1} 档`;
          if (queue) {
            return (
              <QueueProgress
                key={rule.id}
                queue={queue}
                title={title}
                rank={tier}
                onRedo={onRedo}
                redoBusy={redoBusy}
                redoPending={redoIds.has(rule.id)}
              />
            );
          }
          const pending = redoIds.has(rule.id);
          return (
            <li key={rule.id}>
              <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem" }}>
                <strong>{tier}</strong>
                <span className="retarget-queue-actions">
                  {rule.enabled ? (
                    <button
                      type="button"
                      className="secondary retarget-mini"
                      disabled={!!redoBusy}
                      onClick={() => onRedo(rule.id, title)}
                    >
                      {redoBusy === rule.id ? "正在安排" : "本级全部重做"}
                    </button>
                  ) : null}
                  <span className="muted">{pending ? "排队重做" : rule.enabled ? "统计中" : "已停用"}</span>
                </span>
              </div>
              <div>{title}</div>
              {pending ? <div className="muted">{REDO_PENDING}</div> : null}
            </li>
          );
        })}
        {unlisted && unlisted.total > 0 ? (
          <QueueProgress
            queue={unlisted}
            title={unlisted.title}
            rank={rankLabel(unlisted.rank)}
            onRedo={onRedo}
            redoBusy={redoBusy}
            redoPending={redoIds.has(unlisted.key)}
          />
        ) : null}
      </ol>
    </>
  );
}

/** 表格的一行：一个数据节点，以及每台机器人在这个节点上的序号。 */
type MatrixRow = {
  key: string;
  kind: PriorityRule["data_mode"];
  include: TaxonomyPick[];
  exclude: TaxonomyPick[];
  targets: RetargetPin[];
  /** 机器人 -> 序号。没有填的机器人不在这里。 */
  cells: Record<string, number>;
  /** 序号 -> 这一行原来对应的规则编号，保存时沿用，进度和重做记录不会断。 */
  ids: Record<string, string>;
};

const REST_KEY = "rest";
const MAX_RANK = 999;
const MAX_TIERS = 160;

function scopeKey(
  kind: PriorityRule["data_mode"],
  include: TaxonomyPick[],
  exclude: TaxonomyPick[],
  targets: RetargetPin[],
) {
  if (kind === "rest") return REST_KEY;
  return JSON.stringify([
    kind,
    include.map((pick) => [pick.scheme, pick.name]),
    exclude.map((pick) => [pick.scheme, pick.name]),
    targets.map((item) => [item.batch, item.units]),
  ]);
}

function blankRow(
  kind: PriorityRule["data_mode"],
  include: TaxonomyPick[] = [],
  exclude: TaxonomyPick[] = [],
  targets: RetargetPin[] = [],
): MatrixRow {
  return { key: scopeKey(kind, include, exclude, targets), kind, include, exclude, targets, cells: {}, ids: {} };
}

/** 一条规则里的数据范围拆成表格的行。同一维度的多个分类、多个批次各占一行。 */
function ruleScopes(rule: PriorityRule): MatrixRow[] {
  if (rule.data_mode === "rest") return [blankRow("rest")];
  if (rule.data_mode === "targets") {
    return (rule.targets || []).map((item) =>
      blankRow("targets", [], [], [{ batch: item.batch, units: [...item.units] }]),
    );
  }
  const include = rulePicks(rule, "include").map((pick) => ({ ...pick }));
  const exclude = rulePicks(rule, "exclude").map((pick) => ({ ...pick }));
  if (!include.length) return [];
  if (!exclude.length && include.every((pick) => pick.scheme === include[0].scheme)) {
    return include.map((pick) => blankRow("taxonomy", [pick]));
  }
  return [blankRow("taxonomy", include, exclude)];
}

function rulesToMatrix(rules: PriorityRule[]): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const byKey = new Map<string, MatrixRow>();
  let previous = 0;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const number = Math.min(MAX_RANK, Math.max(rule.rank || previous + 1, previous, 1));
    previous = number;
    for (const scope of ruleScopes(rule)) {
      let row = byKey.get(scope.key);
      if (!row) {
        row = scope;
        byKey.set(row.key, row);
        rows.push(row);
      }
      let placed = false;
      for (const robot of rule.robots) {
        // 排在前面的规则已经拿走了这台机器人的这份数据。
        if (row.cells[robot] != null) continue;
        row.cells[robot] = number;
        placed = true;
      }
      if (placed && !row.ids[number]) row.ids[number] = rule.id;
    }
  }
  if (!byKey.has(REST_KEY)) rows.push(blankRow("rest"));
  return rows;
}

function newRuleId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : `rule-${Date.now().toString(16)}${Math.floor(Math.random() * 4096).toString(16)}`;
}

/** 表格换回按顺序执行的规则：序号小的在前，序号相同时上面的行在前。 */
function matrixToRules(rows: MatrixRow[], robots: string[]): PriorityRule[] {
  const used = new Set<string>();
  const found: { number: number; index: number; rule: PriorityRule }[] = [];
  rows.forEach((row, index) => {
    const groups = new Map<number, string[]>();
    for (const robot of robots) {
      const number = row.cells[robot];
      if (!number) continue;
      const names = groups.get(number);
      if (names) names.push(robot);
      else groups.set(number, [robot]);
    }
    groups.forEach((names, number) => {
      let id = row.ids[number];
      if (!id || used.has(id)) id = newRuleId();
      used.add(id);
      const include = row.include.map((pick) => ({ ...pick }));
      const exclude = row.exclude.map((pick) => ({ ...pick }));
      found.push({
        number,
        index,
        rule: {
          id,
          enabled: true,
          robots: names,
          data_mode: row.kind,
          scheme: include[0]?.scheme || "",
          include_names: include.map((pick) => pick.name),
          exclude_names: exclude.map((pick) => pick.name),
          include_picks: include,
          exclude_picks: exclude,
          targets: row.targets.map((item) => ({ batch: item.batch, units: [...item.units] })),
          rank: number,
        },
      });
    });
  });
  found.sort((a, b) => a.number - b.number || a.index - b.index);
  return found.map((item) => item.rule);
}

function cloneRows(rows: MatrixRow[]): MatrixRow[] {
  return JSON.parse(JSON.stringify(rows)) as MatrixRow[];
}

/** 只看每个节点、每台机器人的序号，用来比较两套优先级是不是一样。 */
function matrixSignature(rows: MatrixRow[]) {
  return JSON.stringify(
    rows
      .filter((row) => Object.keys(row.cells).length > 0)
      .map((row) => [row.key, Object.keys(row.cells).sort().map((robot) => [robot, row.cells[robot]])]),
  );
}

function rowLabel(row: MatrixRow, schemes: TaxonomySchemeDef[]) {
  if (row.kind === "rest") return { title: "其余数据", note: "没有被其他行点名的数据" };
  if (row.kind === "targets") {
    return { title: row.targets.map((item) => pinLabel(item)).join("、") || "未选数据", note: "指定数据" };
  }
  let title = row.include.map((pick) => pick.name).join(" + ") || "未选分类";
  if (row.exclude.length) title += `（不含 ${row.exclude.map((pick) => pick.name).join("、")}）`;
  const kinds: string[] = [];
  for (const pick of row.include) {
    const label = taxonomySchemeLabel(pick.scheme, schemes);
    if (!kinds.includes(label)) kinds.push(label);
  }
  return { title, note: kinds.join(" 且 ") };
}

function parseRank(text: string): number | null {
  const value = parseInt(text.replace(/\D/g, "").slice(0, 3), 10);
  if (!Number.isFinite(value) || value < 1) return null;
  return Math.min(MAX_RANK, value);
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

const FOLDER_SCHEME: TaxonomySchemeDef = {
  key: "folder",
  name: "存储结构",
  code_prefix: "",
  sort_order: -1,
  builtin: true,
  description: "",
};

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
          const checked =
            scheme.key === "folder"
              ? nodes.filter((node) => names.includes(node.path)).map((node) => node.id)
              : namesToIds(nodes, names);
          const rankById = new Map<number, number>();
          names.forEach((name) => {
            const node =
              scheme.key === "folder"
                ? nodes.find((item) => item.path === name)
                : nodes.find((item) => item.name === name);
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
                        .map((nodeId) => nodes.find((node) => node.id === nodeId))
                        .filter((node): node is TaxonomyNode => !!node)
                        .map((node) => (scheme.key === "folder" ? node.path : node.name))
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

function PriorityMatrix({
  rows,
  savedRows,
  robots,
  schemes,
  nodesByScheme,
  onChange,
}: {
  rows: MatrixRow[];
  savedRows: MatrixRow[];
  robots: string[];
  schemes: TaxonomySchemeDef[];
  nodesByScheme: Record<string, TaxonomyNode[]>;
  onChange: (rows: MatrixRow[]) => void;
}) {
  const [draft, setDraft] = useState<TaxonomyPick[]>([]);
  const tableRef = useRef<HTMLTableElement>(null);
  const saved = new Map(savedRows.map((row) => [row.key, row]));

  const patchRow = (key: string, cells: Record<string, number>) => {
    onChange(rows.map((row) => (row.key === key ? { ...row, cells } : row)));
  };

  const setCell = (row: MatrixRow, robot: string, text: string) => {
    const cells = { ...row.cells };
    const value = parseRank(text);
    if (value == null) delete cells[robot];
    else cells[robot] = value;
    patchRow(row.key, cells);
  };

  const fillRow = (row: MatrixRow, text: string) => {
    const value = parseRank(text);
    const cells: Record<string, number> = {};
    if (value != null) for (const robot of robots) cells[robot] = value;
    patchRow(row.key, cells);
  };

  const fillColumn = (robot: string, text: string) => {
    const value = parseRank(text);
    onChange(
      rows.map((row) => {
        const cells = { ...row.cells };
        if (value == null) delete cells[robot];
        else cells[robot] = value;
        return { ...row, cells };
      }),
    );
  };

  const compact = () => {
    const numbers = [...new Set(rows.flatMap((row) => Object.values(row.cells)))].sort((a, b) => a - b);
    const next = new Map(numbers.map((value, index) => [value, index + 1]));
    onChange(
      rows.map((row) => {
        const cells: Record<string, number> = {};
        const ids: Record<string, string> = {};
        for (const [robot, value] of Object.entries(row.cells)) cells[robot] = next.get(value) || value;
        for (const [value, id] of Object.entries(row.ids)) {
          const moved = next.get(Number(value));
          if (moved) ids[moved] = id;
        }
        return { ...row, cells, ids };
      }),
    );
  };

  const addDraft = () => {
    const have = new Set(rows.map((row) => row.key));
    const fresh = draft
      .map((pick) => blankRow("taxonomy", [{ ...pick }]))
      .filter((row) => !have.has(row.key));
    if (fresh.length) onChange([...rows, ...fresh]);
    setDraft([]);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const step =
      event.key === "ArrowDown" || event.key === "Enter" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    const input = event.currentTarget;
    const row = Number(input.dataset.row) + step;
    const target = tableRef.current?.querySelector<HTMLInputElement>(
      `input[data-row="${row}"][data-col="${input.dataset.col}"]`,
    );
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  const numbers = rows.flatMap((row) => Object.values(row.cells));
  const distinct = new Set(numbers);
  const canCompact = distinct.size > 0 && Math.max(...numbers) !== distinct.size;
  const columnValue = (robot: string) => {
    const values = new Set(rows.map((row) => row.cells[robot] ?? 0));
    const only = values.size === 1 ? [...values][0] : 0;
    return only ? String(only) : "";
  };

  return (
    <div className="retarget-matrix-box">
      <div className="retarget-matrix-wrap">
        <table className="retarget-matrix" ref={tableRef}>
          <thead>
            <tr>
              <th className="retarget-matrix-node">数据节点</th>
              <th className="retarget-matrix-all">整行</th>
              {robots.map((robot) => (
                <th key={robot} title={robot}>
                  {robot}
                </th>
              ))}
              <th className="retarget-matrix-op" />
            </tr>
            <tr className="retarget-matrix-fill">
              <th className="retarget-matrix-node">整列填同一个序号</th>
              <th className="retarget-matrix-all" />
              {robots.map((robot, col) => (
                <th key={robot}>
                  <input
                    className="retarget-cell"
                    inputMode="numeric"
                    aria-label={`${robot} 整列`}
                    placeholder="整列"
                    value={columnValue(robot)}
                    data-row={-1}
                    data-col={col}
                    onFocus={(event) => event.target.select()}
                    onKeyDown={onKey}
                    onChange={(event) => fillColumn(robot, event.target.value)}
                  />
                </th>
              ))}
              <th className="retarget-matrix-op" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const label = rowLabel(row, schemes);
              const before = saved.get(row.key);
              const values = new Set(robots.map((robot) => row.cells[robot] ?? 0));
              const whole = values.size === 1 && [...values][0] ? String([...values][0]) : "";
              return (
                <tr key={row.key} className={before ? undefined : "is-new"}>
                  <th className="retarget-matrix-node" scope="row" title={label.title}>
                    <div>{label.title}</div>
                    <div className="muted">{before ? label.note : `${label.note} · 新加`}</div>
                  </th>
                  <td className="retarget-matrix-all">
                    <input
                      className="retarget-cell"
                      inputMode="numeric"
                      aria-label={`${label.title} 整行`}
                      placeholder="整行"
                      value={whole}
                      data-row={index}
                      data-col="all"
                      onFocus={(event) => event.target.select()}
                      onKeyDown={onKey}
                      onChange={(event) => fillRow(row, event.target.value)}
                    />
                  </td>
                  {robots.map((robot, col) => {
                    const value = row.cells[robot];
                    const changed = (before?.cells[robot] ?? 0) !== (value ?? 0);
                    return (
                      <td key={robot}>
                        <input
                          className={`retarget-cell${value ? " is-set" : ""}${changed ? " is-changed" : ""}`}
                          inputMode="numeric"
                          aria-label={`${label.title} · ${robot}`}
                          placeholder="—"
                          value={value ?? ""}
                          data-row={index}
                          data-col={col}
                          onFocus={(event) => event.target.select()}
                          onKeyDown={onKey}
                          onChange={(event) => setCell(row, robot, event.target.value)}
                        />
                      </td>
                    );
                  })}
                  <td className="retarget-matrix-op">
                    {row.kind === "rest" ? null : (
                      <button
                        type="button"
                        className="secondary retarget-mini"
                        onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
                      >
                        移除
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="retarget-matrix-add">
        <span className="muted">添加数据节点</span>
        <SchemeFacets schemes={schemes} nodesByScheme={nodesByScheme} picks={draft} onChange={setDraft} />
        <button type="button" className="secondary retarget-mini" disabled={!draft.length} onClick={addDraft}>
          {draft.length ? `加入表格（${draft.length} 行）` : "加入表格"}
        </button>
        <button type="button" className="secondary retarget-mini" disabled={!canCompact} onClick={compact}>
          序号排成 1、2、3…
        </button>
      </div>
    </div>
  );
}

export function RetargetManagePage() {
  const { isAdmin } = useAuth();
  const adoptRules = (cfg: RetargetPriority) => {
    const matrix = rulesToMatrix(cfg.rules || []);
    setRows(matrix);
    setSavedRows(cloneRows(matrix));
    setSavedRules(cloneRules(cfg.rules || []));
    setRobots(cfg.robots || []);
    setPresets(cfg.presets || []);
    setPins(cfg.pins || []);
  };
  const [data, setData] = useState<RetargetStatus | null>(null);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<MatrixRow[]>([]);
  const [savedRows, setSavedRows] = useState<MatrixRow[]>([]);
  const [savedRules, setSavedRules] = useState<PriorityRule[]>([]);
  const [robots, setRobots] = useState<string[]>([]);
  const [presets, setPresets] = useState<PriorityPreset[]>([]);
  const [, setPins] = useState<RetargetPin[]>([]);
  const [presetName, setPresetName] = useState("");
  const [schemes, setSchemes] = useState<TaxonomySchemeDef[]>([]);
  const [nodesByScheme, setNodesByScheme] = useState<Record<string, TaxonomyNode[]>>({});
  const [priorityError, setPriorityError] = useState("");
  const [priorityNote, setPriorityNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [redoBusy, setRedoBusy] = useState("");
  const [redoIds, setRedoIds] = useState<string[]>([]);
  const rowsRef = useRef(rows);
  const savedRef = useRef(savedRows);
  const savingRef = useRef(false);
  const loadingSchemes = useRef(new Set<string>());
  rowsRef.current = rows;
  savedRef.current = savedRows;
  savingRef.current = saving;

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    api
      .listTaxonomySchemes({ quiet: true })
      .then((next) => {
        if (alive) setSchemes(next);
      })
      .catch(() => undefined);
    const applyPriority = (cfg: RetargetPriority) => {
      adoptRules(cfg);
      setRedoIds(cfg.redo || []);
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
      const untouched = JSON.stringify(rowsRef.current) === JSON.stringify(savedRef.current);
      if (!savingRef.current && untouched) {
        api
          .retargetPriority()
          .then((cfg) => {
            if (!alive || savingRef.current) return;
            if (JSON.stringify(rowsRef.current) !== JSON.stringify(savedRef.current)) return;
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
    if (!isAdmin) return;
    let alive = true;
    api
      .retargetStorageTree()
      .then((nodes) => {
        if (alive) setNodesByScheme((prev) => ({ ...prev, folder: nodes }));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [isAdmin]);

  useEffect(() => {
    for (const scheme of schemes) {
      if (!scheme.key || nodesByScheme[scheme.key] || loadingSchemes.current.has(scheme.key)) continue;
      loadingSchemes.current.add(scheme.key);
      api
        .listTaxonomies(scheme.key, { quiet: true })
        .then((nodes) => {
          setNodesByScheme((prev) => ({ ...prev, [scheme.key]: nodes }));
        })
        .catch(() => {
          loadingSchemes.current.delete(scheme.key);
        });
    }
  }, [schemes, nodesByScheme]);

  const redoTier = (ruleId: string, title: string) => {
    const ok = window.confirm(
      `确定把「${title}」全部重新重定向吗？\n已有的 CSV 会在新结果写好后被覆盖，在此之前旧文件仍然保留。这一档的进度会从 0 重新计算。`,
    );
    if (!ok) return;
    setRedoBusy(ruleId);
    setPriorityError("");
    api
      .redoRetargetTier(ruleId)
      .then((result) => {
        setPriorityNote(result.message);
        setRedoIds((prev) => (prev.includes(ruleId) ? prev : [...prev, ruleId]));
      })
      .catch((err: Error) => {
        setPriorityError(err.message || "安排重做失败");
      })
      .finally(() => setRedoBusy(""));
  };

  const facetSchemes = [FOLDER_SCHEME, ...schemes];
  const dirty = JSON.stringify(rows) !== JSON.stringify(savedRows);
  const savedSignature = matrixSignature(savedRows);

  /** 表格换成要保存的规则。填得不对时返回 null，并在页面上说明原因。 */
  const rulesFromTable = () => {
    const next = matrixToRules(rows, robots);
    if (!next.length) {
      setPriorityError("表格里至少要填一个序号");
      return null;
    }
    if (next.length > MAX_TIERS) {
      setPriorityError(`不同的序号太多了。同一行里多用相同的序号，让总档数不超过 ${MAX_TIERS}。`);
      return null;
    }
    return next;
  };

  const saveRules = () => {
    const next = rulesFromTable();
    if (!next) return;
    setSaving(true);
    savingRef.current = true;
    setPriorityError("");
    api
      .saveRetargetPriority(next)
      .then((cfg) => {
        adoptRules(cfg);
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
    adoptRules(cfg);
    setPriorityNote(note);
    setPriorityError("");
  };

  const saveAsPreset = () => {
    const name = presetName.trim();
    if (!name) {
      setPriorityError("请填写预设名称");
      return;
    }
    const next = rulesFromTable();
    if (!next) return;
    setSaving(true);
    savingRef.current = true;
    setPriorityError("");
    api
      .saveRetargetPreset(name, next)
      .then((cfg) => {
        setPresets(cfg.presets || []);
        setPins(cfg.pins || []);
        setPresetName("");
        setPriorityNote(
          dirty
            ? `已新增预设「${name}」。点名称会换成这套。正在执行的还是上次保存的优先级，要让它马上按这套排队，请再点保存优先级。`
            : `已新增预设「${name}」。点名称即可换成这套，当前这一波结束后重新扫描。`,
        );
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
        adoptConfig(cfg, `已换成预设「${preset.name}」。当前这一波结束后会按这套优先级重新扫描。`);
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
        setPriorityNote(`已删除预设「${preset.name}」。正在执行的优先级没有变。`);
      })
      .catch((err: Error) => {
        setPriorityError(err.message || "删除失败");
      })
      .finally(() => {
        setSaving(false);
        savingRef.current = false;
      });
  };

  const updateControl = (
    desired: "running" | "stopped",
    performance: "auto" | "light" | "balanced" | "heavy",
    method: "omniretarget" | "frax" = data?.method || "omniretarget",
  ) => {
    setControlBusy(true);
    setError("");
    api
      .setRetargetControl({ desired, performance, method })
      .then((next) => setData(next))
      .catch((err: Error) => setError(err.message || "设置失败"))
      .finally(() => setControlBusy(false));
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
        <div className="retarget-control">
          <div className="row">
            <button
              type="button"
              disabled={controlBusy || (data?.desired !== "stopped" && data?.running !== false)}
              onClick={() => updateControl("running", data?.performance || "heavy")}
            >
              启动
            </button>
            <button
              type="button"
              className="secondary"
              disabled={controlBusy || data?.desired === "stopped" || data?.phase === "stopping"}
              onClick={() => updateControl("stopped", data?.performance || "heavy")}
            >
              {data?.phase === "stopping" ? "正在停止" : "停止"}
            </button>
          </div>
          <div className="retarget-modes" role="group" aria-label="占用强度">
            {PERFORMANCE_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={(data?.performance || "heavy") === mode.id ? "is-on" : ""}
                disabled={controlBusy}
                onClick={() => updateControl(data?.desired === "stopped" ? "stopped" : "running", mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <span className="muted">{performanceHint(data?.performance || "heavy", data?.performance_note)}</span>
          <div className="retarget-modes" role="group" aria-label="重定向方法">
            {RETARGET_METHODS.map((method) => (
              <button
                key={method.id}
                type="button"
                className={(data?.method || "omniretarget") === method.id ? "is-on" : ""}
                disabled={controlBusy}
                onClick={() =>
                  updateControl(
                    data?.desired === "stopped" ? "stopped" : "running",
                    data?.performance || "heavy",
                    method.id,
                  )
                }
              >
                {method.label}
              </button>
            ))}
          </div>
          <span className="muted">换方法后，当前这一波结束就重新扫描。已经写好的文件会保留。</span>
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
          「本级全部重做」会把这一档已完成和失败的任务从头再跑，新的 CSV 写好后覆盖原来的文件。
        </p>
        {priorityNote ? <div className="muted">{priorityNote}</div> : null}
        {priorityError ? <div className="error">{priorityError}</div> : null}
        {savedRules.length ? (
          <PriorityProgress
            rules={savedRules}
            queues={queues}
            recounting={data?.phase === "scanning"}
            onRedo={redoTier}
            redoBusy={redoBusy}
            redoIds={new Set(redoIds)}
          />
        ) : queues.length ? (
          <ol className="retarget-queues">
            {queues.filter((queue) => queue.key !== "pinned").map((queue) => (
              <QueueProgress
                key={queue.key}
                queue={queue}
                title={queue.title}
                rank={rankLabel(queue.rank)}
                onRedo={redoTier}
                redoBusy={redoBusy}
              />
            ))}
          </ol>
        ) : (
          <div className="muted">{data ? "扫描完成后显示各档数量和时间" : "正在读取进度…"}</div>
        )}
      </section>

      <section className="card stack">
        <h2>调整优先级</h2>
        <p className="muted" style={{ margin: 0 }}>
          每一行是一个数据节点，每一列是一台机器人，格子里填序号：数字小的先做，留空表示这台机器人不单独排这份数据。序号相同时，上面的行先做，同一行里左边的机器人先做。「其余数据」是这台机器人没有被其他行点名的全部动作。一份数据同时落在几行里时，按序号最小的那一行算。按回车或上下方向键可以在同一列里移动。保存后，当前这一波结束就会按新顺序重新扫描。
        </p>
        {priorityError ? <div className="error">{priorityError}</div> : null}
        {priorityNote ? <div className="muted">{priorityNote}</div> : null}
        <PriorityMatrix
          rows={rows}
          savedRows={savedRows}
          robots={robots}
          schemes={facetSchemes}
          nodesByScheme={nodesByScheme}
          onChange={(next) => {
            setRows(next);
            setPriorityNote("");
            setPriorityError("");
          }}
        />
        <div className="row">
          <button type="button" disabled={!dirty || saving} onClick={saveRules}>
            {saving ? "正在保存" : "保存优先级"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!dirty || saving}
            onClick={() => {
              setRows(cloneRows(savedRows));
              setPriorityNote("");
              setPriorityError("");
            }}
          >
            放弃修改
          </button>
          {dirty ? <span className="muted">有改动还没保存，改过的格子带蓝色边框。</span> : null}
        </div>
        <div className="retarget-preset-box">
          <strong>预设</strong>
          <p className="muted" style={{ margin: 0 }}>
            填好上面的表格后，填一个新名称，就能把当前优先级新增成一套预设。可以存多套。点预设名称会换成那一套，当前这一波结束后重新扫描。删除预设不会改正在执行的优先级。
          </p>
          <div className="retarget-presets">
            {presets.map((preset) => {
              const active = matrixSignature(rulesToMatrix(preset.rules)) === savedSignature;
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
              placeholder="预设名称"
              maxLength={24}
              onChange={(event) => setPresetName(event.target.value)}
            />
            <button type="button" className="secondary" disabled={saving || !presetName.trim()} onClick={saveAsPreset}>
              把当前优先级新增为预设
            </button>
          </div>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          noetix_e2v2_1015、unitree_g1、noetix_e2 整列都没填序号时，仍会排在最后继续重定向。新加入的机器人要在表格里填了序号并保存后才会开始。同一个序号里，开源数据和其他数据集会稍晚一些，小批次先做。
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
