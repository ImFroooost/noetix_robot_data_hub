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
  redo_waiting_rescan?: boolean;
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

export type RetargetPin = { batch: string; units: string[] };

export type MatrixLayoutRow = {
  key: string;
  kind: PriorityRule["data_mode"];
  include: TaxonomyPick[];
  exclude: TaxonomyPick[];
  targets: RetargetPin[];
  row_rank: number;
  overrides: Record<string, number>;
};

export type MatrixLayout = {
  robot_order: string[];
  col_ranks: Record<string, number>;
  rows: MatrixLayoutRow[];
};

export type PriorityPreset = {
  id: string;
  name: string;
  builtin: boolean;
  rules: PriorityRule[];
  layout?: MatrixLayout;
};

export type RetargetPriority = {
  version: number;
  rules: PriorityRule[];
  layout?: MatrixLayout;
  robots: string[];
  defaults: PriorityRule[];
  presets?: PriorityPreset[];
  pins?: RetargetPin[];
  redo?: string[];
  redo_stamps?: Record<string, number>;
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

const REDO_PENDING =
  "已安排全部重做，进度已从 0 重新计算。当前这一波结束后重新扫描执行，新的 CSV 写好后覆盖原来的文件。";

function parseEpochSec(value?: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function QueueProgress({
  queue,
  title,
  rank,
  onRedo,
  redoBusy,
  redoPending,
  redoStamp,
  roundStartedSec,
}: {
  queue: RetargetQueue;
  title: string;
  rank: string;
  onRedo?: (ruleId: string, title: string) => void;
  redoBusy?: string;
  redoPending?: boolean;
  redoStamp?: number;
  roundStartedSec?: number | null;
}) {
  const waitingRescan = Boolean(
    queue.redo_waiting_rescan ||
      (redoStamp != null && (roundStartedSec == null || redoStamp > roundStartedSec)) ||
      (redoPending && queue.total === 0),
  );
  const displayQueue: RetargetQueue = waitingRescan
    ? { ...queue, done: 0, failed: 0, remaining: queue.total }
    : queue;
  const donePercent = displayQueue.total ? Math.min(100, (displayQueue.done / displayQueue.total) * 100) : 0;
  const failedPercent = displayQueue.total
    ? Math.min(100 - donePercent, (displayQueue.failed / displayQueue.total) * 100)
    : 0;
  const busy = redoBusy === queue.key;
  return (
    <li className={displayQueue.active ? "is-active" : undefined}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem" }}>
        <strong>
          {rank}
          {displayQueue.active ? " · 当前" : ""}
        </strong>
        <span className="retarget-queue-actions">
          {onRedo ? (
            <button
              type="button"
              className="secondary retarget-mini"
              disabled={!!redoBusy}
              onClick={() => onRedo(queue.key, title)}
            >
              {busy ? "正在安排" : waitingRescan ? "已安排重做" : "本级全部重做"}
            </button>
          ) : null}
          <span>{queueCountText(displayQueue)}</span>
        </span>
      </div>
      <div>{title}</div>
      <div className="muted">
        {waitingRescan
          ? `${REDO_PENDING}${displayQueue.total > 0 && displayQueue.eta_seconds != null ? `（${queueTimeText(displayQueue)}）` : ""}`
          : queueTimeText(displayQueue)}
      </div>
      <div className="retarget-bar">
        {waitingRescan ? null : (
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

/** 表格的一行：一个数据节点，包含行优先级（纵轴）以及用户对单个格子的手动覆盖。 */
type MatrixRow = {
  key: string;
  kind: PriorityRule["data_mode"];
  include: TaxonomyPick[];
  exclude: TaxonomyPick[];
  targets: RetargetPin[];
  /** 纵轴优先级：正整数（越小越优先），或 -1 表示该行不执行。 */
  rowRank: number;
  /** 机器人 -> 用户手动修改的格子序号（正整数或 -1）。未在此记录的格子按行列优先级自动计算。 */
  overrides: Record<string, number>;
  /** 序号 -> 这一行原来对应的规则编号，保存时沿用，进度和重做记录不会断。 */
  ids: Record<string, string>;
};

type MatrixState = {
  /** 横轴：机器人实例排列顺序（用户可左右调整）。 */
  robots: string[];
  /** 横轴优先级：机器人 -> 正整数（越小越优先），或 -1 表示该列不执行。 */
  colRanks: Record<string, number>;
  /** 纵轴：数据节点排列顺序（用户可上下调整）。 */
  rows: MatrixRow[];
};

const REST_KEY = "rest";
const SKIP_RANK = -1;
const MAX_RANK = 9999;
const MAX_TIERS = 2000;

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
  rowRank = 1,
): MatrixRow {
  return {
    key: scopeKey(kind, include, exclude, targets),
    kind,
    include,
    exclude,
    targets,
    rowRank,
    overrides: {},
    ids: {},
  };
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

/**
 * 默认单元格优先级计算：
 * 1. 若行优先级为 -1 或列优先级为 -1，则默认值为 -1（不执行）；
 * 2. 否则先做完当前高优先级数据节点（按 rowRank 升序，相同时按纵轴从上到下顺序），
 *    再在该数据节点内部按照机器人实例优先级（colRank 升序）依次递增分配序号。
 */
function computeAutoCellRanks(
  rows: MatrixRow[],
  robots: string[],
  colRanks: Record<string, number>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const row of rows) out[row.key] = {};

  const activeRobots = robots.filter((robot) => (colRanks[robot] ?? SKIP_RANK) > 0);
  const distinctColRanks = [...new Set(activeRobots.map((robot) => colRanks[robot]))].sort((a, b) => a - b);

  const orderedActiveRows = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.rowRank > 0)
    .sort((a, b) => a.row.rowRank - b.row.rowRank || a.index - b.index);

  let nextTier = 1;
  const rowColTier = new Map<string, number>();
  for (const { row } of orderedActiveRows) {
    for (const cRank of distinctColRanks) {
      rowColTier.set(`${row.key}::${cRank}`, Math.min(MAX_RANK, nextTier));
      nextTier += 1;
    }
  }

  for (const row of rows) {
    for (const robot of robots) {
      const cRank = colRanks[robot] ?? SKIP_RANK;
      if (row.rowRank === SKIP_RANK || cRank === SKIP_RANK) {
        out[row.key][robot] = SKIP_RANK;
      } else {
        out[row.key][robot] = rowColTier.get(`${row.key}::${cRank}`) ?? SKIP_RANK;
      }
    }
  }
  return out;
}

function effectiveCellRank(
  row: MatrixRow,
  robot: string,
  autoMap: Record<string, Record<string, number>>,
): number {
  const manual = row.overrides[robot];
  if (manual !== undefined) return manual;
  return autoMap[row.key]?.[robot] ?? SKIP_RANK;
}

function rulesToMatrixState(
  rules: PriorityRule[],
  catalogRobots: string[],
  layout?: MatrixLayout | null,
): MatrixState {
  const idsByScope = new Map<string, Record<string, string>>();
  const explicitByScope = new Map<string, Record<string, number>>();
  const discoveredScopes: MatrixRow[] = [];
  const discoveredByKey = new Map<string, MatrixRow>();

  let previousPos = 0;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    let rank: number;
    if (rule.rank === SKIP_RANK) {
      rank = SKIP_RANK;
    } else {
      rank = Math.min(MAX_RANK, Math.max(rule.rank || previousPos + 1, previousPos, 1));
      previousPos = rank;
    }
    for (const scope of ruleScopes(rule)) {
      if (!discoveredByKey.has(scope.key)) {
        discoveredByKey.set(scope.key, scope);
        discoveredScopes.push(scope);
      }
      const cellMap = explicitByScope.get(scope.key) || {};
      const idMap = idsByScope.get(scope.key) || {};
      let placed = false;
      for (const robot of rule.robots) {
        if (cellMap[robot] != null) continue;
        cellMap[robot] = rank;
        if (rank !== SKIP_RANK && !idMap[robot] && !placed) {
          idMap[robot] = rule.id;
        }
        placed = true;
      }
      if (rank === SKIP_RANK && placed && !idMap.__skip__) {
        idMap.__skip__ = rule.id;
      }
      explicitByScope.set(scope.key, cellMap);
      idsByScope.set(scope.key, idMap);
    }
  }

  // 合并机器人目录顺序
  const allCatalog = catalogRobots.length
    ? [...catalogRobots]
    : [...new Set(rules.flatMap((rule) => rule.robots))];

  if (layout && (layout.rows?.length || Object.keys(layout.col_ranks || {}).length || layout.robot_order?.length)) {
    const allowedSet = new Set(allCatalog);
    const robots: string[] = [];
    for (const r of layout.robot_order || []) {
      if (allowedSet.has(r) && !robots.includes(r)) robots.push(r);
    }
    for (const r of allCatalog) {
      if (!robots.includes(r)) robots.push(r);
    }
    const colRanks: Record<string, number> = {};
    let fallbackCol = 1;
    for (const r of robots) {
      const savedCol = layout.col_ranks?.[r];
      if (savedCol === SKIP_RANK || (typeof savedCol === "number" && savedCol >= 1)) {
        colRanks[r] = savedCol;
        if (savedCol >= fallbackCol) fallbackCol = savedCol + 1;
      } else {
        colRanks[r] = SKIP_RANK;
      }
    }

    const rows: MatrixRow[] = [];
    const seenKeys = new Set<string>();
    for (const item of layout.rows || []) {
      const key = scopeKey(item.kind, item.include || [], item.exclude || [], item.targets || []);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const overrides: Record<string, number> = {};
      for (const [rk, rv] of Object.entries(item.overrides || {})) {
        if (allowedSet.has(rk) && (rv === SKIP_RANK || (typeof rv === "number" && rv >= 1))) {
          overrides[rk] = rv;
        }
      }
      rows.push({
        key,
        kind: item.kind,
        include: (item.include || []).map((p) => ({ ...p })),
        exclude: (item.exclude || []).map((p) => ({ ...p })),
        targets: (item.targets || []).map((t) => ({ batch: t.batch, units: [...t.units] })),
        rowRank:
          item.row_rank === SKIP_RANK || (typeof item.row_rank === "number" && item.row_rank >= 1)
            ? item.row_rank
            : rows.length + 1,
        overrides,
        ids: { ...(idsByScope.get(key) || {}) },
      });
    }
    // 补充外部新置顶但尚未写入 layout 的规则
    const extraFront: MatrixRow[] = [];
    for (const scope of discoveredScopes) {
      if (scope.key === REST_KEY || seenKeys.has(scope.key)) continue;
      seenKeys.add(scope.key);
      extraFront.push({
        ...scope,
        rowRank: 1,
        overrides: { ...(explicitByScope.get(scope.key) || {}) },
        ids: { ...(idsByScope.get(scope.key) || {}) },
      });
    }
    if (extraFront.length) {
      rows.forEach((r) => {
        if (r.rowRank > 0) r.rowRank = Math.min(MAX_RANK, r.rowRank + extraFront.length);
      });
      extraFront.forEach((r, idx) => {
        r.rowRank = idx + 1;
      });
      rows.unshift(...extraFront);
    }
    if (!seenKeys.has(REST_KEY)) {
      const maxPos = rows.reduce((m, r) => (r.rowRank > m ? r.rowRank : m), 0);
      rows.push({
        ...blankRow("rest", [], [], [], maxPos + 1),
        ids: { ...(idsByScope.get(REST_KEY) || {}) },
      });
    }
    return { robots, colRanks, rows };
  }

  // 兼容旧格式配置（尚未保存 layout）或内置预设
  const robots = [...allCatalog];
  const rawRows = [...discoveredScopes];
  if (!discoveredByKey.has(REST_KEY)) rawRows.push(blankRow("rest"));

  const restExplicit = explicitByScope.get(REST_KEY) || {};
  const effectiveByRow = new Map<string, Record<string, number>>();
  for (const row of rawRows) {
    const exp = explicitByScope.get(row.key) || {};
    const eff: Record<string, number> = {};
    const isWholeBatchTarget =
      row.kind === "targets" && row.targets.some((t) => !t.units || t.units.length === 0);
    for (const robot of robots) {
      if (exp[robot] != null) {
        eff[robot] = exp[robot];
      } else if (row.kind === "rest") {
        eff[robot] = SKIP_RANK;
      } else if (isWholeBatchTarget) {
        eff[robot] = SKIP_RANK;
      } else {
        eff[robot] = restExplicit[robot] ?? SKIP_RANK;
      }
    }
    effectiveByRow.set(row.key, eff);
  }

  // 推导列优先级：整列全为 -1 则列优先级为 -1；否则按其余数据/最小正优先级排序赋 1, 2, 3…
  const colRanks: Record<string, number> = {};
  const activeRobotOrder = robots
    .map((robot, idx) => {
      const vals = rawRows.map((r) => effectiveByRow.get(r.key)?.[robot] ?? SKIP_RANK);
      const posVals = vals.filter((v) => v > 0);
      if (!posVals.length) return { robot, active: false, restVal: Infinity, minVal: Infinity, idx };
      const rVal = restExplicit[robot] && restExplicit[robot] > 0 ? restExplicit[robot] : Infinity;
      return { robot, active: true, restVal: rVal, minVal: Math.min(...posVals), idx };
    });

  const sortedActive = activeRobotOrder
    .filter((item) => item.active)
    .sort((a, b) => a.restVal - b.restVal || a.minVal - b.minVal || a.idx - b.idx);

  for (const item of activeRobotOrder) {
    if (!item.active) colRanks[item.robot] = SKIP_RANK;
  }
  sortedActive.forEach((item, index) => {
    colRanks[item.robot] = index + 1;
  });

  // 推导行优先级
  let nextRowRank = 1;
  const rows: MatrixRow[] = rawRows.map((row) => {
    const eff = effectiveByRow.get(row.key) || {};
    const anyPos = robots.some((r) => (eff[r] ?? SKIP_RANK) > 0);
    const rRank = anyPos ? nextRowRank++ : SKIP_RANK;
    return {
      ...row,
      rowRank: rRank,
      overrides: {},
      ids: { ...(idsByScope.get(row.key) || {}) },
    };
  });

  const autoMap = computeAutoCellRanks(rows, robots, colRanks);
  for (const row of rows) {
    const eff = effectiveByRow.get(row.key) || {};
    for (const robot of robots) {
      const targetVal = eff[robot] ?? SKIP_RANK;
      const autoVal = autoMap[row.key]?.[robot] ?? SKIP_RANK;
      if (targetVal !== autoVal) {
        row.overrides[robot] = targetVal;
      }
    }
  }

  return { robots, colRanks, rows };
}

function stateToLayout(state: MatrixState): MatrixLayout {
  return {
    robot_order: [...state.robots],
    col_ranks: { ...state.colRanks },
    rows: state.rows.map((row) => ({
      key: row.key,
      kind: row.kind,
      include: row.include.map((p) => ({ ...p })),
      exclude: row.exclude.map((p) => ({ ...p })),
      targets: row.targets.map((t) => ({ batch: t.batch, units: [...t.units] })),
      row_rank: row.rowRank,
      overrides: { ...row.overrides },
    })),
  };
}

function newRuleId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : `rule-${Date.now().toString(16)}${Math.floor(Math.random() * 4096).toString(16)}`;
}

/** 表格换回按顺序执行的规则：每个正数单元格独立生成一条规则（进度与重做互不干扰），-1 合并生成跳过规则。 */
function matrixToRules(state: MatrixState): PriorityRule[] {
  const { rows, robots, colRanks } = state;
  const autoMap = computeAutoCellRanks(rows, robots, colRanks);
  const used = new Set<string>();
  const positiveFound: { number: number; index: number; colIndex: number; rule: PriorityRule }[] = [];
  const skipFound: { index: number; rule: PriorityRule }[] = [];

  rows.forEach((row, index) => {
    const skipRobots: string[] = [];
    robots.forEach((robot, colIndex) => {
      const number = effectiveCellRank(row, robot, autoMap);
      if (number === SKIP_RANK) {
        skipRobots.push(robot);
      } else if (number >= 1) {
        let id = row.ids[robot];
        if (!id || used.has(id)) id = newRuleId();
        used.add(id);
        const include = row.include.map((pick) => ({ ...pick }));
        const exclude = row.exclude.map((pick) => ({ ...pick }));
        positiveFound.push({
          number,
          index,
          colIndex,
          rule: {
            id,
            enabled: true,
            robots: [robot],
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
      }
    });
    if (skipRobots.length) {
      let id = row.ids.__skip__;
      if (!id || used.has(id)) id = newRuleId();
      used.add(id);
      const include = row.include.map((pick) => ({ ...pick }));
      const exclude = row.exclude.map((pick) => ({ ...pick }));
      skipFound.push({
        index,
        rule: {
          id,
          enabled: true,
          robots: skipRobots,
          data_mode: row.kind,
          scheme: include[0]?.scheme || "",
          include_names: include.map((pick) => pick.name),
          exclude_names: exclude.map((pick) => pick.name),
          include_picks: include,
          exclude_picks: exclude,
          targets: row.targets.map((item) => ({ batch: item.batch, units: [...item.units] })),
          rank: SKIP_RANK,
        },
      });
    }
  });

  positiveFound.sort((a, b) => a.number - b.number || a.index - b.index || a.colIndex - b.colIndex);
  skipFound.sort((a, b) => a.index - b.index);
  return [...positiveFound.map((item) => item.rule), ...skipFound.map((item) => item.rule)];
}

function cloneState(state: MatrixState): MatrixState {
  return JSON.parse(JSON.stringify(state)) as MatrixState;
}

/** 比较两套矩阵状态（含横纵轴顺序、轴优先级与有效单元格序号）是否相同。 */
function matrixSignature(state: MatrixState) {
  const autoMap = computeAutoCellRanks(state.rows, state.robots, state.colRanks);
  return JSON.stringify({
    robots: state.robots,
    colRanks: state.robots.map((r) => [r, state.colRanks[r] ?? SKIP_RANK]),
    rows: state.rows.map((row) => [
      row.key,
      row.rowRank,
      state.robots.map((r) => [r, effectiveCellRank(row, r, autoMap)]),
    ]),
  });
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

function normalizeNumericText(raw: string): string {
  return raw
    .replace(/[－—–]/g, "-")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
    .trim();
}

function parseRank(text: string): number | null {
  const norm = normalizeNumericText(text);
  if (!norm) return null;
  if (norm === "-1" || (norm.startsWith("-") && norm !== "-")) return SKIP_RANK;
  const digits = norm.replace(/\D/g, "").slice(0, 4);
  if (!digits) return null;
  const value = parseInt(digits, 10);
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

function RankInput({
  value,
  className,
  ariaLabel,
  title,
  dataRow,
  dataCol,
  onKeyNav,
  onCommit,
  onClear,
}: {
  value: number;
  className: string;
  ariaLabel: string;
  title?: string;
  dataRow: number;
  dataCol: number | string;
  onKeyNav: (event: KeyboardEvent<HTMLInputElement>) => void;
  onCommit: (next: number) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelRef = useRef(false);

  return (
    <input
      className={className}
      inputMode="text"
      aria-label={ariaLabel}
      title={title}
      value={draft !== null ? draft : String(value)}
      data-row={dataRow}
      data-col={dataCol}
      onFocus={(event) => {
        cancelRef.current = false;
        setDraft(String(value));
        const target = event.currentTarget;
        window.requestAnimationFrame(() => target.select());
      }}
      onChange={(event) => {
        const raw = normalizeNumericText(event.target.value);
        if (raw === "" || raw === "-") {
          setDraft(raw);
          return;
        }
        if (raw.startsWith("-")) {
          setDraft("-1");
          onCommit(SKIP_RANK);
          return;
        }
        const digits = raw.replace(/\D/g, "").slice(0, 4);
        setDraft(digits);
        const parsed = parseRank(digits);
        if (parsed !== null) {
          onCommit(parsed);
        }
      }}
      onBlur={() => {
        if (cancelRef.current) {
          cancelRef.current = false;
          setDraft(null);
          return;
        }
        if (draft !== null) {
          const norm = normalizeNumericText(draft);
          if (norm === "") {
            onClear();
          } else if (norm === "-") {
            onCommit(SKIP_RANK);
          } else {
            const parsed = parseRank(norm);
            if (parsed !== null) onCommit(parsed);
          }
        }
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancelRef.current = true;
          setDraft(null);
          event.currentTarget.blur();
          return;
        }
        onKeyNav(event);
      }}
    />
  );
}

/** 重排数组元素，并把非 -1 的正优先级按新顺序重新从左到右 / 从上到下对齐。 */
function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [picked] = next.splice(from, 1);
  next.splice(to, 0, picked);
  return next;
}

function RedoArrowIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      className={spinning ? "retarget-redo-svg is-spinning" : "retarget-redo-svg"}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

type CellProgressEntry = {
  rule: PriorityRule;
  queue?: RetargetQueue;
  title: string;
  tierLabel: string;
};

function PriorityMatrix({
  state,
  savedState,
  savedRules,
  queues,
  recounting,
  onRedo,
  redoBusy,
  redoIds,
  redoStamps,
  roundStartedSec,
  schemes,
  nodesByScheme,
  onChange,
}: {
  state: MatrixState;
  savedState: MatrixState;
  savedRules: PriorityRule[];
  queues: RetargetQueue[];
  recounting: boolean;
  onRedo: (ruleId: string, title: string) => void;
  redoBusy: string;
  redoIds: ReadonlySet<string>;
  redoStamps: Record<string, number>;
  roundStartedSec: number | null;
  schemes: TaxonomySchemeDef[];
  nodesByScheme: Record<string, TaxonomyNode[]>;
  onChange: (next: MatrixState) => void;
}) {
  const { rows, robots, colRanks } = state;
  const [draft, setDraft] = useState<TaxonomyPick[]>([]);
  const [dragCol, setDragCol] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<number | null>(null);
  const [dragRow, setDragRow] = useState<number | null>(null);
  const [overRow, setOverRow] = useState<number | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const autoMap = computeAutoCellRanks(rows, robots, colRanks);
  const savedAutoMap = computeAutoCellRanks(savedState.rows, savedState.robots, savedState.colRanks);
  const savedRowsByKey = new Map(savedState.rows.map((row) => [row.key, row]));

  const cellProgressMap = new Map<string, CellProgressEntry>();
  {
    const queueByKey = new Map(queues.map((q) => [q.key, q]));
    const runnableRules = savedRules.filter((r) => (r.rank ?? 1) !== SKIP_RANK);
    runnableRules.forEach((rule, idx) => {
      if (!rule.enabled) return;
      const earlier = new Set(runnableRules.slice(0, idx).flatMap((item) => (item.enabled ? item.robots : [])));
      const title = ruleTitle(rule, earlier, savedRules);
      const tierLabel = `第 ${rule.rank || idx + 1} 档`;
      const queue = queueByKey.get(rule.id);
      for (const scope of ruleScopes(rule)) {
        for (const robot of rule.robots) {
          const mapKey = `${scope.key}::${robot}`;
          if (!cellProgressMap.has(mapKey)) {
            cellProgressMap.set(mapKey, { rule, queue, title, tierLabel });
          }
        }
      }
    });
  }

  const setCellOverride = (rowKey: string, robot: string, value: number) => {
    onChange({
      ...state,
      rows: rows.map((row) =>
        row.key === rowKey
          ? { ...row, overrides: { ...row.overrides, [robot]: value } }
          : row,
      ),
    });
  };

  const clearCellOverride = (rowKey: string, robot: string) => {
    onChange({
      ...state,
      rows: rows.map((row) => {
        if (row.key !== rowKey) return row;
        const nextOverrides = { ...row.overrides };
        delete nextOverrides[robot];
        return { ...row, overrides: nextOverrides };
      }),
    });
  };

  const setRowPriority = (rowKey: string, value: number) => {
    onChange({
      ...state,
      rows: rows.map((row) =>
        row.key === rowKey
          ? { ...row, rowRank: value, overrides: {} }
          : row,
      ),
    });
  };

  const resetRowPriority = (rowIndex: number, rowKey: string) => {
    const fallback = rowIndex + 1;
    setRowPriority(rowKey, fallback);
  };

  const setColPriority = (robot: string, value: number) => {
    const nextColRanks = { ...colRanks, [robot]: value };
    const nextRows = rows.map((row) => {
      if (!(robot in row.overrides)) return row;
      const nextOverrides = { ...row.overrides };
      delete nextOverrides[robot];
      return { ...row, overrides: nextOverrides };
    });
    onChange({
      ...state,
      colRanks: nextColRanks,
      rows: nextRows,
    });
  };

  const resetColPriority = (colIndex: number, robot: string) => {
    setColPriority(robot, colIndex + 1);
  };

  const reorderRows = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return;
    const moved = moveItem(rows, from, to);
    const sortedPos = moved
      .map((r) => r.rowRank)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    let posCursor = 0;
    const nextRows = moved.map((r) =>
      r.rowRank === SKIP_RANK
        ? r
        : { ...r, rowRank: sortedPos[posCursor++] ?? posCursor },
    );
    onChange({ ...state, rows: nextRows });
  };

  const reorderCols = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= robots.length || to >= robots.length) return;
    const movedRobots = moveItem(robots, from, to);
    const sortedPos = movedRobots
      .map((r) => colRanks[r] ?? SKIP_RANK)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    let posCursor = 0;
    const nextColRanks: Record<string, number> = {};
    for (const r of movedRobots) {
      const prev = colRanks[r] ?? SKIP_RANK;
      nextColRanks[r] = prev === SKIP_RANK ? SKIP_RANK : (sortedPos[posCursor++] ?? posCursor);
    }
    onChange({ ...state, robots: movedRobots, colRanks: nextColRanks });
  };

  const resetAllOverrides = () => {
    onChange({
      ...state,
      rows: rows.map((row) => ({ ...row, overrides: {} })),
    });
  };

  const compactPositiveCells = () => {
    const allPositive: number[] = [];
    for (const row of rows) {
      for (const robot of robots) {
        const val = effectiveCellRank(row, robot, autoMap);
        if (val > 0) allPositive.push(val);
      }
    }
    const distinctSorted = [...new Set(allPositive)].sort((a, b) => a - b);
    const remap = new Map(distinctSorted.map((val, idx) => [val, idx + 1]));
    const nextRows = rows.map((row) => {
      const nextOverrides: Record<string, number> = {};
      for (const [rk, rv] of Object.entries(row.overrides)) {
        nextOverrides[rk] = rv > 0 ? (remap.get(rv) ?? rv) : rv;
      }
      return { ...row, overrides: nextOverrides, ids: { ...row.ids } };
    });
    onChange({ ...state, rows: nextRows });
  };

  const removeRow = (rowKey: string) => {
    const remaining = rows.filter((item) => item.key !== rowKey);
    const posRanks = [...new Set(remaining.map((r) => r.rowRank).filter((v) => v > 0))].sort((a, b) => a - b);
    const remap = new Map(posRanks.map((val, idx) => [val, idx + 1]));
    onChange({
      ...state,
      rows: remaining.map((r) =>
        r.rowRank > 0 ? { ...r, rowRank: remap.get(r.rowRank) ?? r.rowRank } : r,
      ),
    });
  };

  const addDraft = () => {
    const have = new Set(rows.map((row) => row.key));
    const fresh = draft
      .map((pick) => blankRow("taxonomy", [{ ...pick }]))
      .filter((row) => !have.has(row.key));
    if (fresh.length) {
      const restIdx = rows.findIndex((r) => r.key === REST_KEY);
      let nextRows: MatrixRow[];
      if (restIdx >= 0) {
        const beforeRest = rows.slice(0, restIdx);
        const fromRest = rows.slice(restIdx);
        const baseRank = beforeRest.reduce((m, r) => (r.rowRank > m ? r.rowRank : m), 0);
        const inserted = fresh.map((r, i) => ({ ...r, rowRank: baseRank + i + 1 }));
        const shiftedRest = fromRest.map((r) =>
          r.rowRank > 0 ? { ...r, rowRank: Math.min(MAX_RANK, r.rowRank + inserted.length) } : r,
        );
        nextRows = [...beforeRest, ...inserted, ...shiftedRest];
      } else {
        const baseRank = rows.reduce((m, r) => (r.rowRank > m ? r.rowRank : m), 0);
        nextRows = [...rows, ...fresh.map((r, i) => ({ ...r, rowRank: baseRank + i + 1 }))];
      }
      onChange({ ...state, rows: nextRows });
    }
    setDraft([]);
  };

  const onKeyNav = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === "ArrowUp") {
      const step = event.key === "ArrowUp" ? -1 : 1;
      const nextRow = Number(input.dataset.row) + step;
      const target = tableRef.current?.querySelector<HTMLInputElement>(
        `input[data-row="${nextRow}"][data-col="${input.dataset.col}"]`,
      );
      if (!target) return;
      event.preventDefault();
      target.focus();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const colStr = input.dataset.col ?? "";
      if (colStr === "row-rank" && event.key === "ArrowRight") {
        const selAll = input.selectionStart === 0 && input.selectionEnd === input.value.length;
        const atEnd = input.selectionStart === input.value.length;
        if (!selAll && !atEnd) return;
        const target = tableRef.current?.querySelector<HTMLInputElement>(
          `input[data-row="${input.dataset.row}"][data-col="0"]`,
        );
        if (target) {
          event.preventDefault();
          target.focus();
        }
        return;
      }
      const colNum = Number(colStr);
      if (!Number.isFinite(colNum)) return;
      const selAll = input.selectionStart === 0 && input.selectionEnd === input.value.length;
      if (!selAll) {
        if (event.key === "ArrowLeft" && input.selectionStart !== 0) return;
        if (event.key === "ArrowRight" && input.selectionStart !== input.value.length) return;
      }
      const nextCol = colNum + (event.key === "ArrowRight" ? 1 : -1);
      const nextColAttr = nextCol < 0 ? "row-rank" : String(nextCol);
      const target = tableRef.current?.querySelector<HTMLInputElement>(
        `input[data-row="${input.dataset.row}"][data-col="${nextColAttr}"]`,
      );
      if (target) {
        event.preventDefault();
        target.focus();
      }
    }
  };

  const hasOverrides = rows.some((row) => Object.keys(row.overrides).length > 0);
  const allPositiveCells: number[] = [];
  for (const row of rows) {
    for (const robot of robots) {
      const v = effectiveCellRank(row, robot, autoMap);
      if (v > 0) allPositiveCells.push(v);
    }
  }
  const distinctPositive = new Set(allPositiveCells);
  const canCompact =
    hasOverrides &&
    distinctPositive.size > 0 &&
    Math.max(...allPositiveCells) !== distinctPositive.size;

  return (
    <div className="retarget-matrix-box">
      <div className="retarget-matrix-wrap">
        <table className="retarget-matrix" ref={tableRef}>
          <thead>
            <tr>
              <th className="retarget-matrix-node">
                <div>数据节点（纵轴）</div>
                <div className="muted" style={{ fontWeight: 400, fontSize: "0.75rem" }}>
                  可拖拽或点 ↑ ↓ 调整节点顺序
                </div>
              </th>
              <th className="retarget-matrix-all">
                <div>节点优先级</div>
                <div className="muted" style={{ fontWeight: 400, fontSize: "0.75rem" }}>
                  纵轴 (-1 不做)
                </div>
              </th>
              {robots.map((robot, col) => {
                const cRank = colRanks[robot] ?? SKIP_RANK;
                const colMoved = savedState.robots.indexOf(robot) !== col;
                const isDropTarget = dragCol !== null && overCol === col && dragCol !== col;
                return (
                  <th
                    key={robot}
                    title={`${robot}（可左右拖拽或点击箭头调整横轴顺序）`}
                    className={`retarget-col-th${cRank === SKIP_RANK ? " is-col-skip" : ""}${colMoved ? " is-order-changed" : ""}${isDropTarget ? " is-drag-over" : ""}`}
                    onDragOver={(event) => {
                      if (dragCol === null) return;
                      event.preventDefault();
                      if (overCol !== col) setOverCol(col);
                    }}
                    onDrop={(event) => {
                      if (dragCol === null) return;
                      event.preventDefault();
                      reorderCols(dragCol, col);
                      setDragCol(null);
                      setOverCol(null);
                    }}
                  >
                    <div className="retarget-col-head">
                      <div className="retarget-axis-controls">
                        <button
                          type="button"
                          className="retarget-move-btn"
                          disabled={col === 0}
                          title="向左移动此机器人列"
                          aria-label={`${robot} 左移`}
                          onClick={() => reorderCols(col, col - 1)}
                        >
                          ‹
                        </button>
                        <span
                          className="retarget-drag-handle"
                          draggable
                          title="按住左右拖拽此列顺序"
                          onDragStart={(event) => {
                            setDragCol(col);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", `col:${col}`);
                          }}
                          onDragEnd={() => {
                            setDragCol(null);
                            setOverCol(null);
                          }}
                        >
                          ⋮⋮
                        </span>
                        <button
                          type="button"
                          className="retarget-move-btn"
                          disabled={col === robots.length - 1}
                          title="向右移动此机器人列"
                          aria-label={`${robot} 右移`}
                          onClick={() => reorderCols(col, col + 1)}
                        >
                          ›
                        </button>
                      </div>
                      <div className="retarget-col-title">{robot}</div>
                    </div>
                  </th>
                );
              })}
              <th className="retarget-matrix-op">操作</th>
            </tr>
            <tr className="retarget-matrix-fill">
              <th className="retarget-matrix-node">
                <div>机器人优先级（横轴）</div>
                <div className="muted" style={{ fontWeight: 400, fontSize: "0.75rem" }}>
                  同一节点内数字小的先做，填 -1 整列不执行
                </div>
              </th>
              <th className="retarget-matrix-all">
                <button
                  type="button"
                  className="secondary retarget-mini"
                  disabled={!hasOverrides}
                  title="清除所有单元格的手动修改，按数据节点优先级与机器人优先级重新生成默认序号"
                  onClick={resetAllOverrides}
                >
                  重置默认
                </button>
              </th>
              {robots.map((robot, col) => {
                const cRank = colRanks[robot] ?? SKIP_RANK;
                const savedCRank = savedState.colRanks[robot] ?? SKIP_RANK;
                const changed = cRank !== savedCRank;
                return (
                  <th key={robot} className={cRank === SKIP_RANK ? "is-col-skip" : undefined}>
                    <RankInput
                      value={cRank}
                      className={`retarget-cell is-axis${cRank === SKIP_RANK ? " is-skip" : " is-axis-active"}${changed ? " is-changed" : ""}`}
                      ariaLabel={`${robot} 机器人优先级`}
                      title={
                        cRank === SKIP_RANK
                          ? `${robot} 横轴优先级：-1（整列默认不执行）`
                          : `${robot} 横轴优先级：${cRank}（修改后将自动更新该列未锁定的格子）`
                      }
                      dataRow={-1}
                      dataCol={col}
                      onKeyNav={onKeyNav}
                      onCommit={(val) => setColPriority(robot, val)}
                      onClear={() => resetColPriority(col, robot)}
                    />
                  </th>
                );
              })}
              <th className="retarget-matrix-op" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const label = rowLabel(row, schemes);
              const before = savedRowsByKey.get(row.key);
              const rowMoved = before != null && savedState.rows.findIndex((r) => r.key === row.key) !== index;
              const rowRankChanged = before ? before.rowRank !== row.rowRank : true;
              const isRowSkip = row.rowRank === SKIP_RANK;
              const isDropTarget = dragRow !== null && overRow === index && dragRow !== index;
              return (
                <tr
                  key={row.key}
                  className={`${before ? "" : "is-new "}${isRowSkip ? "is-row-skip " : ""}${isDropTarget ? "is-drag-over-row" : ""}`.trim() || undefined}
                  onDragOver={(event) => {
                    if (dragRow === null) return;
                    event.preventDefault();
                    if (overRow !== index) setOverRow(index);
                  }}
                  onDrop={(event) => {
                    if (dragRow === null) return;
                    event.preventDefault();
                    reorderRows(dragRow, index);
                    setDragRow(null);
                    setOverRow(null);
                  }}
                >
                  <th
                    className={`retarget-matrix-node${rowMoved ? " is-order-changed" : ""}`}
                    scope="row"
                    title={label.title}
                  >
                    <div className="retarget-row-head">
                      <div className="retarget-row-controls">
                        <span
                          className="retarget-drag-handle"
                          draggable
                          title="按住上下拖拽此行顺序"
                          onDragStart={(event) => {
                            setDragRow(index);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", `row:${index}`);
                          }}
                          onDragEnd={() => {
                            setDragRow(null);
                            setOverRow(null);
                          }}
                        >
                          ⋮⋮
                        </span>
                        <div className="retarget-row-arrows">
                          <button
                            type="button"
                            className="retarget-move-btn"
                            disabled={index === 0}
                            title="上移此数据节点"
                            aria-label={`${label.title} 上移`}
                            onClick={() => reorderRows(index, index - 1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="retarget-move-btn"
                            disabled={index === rows.length - 1}
                            title="下移此数据节点"
                            aria-label={`${label.title} 下移`}
                            onClick={() => reorderRows(index, index + 1)}
                          >
                            ↓
                          </button>
                        </div>
                      </div>
                      <div className="retarget-row-label">
                        <div>
                          {label.title}
                          {isRowSkip ? <span className="retarget-skip-tag">不执行</span> : null}
                        </div>
                        <div className="muted">{before ? label.note : `${label.note} · 新加`}</div>
                      </div>
                    </div>
                  </th>
                  <td className="retarget-matrix-all">
                    <RankInput
                      value={row.rowRank}
                      className={`retarget-cell is-axis${isRowSkip ? " is-skip" : " is-axis-active"}${rowRankChanged ? " is-changed" : ""}`}
                      ariaLabel={`${label.title} 数据节点优先级`}
                      title={
                        isRowSkip
                          ? `${label.title} 节点优先级：-1（整行默认不执行）`
                          : `${label.title} 节点优先级：${row.rowRank}（修改后将重算该行格子）`
                      }
                      dataRow={index}
                      dataCol="row-rank"
                      onKeyNav={onKeyNav}
                      onCommit={(val) => setRowPriority(row.key, val)}
                      onClear={() => resetRowPriority(index, row.key)}
                    />
                  </td>
                  {robots.map((robot, col) => {
                    const autoVal = autoMap[row.key]?.[robot] ?? SKIP_RANK;
                    const value = effectiveCellRank(row, robot, autoMap);
                    const isOverride = row.overrides[robot] !== undefined;
                    const savedVal = before ? effectiveCellRank(before, robot, savedAutoMap) : null;
                    const changed = savedVal === null || savedVal !== value;
                    const isCellSkip = value === SKIP_RANK;
                    if (isCellSkip) {
                      const skipTitle = isOverride
                        ? `实际执行优先级：-1（不执行） · 用户手动指定（自动默认值为 ${autoVal}，清空此格可恢复默认）`
                        : "实际执行优先级：-1（不执行） · 按行列优先级自动计算";
                      return (
                        <td key={robot} className="is-cell-skip-td">
                          <div className={`retarget-cell-wrap${isOverride ? " has-override" : ""}`}>
                            <RankInput
                              value={value}
                              className={`retarget-cell is-skip${isOverride ? " is-override" : ""}${changed ? " is-changed" : ""}`}
                              ariaLabel={`${label.title} · ${robot} 实际执行优先级`}
                              title={skipTitle}
                              dataRow={index}
                              dataCol={col}
                              onKeyNav={onKeyNav}
                              onCommit={(val) => setCellOverride(row.key, robot, val)}
                              onClear={() => clearCellOverride(row.key, robot)}
                            />
                          </div>
                        </td>
                      );
                    }

                    const prog = cellProgressMap.get(`${row.key}::${robot}`);
                    const ruleId = prog?.rule.id;
                    const rawQueue = prog?.queue;
                    const redoPending = ruleId ? redoIds.has(ruleId) : false;
                    const redoStamp = ruleId ? redoStamps[ruleId] : undefined;
                    const waitingRescan = Boolean(
                      rawQueue?.redo_waiting_rescan ||
                        (redoStamp != null && (roundStartedSec == null || redoStamp > roundStartedSec)) ||
                        (redoPending && (!rawQueue || rawQueue.total === 0)),
                    );
                    const displayQueue: RetargetQueue | undefined = rawQueue
                      ? waitingRescan
                        ? { ...rawQueue, done: 0, failed: 0, remaining: rawQueue.total, active: false }
                        : rawQueue
                      : undefined;
                    const donePercent =
                      !waitingRescan && displayQueue && displayQueue.total > 0
                        ? Math.min(100, (displayQueue.done / displayQueue.total) * 100)
                        : 0;
                    const failedPercent =
                      !waitingRescan && displayQueue && displayQueue.total > 0
                        ? Math.min(100 - donePercent, (displayQueue.failed / displayQueue.total) * 100)
                        : 0;
                    const isComplete =
                      !waitingRescan &&
                      !!displayQueue &&
                      displayQueue.total > 0 &&
                      displayQueue.done >= displayQueue.total &&
                      displayQueue.failed === 0;
                    const isActive = Boolean(displayQueue?.active);
                    const busy = Boolean(ruleId && redoBusy === ruleId);

                    const rankNote = isOverride
                      ? `执行序号：${value}（手动指定，默认值为 ${autoVal}，清空可恢复默认）`
                      : `执行序号：${value}（按行列优先级自动计算）`;
                    const titleLines: string[] = [];
                    if (prog) {
                      titleLines.push(`${prog.tierLabel}${isActive ? " · 当前正在执行" : ""} · ${prog.title}`);
                    } else {
                      titleLines.push(`${label.title} · ${robot}（待保存优先级）`);
                    }
                    if (displayQueue) {
                      titleLines.push(
                        `进度：已完成 ${displayQueue.done} / 共 ${displayQueue.total}${displayQueue.failed ? `，失败 ${displayQueue.failed}` : ""}（${Math.round(donePercent)}%）`,
                      );
                      titleLines.push(waitingRescan ? REDO_PENDING : queueTimeText(displayQueue));
                    } else if (prog) {
                      titleLines.push(waitingRescan ? REDO_PENDING : "正在等待扫描统计条数…");
                    }
                    titleLines.push(rankNote);
                    const cardTitle = titleLines.join("\n");

                    const cardCls = [
                      "retarget-cell-card",
                      isComplete ? "is-complete" : "",
                      isActive ? "is-active-tier" : "",
                      waitingRescan ? "is-waiting-redo" : "",
                      isOverride ? "has-override" : "",
                      changed ? "is-changed" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");

                    return (
                      <td key={robot} className="is-cell-active-td">
                        <div
                          className={cardCls}
                          title={cardTitle}
                          onClick={(event) => {
                            const target = event.target as HTMLElement;
                            if (target.closest("button") || target.closest("input")) return;
                            const input = event.currentTarget.querySelector("input");
                            input?.focus();
                          }}
                        >
                          {donePercent > 0 ? (
                            <span
                              className={`retarget-cell-fill-done${donePercent < 99.9 ? " is-partial" : ""}`}
                              style={{ width: `${donePercent}%` }}
                            />
                          ) : null}
                          {failedPercent > 0 ? (
                            <span
                              className="retarget-cell-fill-failed"
                              style={{ left: `${donePercent}%`, width: `${failedPercent}%` }}
                            />
                          ) : null}
                          <div className="retarget-cell-top">
                            <RankInput
                              value={value}
                              className={`retarget-cell is-in-card${isOverride ? " is-override" : ""}`}
                              ariaLabel={`${label.title} · ${robot} 实际执行优先级`}
                              title={cardTitle}
                              dataRow={index}
                              dataCol={col}
                              onKeyNav={onKeyNav}
                              onCommit={(val) => setCellOverride(row.key, robot, val)}
                              onClear={() => clearCellOverride(row.key, robot)}
                            />
                            <button
                              type="button"
                              className={`retarget-cell-redo${waitingRescan ? " is-pending" : ""}`}
                              disabled={!prog || !!redoBusy}
                              aria-label={`${label.title} · ${robot} 本级全部重做`}
                              title={
                                !prog
                                  ? "保存优先级后可执行本级全部重做"
                                  : waitingRescan
                                    ? `已安排全部重做：${prog.title}（等当前波结束后重扫执行）`
                                    : `本级全部重做：${prog.title}`
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                if (prog) onRedo(prog.rule.id, prog.title);
                              }}
                            >
                              <RedoArrowIcon spinning={busy} />
                            </button>
                          </div>
                          <div className="retarget-cell-meta">
                            {!prog ? (
                              <span className="retarget-cell-frac is-muted">待保存</span>
                            ) : !displayQueue ? (
                              <span className="retarget-cell-frac is-muted">
                                {waitingRescan ? "0/… 待重做" : recounting ? "统计中…" : "待统计"}
                              </span>
                            ) : (
                              <span className="retarget-cell-frac">
                                {isActive ? <span className="retarget-active-dot" aria-hidden="true" /> : null}
                                {displayQueue.done}/{displayQueue.total}
                                {!waitingRescan && displayQueue.failed > 0 ? (
                                  <span className="retarget-cell-fail">·败{displayQueue.failed}</span>
                                ) : waitingRescan ? (
                                  <span className="retarget-cell-pending-tag">·待重扫</span>
                                ) : null}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                    );
                  })}
                  <td className="retarget-matrix-op">
                    {row.kind === "rest" ? null : (
                      <button
                        type="button"
                        className="secondary retarget-mini"
                        onClick={() => removeRow(row.key)}
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
        <button
          type="button"
          className="secondary retarget-mini"
          disabled={!hasOverrides}
          title="清除所有单格手动修改，全部恢复为「先完成当前数据节点、再按机器人优先级」的默认序号"
          onClick={resetAllOverrides}
        >
          按行列优先级重算全部格子
        </button>
        {canCompact ? (
          <button type="button" className="secondary retarget-mini" onClick={compactPositiveCells}>
            压缩正数序号 1、2、3…
          </button>
        ) : null}
      </div>
    </div>
  );
}

const EMPTY_MATRIX: MatrixState = { robots: [], colRanks: {}, rows: [] };

export function RetargetManagePage() {
  const { isAdmin } = useAuth();
  const adoptRules = (cfg: RetargetPriority) => {
    const nextState = rulesToMatrixState(cfg.rules || [], cfg.robots || [], cfg.layout);
    setMatrixState(nextState);
    setSavedMatrixState(cloneState(nextState));
    setSavedRules(cloneRules(cfg.rules || []));
    setCatalogRobots(cfg.robots || []);
    setPresets(cfg.presets || []);
    setPins(cfg.pins || []);
    if (cfg.redo) setRedoIds(cfg.redo);
    if (cfg.redo_stamps) setRedoStamps(cfg.redo_stamps);
  };
  const [data, setData] = useState<RetargetStatus | null>(null);
  const [error, setError] = useState("");
  const [matrixState, setMatrixState] = useState<MatrixState>(EMPTY_MATRIX);
  const [savedMatrixState, setSavedMatrixState] = useState<MatrixState>(EMPTY_MATRIX);
  const [savedRules, setSavedRules] = useState<PriorityRule[]>([]);
  const [catalogRobots, setCatalogRobots] = useState<string[]>([]);
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
  const [redoStamps, setRedoStamps] = useState<Record<string, number>>({});
  const stateRef = useRef(matrixState);
  const savedRef = useRef(savedMatrixState);
  const savingRef = useRef(false);
  const loadingSchemes = useRef(new Set<string>());
  stateRef.current = matrixState;
  savedRef.current = savedMatrixState;
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
      setRedoStamps(cfg.redo_stamps || {});
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
      const untouched = JSON.stringify(stateRef.current) === JSON.stringify(savedRef.current);
      if (!savingRef.current && untouched) {
        api
          .retargetPriority()
          .then((cfg) => {
            if (!alive || savingRef.current) return;
            if (JSON.stringify(stateRef.current) !== JSON.stringify(savedRef.current)) return;
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
        const stamp =
          typeof result.requested_at === "number" && Number.isFinite(result.requested_at)
            ? result.requested_at
            : Date.now() / 1000;
        setPriorityNote(result.message);
        setRedoIds((prev) => (prev.includes(ruleId) ? prev : [...prev, ruleId]));
        setRedoStamps((prev) => ({ ...prev, [ruleId]: stamp }));
        setData((prev) => {
          if (!prev || !prev.queues) return prev;
          const paceSec = prev.seconds_per_job || 0;
          let ahead = 0;
          const nextQueues = prev.queues.map((q) => {
            const base =
              q.key === ruleId
                ? { ...q, done: 0, failed: 0, remaining: q.total, redo_waiting_rescan: true }
                : { ...q };
            const rem = Math.max(0, base.total - base.done - (base.failed || 0));
            base.remaining = rem;
            if (paceSec > 0) {
              base.eta_seconds = Math.round(rem * paceSec);
              base.eta_after_seconds = Math.round((ahead + rem) * paceSec);
            }
            ahead += rem;
            return base;
          });
          return { ...prev, queues: nextQueues };
        });
        api
          .retargetStatus()
          .then((next) => setData(next))
          .catch(() => undefined);
      })
      .catch((err: Error) => {
        setPriorityError(err.message || "安排重做失败");
      })
      .finally(() => setRedoBusy(""));
  };

  const facetSchemes = [FOLDER_SCHEME, ...schemes];
  const dirty = JSON.stringify(matrixState) !== JSON.stringify(savedMatrixState);
  const savedSignature = matrixSignature(savedMatrixState);

  /** 表格换成要保存的规则与布局元数据。填得不对时返回 null，并在页面上说明原因。 */
  const payloadFromTable = () => {
    const nextRules = matrixToRules(matrixState);
    if (!nextRules.length) {
      setPriorityError("表格里没有可保存的数据节点或机器人规则");
      return null;
    }
    if (nextRules.length > MAX_TIERS) {
      setPriorityError(`规则总档数过多，请控制在 ${MAX_TIERS} 档以内。`);
      return null;
    }
    return { rules: nextRules, layout: stateToLayout(matrixState) };
  };

  const saveRules = () => {
    const next = payloadFromTable();
    if (!next) return;
    setSaving(true);
    savingRef.current = true;
    setPriorityError("");
    api
      .saveRetargetPriority(next.rules, next.layout)
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
    const next = payloadFromTable();
    if (!next) return;
    setSaving(true);
    savingRef.current = true;
    setPriorityError("");
    api
      .saveRetargetPreset(name, next.rules, next.layout)
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
        <h2>优先级与进度</h2>
        <p className="muted" style={{ margin: 0 }}>
          横轴可设置各机器人实例的优先级并左右调整顺序，纵轴可设置各数据节点的优先级并上下调整顺序；行、列或格子填为 <strong>-1</strong> 时<strong>不执行重定向</strong>。每个正数单元格直接用<strong>绿色涂色面积表示完成百分比</strong>、下方分数 <strong>已完成/总条数</strong> 表示进度，点击格子右上角 <strong>↺</strong> 小按钮即可执行<strong>本级全部重做</strong>（进度从 0 重算，新 CSV 写好后覆盖原文件）；鼠标悬停在格子上可查看该档预计剩余时间。支持方向键与回车在表格内快速移动。
        </p>
        {data?.phase === "scanning" ? (
          <p className="muted" style={{ margin: 0 }}>
            正在重新扫描统计各格数量，表格中暂显示上一轮统计结果…
          </p>
        ) : null}
        {priorityError ? <div className="error">{priorityError}</div> : null}
        {priorityNote ? <div className="muted">{priorityNote}</div> : null}
        <PriorityMatrix
          state={matrixState}
          savedState={savedMatrixState}
          savedRules={savedRules}
          queues={queues}
          recounting={data?.phase === "scanning"}
          onRedo={redoTier}
          redoBusy={redoBusy}
          redoIds={new Set(redoIds)}
          redoStamps={redoStamps}
          roundStartedSec={parseEpochSec(data?.round_started_at)}
          schemes={facetSchemes}
          nodesByScheme={nodesByScheme}
          onChange={(next) => {
            setMatrixState(next);
            setPriorityNote("");
            setPriorityError("");
          }}
        />
        {(() => {
          const unlisted = queues.find((q) => q.key === "unlisted" && q.total > 0);
          return unlisted ? (
            <ol className="retarget-queues">
              <QueueProgress
                queue={unlisted}
                title={unlisted.title}
                rank={rankLabel(unlisted.rank)}
                onRedo={redoTier}
                redoBusy={redoBusy}
                redoPending={redoIds.includes(unlisted.key)}
                redoStamp={redoStamps[unlisted.key]}
                roundStartedSec={parseEpochSec(data?.round_started_at)}
              />
            </ol>
          ) : null;
        })()}
        <div className="row">
          <button type="button" disabled={!dirty || saving} onClick={saveRules}>
            {saving ? "正在保存" : "保存优先级"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!dirty || saving}
            onClick={() => {
              setMatrixState(cloneState(savedMatrixState));
              setPriorityNote("");
              setPriorityError("");
            }}
          >
            放弃修改
          </button>
          {dirty ? <span className="muted">有改动还没保存，改过的格子或行列带蓝色边框提示。</span> : null}
        </div>
        <div className="retarget-preset-box">
          <strong>预设</strong>
          <p className="muted" style={{ margin: 0 }}>
            填好上面的表格后，填一个新名称，就能把当前优先级（包含横纵轴顺序、行列优先级与单元格设置）新增成一套预设。点预设名称会换成那一套，当前这一波结束后重新扫描。删除预设不会改正在执行的优先级。
          </p>
          <div className="retarget-presets">
            {presets.map((preset) => {
              const active =
                matrixSignature(rulesToMatrixState(preset.rules, catalogRobots, preset.layout)) === savedSignature;
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
          将某行、某列或某个格子填为 -1 时，对应的机器人或数据节点将跳过重定向（不会排到最后兜底执行）。同一个执行序号内，按从上到下的行顺序、从左到右的机器人列顺序依次执行，开源数据和其他数据集稍晚一些，小批次先做。
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
