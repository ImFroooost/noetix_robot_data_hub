import { useEffect, useState } from "react";

/** 文件坐标的长度单位 */
export type LengthUnit = "m" | "cm" | "mm";
/** 界面选择：自动识别或手动指定 */
export type LengthUnitMode = "auto" | LengthUnit;

const UNIT_KEY = "hub-viewer-length-unit";

const UNIT_SCALE: Record<LengthUnit, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
};

const UNIT_NAME: Record<LengthUnit, string> = {
  m: "米",
  cm: "厘米",
  mm: "毫米",
};

export function useLengthUnitMode(): [LengthUnitMode, (m: LengthUnitMode) => void] {
  const [mode, setMode] = useState<LengthUnitMode>(() => {
    try {
      const saved = localStorage.getItem(UNIT_KEY);
      if (saved === "m" || saved === "cm" || saved === "mm" || saved === "auto") return saved;
    } catch {
      /* ignore */
    }
    return "auto";
  });
  useEffect(() => {
    try {
      localStorage.setItem(UNIT_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);
  return [mode, setMode];
}

export function lengthUnitToScale(unit: LengthUnit): number {
  return UNIT_SCALE[unit];
}

export function resolveLengthUnit(mode: LengthUnitMode, detected: LengthUnit): LengthUnit {
  return mode === "auto" ? detected : mode;
}

/** 把一段长度换算成米后，有多像人体身高。 */
function unitFitScore(extent: number, scale: number): number {
  const meters = extent * scale;
  if (meters >= 1.2 && meters <= 2.3) return 3;
  if (meters >= 0.6 && meters <= 3) return 2;
  if (meters >= 0.25 && meters <= 4.5) return 1;
  return 0;
}

/** 按人体身高判断这段尺寸更像米、厘米还是毫米。 */
export function detectLengthUnit(extent: number): LengthUnit {
  if (!Number.isFinite(extent) || extent <= 0) return "m";
  let best: LengthUnit = "m";
  let bestScore = -1;
  let bestDist = Infinity;
  (["m", "cm", "mm"] as LengthUnit[]).forEach((unit) => {
    const scale = UNIT_SCALE[unit];
    const score = unitFitScore(extent, scale);
    const dist = Math.abs(extent * scale - 1.7);
    if (score > bestScore || (score === bestScore && dist < bestDist)) {
      best = unit;
      bestScore = score;
      bestDist = dist;
    }
  });
  return best;
}

/** 骨架、网格各给一段尺寸，选更像人体的那套单位。 */
export function detectLengthUnitFromExtents(...extents: number[]): LengthUnit {
  const usable = extents.filter((item) => Number.isFinite(item) && item > 1e-8);
  if (!usable.length) return "m";
  let bestUnit: LengthUnit = "m";
  let bestScore = -1;
  let bestDist = Infinity;
  usable.forEach((extent) => {
    const unit = detectLengthUnit(extent);
    const scale = UNIT_SCALE[unit];
    const score = unitFitScore(extent, scale);
    const dist = Math.abs(extent * scale - 1.7);
    if (score > bestScore || (score === bestScore && dist < bestDist)) {
      bestUnit = unit;
      bestScore = score;
      bestDist = dist;
    }
  });
  return bestUnit;
}

export function lengthUnitModeLabel(mode: LengthUnitMode, detected: LengthUnit): string {
  const name = UNIT_NAME[mode === "auto" ? detected : mode];
  if (mode === "auto") return `尺度·自动(${name})`;
  return `尺度·${name}`;
}

export function cycleLengthUnitMode(mode: LengthUnitMode): LengthUnitMode {
  return mode === "auto" ? "m" : mode === "m" ? "cm" : mode === "cm" ? "mm" : "auto";
}
