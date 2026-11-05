import { useState } from "react";

/** 数据里「上」是哪个轴 */
export type UpAxis = "y" | "z" | "-y" | "-z";
/** 界面选择：自动识别或手动指定 */
export type UpAxisMode = "auto" | "y" | "z";

export function useUpAxisMode(): [UpAxisMode, (m: UpAxisMode) => void] {
  const [mode, setMode] = useState<UpAxisMode>("auto");
  return [mode, setMode];
}

/** 把数据的「上」轴转成视图 Y-up 所需的绕 X 轴旋转。 */
export function upAxisToRotationX(up: UpAxis): number {
  if (up === "z") return -Math.PI / 2;
  if (up === "-z") return Math.PI / 2;
  if (up === "-y") return Math.PI;
  return 0;
}

export function resolveUpAxis(mode: UpAxisMode, detected: UpAxis): UpAxis {
  return mode === "auto" ? detected : mode;
}

type Yz = { y: number; z: number };
const UP_CANDIDATES: UpAxis[] = ["y", "-y", "z", "-z"];

function heightOn(point: Yz, up: UpAxis): number {
  if (up === "y") return point.y;
  if (up === "-y") return -point.y;
  if (up === "z") return point.z;
  return -point.z;
}

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[index];
}

function sortedHeights(points: readonly Yz[], up: UpAxis): number[] {
  const heights: number[] = [];
  for (const point of points) {
    const h = heightOn(point, up);
    if (Number.isFinite(h)) heights.push(h);
  }
  heights.sort((a, b) => a - b);
  return heights;
}

/**
 * 这一帧有多少比例的点跑到地面以下，以及脚底、头顶的高度。
 * 身高用主体而不是最远的那个点，避免一块远处刚体把容差放得过大。
 * 低于身高约 8% 的接触算贴地。穿模值越大，跑到地下的越多。
 */
function framePoseMeasure(points: readonly Yz[], up: UpAxis): { pen: number; span: number; low: number; high: number } | null {
  const heights = sortedHeights(points, up);
  if (heights.length < 3) return null;
  const low = quantile(heights, 0.05);
  const high = quantile(heights, 0.95);
  const span = high - low;
  if (span < 1e-8) return null;
  const floor = -span * 0.08;
  let below = 0;
  for (const h of heights) if (h < floor) below += 1;
  const ratio = below / heights.length;
  const tail = Math.max(0, -quantile(heights, 0.1)) / span;
  return { pen: ratio * 0.55 + Math.min(1, tail) * 0.45, span, low, high };
}

function deviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / values.length;
  let acc = 0;
  for (const value of values) {
    const delta = value - mean;
    acc += delta * delta;
  }
  return Math.sqrt(acc / values.length);
}

/**
 * 越低越像真实的竖直方向。
 * 穿地少只是一项。还要求脚底高度在整段动作里几乎不动，
 * 头顶可以起伏（起立、行走）；横轴上两端会一起大幅来回移动。
 */
function orientationCost(pen: number, maxSpan: number, lows: readonly number[], highs: readonly number[]): number {
  const span = Math.max(maxSpan, 1e-8);
  const floorJitter = deviation(lows) / span;
  const headTravel = deviation(highs) / span;
  const sliding = Math.max(0, floorJitter - headTravel * 0.5);
  return pen * 2 + floorJitter * 3 + sliding;
}

/**
 * 用各帧骨架、刚体、marker 判断哪个坐标轴朝上。
 * 先丢掉大量穿地的朝向，再比较动作是否合理：
 * 脚底应贴着不动的地面，头顶可以升高或降低。
 * 躺下再站起时，身体长轴的平均长度会超过身高，不能只比哪根轴更长。
 */
export function detectUpAxisFromPointFrames(frames: readonly (readonly Yz[])[]): UpAxis {
  const pen = { y: 0, "-y": 0, z: 0, "-z": 0 };
  const used = { y: 0, "-y": 0, z: 0, "-z": 0 };
  const maxSpan = { y: 0, "-y": 0, z: 0, "-z": 0 };
  const lows: Record<UpAxis, number[]> = { y: [], "-y": [], z: [], "-z": [] };
  const highs: Record<UpAxis, number[]> = { y: [], "-y": [], z: [], "-z": [] };
  let measuredFrames = 0;
  for (const frame of frames) {
    if (frame.length < 3) continue;
    let measured = false;
    for (const up of UP_CANDIDATES) {
      const score = framePoseMeasure(frame, up);
      if (score == null) continue;
      pen[up] += score.pen;
      used[up] += 1;
      if (score.span > maxSpan[up]) maxSpan[up] = score.span;
      lows[up].push(score.low);
      highs[up].push(score.high);
      measured = true;
    }
    if (measured) measuredFrames += 1;
  }
  if (!measuredFrames) return "y";
  const ranked = UP_CANDIDATES.map((up) => {
    const averagePen = used[up] ? pen[up] / used[up] : 1;
    return {
      up,
      span: maxSpan[up],
      cost: orientationCost(averagePen, maxSpan[up], lows[up], highs[up]),
    };
  }).sort((a, b) => a.cost - b.cost || b.span - a.span);
  const best = ranked[0];
  const next = ranked[1];
  if (next && next.cost - best.cost < 0.08 && next.span > best.span * 1.15) return next.up;
  return best.up;
}

/** 比较竖直方向在 Y / Z 上的伸展，判断数据更像 Y-up 还是 Z-up。 */
export function detectUpAxisFromExtents(
  spanY: number,
  spanZ: number,
  midY = 0,
  midZ = 0
): UpAxis {
  if (!Number.isFinite(spanY) || !Number.isFinite(spanZ)) return "y";
  const yUp: UpAxis = midY >= 0 ? "y" : "-y";
  const zUp: UpAxis = midZ >= 0 ? "z" : "-z";
  if (spanZ > spanY * 1.15) return zUp;
  if (spanY > spanZ * 1.15) return yUp;
  return "y";
}

export function detectUpAxisFromBox(box: {
  min: { y: number; z: number };
  max: { y: number; z: number };
  isEmpty?: () => boolean;
}): UpAxis {
  if (box.isEmpty?.()) return "y";
  const samples: Yz[] = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = box.min.y + ((box.max.y - box.min.y) * i) / steps;
    for (let j = 0; j <= steps; j++) {
      const z = box.min.z + ((box.max.z - box.min.z) * j) / steps;
      samples.push({ y, z });
    }
  }
  return detectUpAxisFromPointFrames([samples]);
}

/** 从按关节展开的 XYZ 帧里判断竖直轴（每 3 个数一个关节）。 */
export function detectUpAxisFromJointFrames(frames: number[][], sampleCount = 24): UpAxis {
  const n = Math.min(sampleCount, frames.length);
  const poses: Yz[][] = [];
  for (let i = 0; i < n; i++) {
    const vals = frames[Math.floor((i / Math.max(n - 1, 1)) * (frames.length - 1))] || [];
    const points: Yz[] = [];
    for (let j = 0; j + 2 < vals.length; j += 3) {
      const y = vals[j + 1];
      const z = vals[j + 2] ?? 0;
      if (Number.isFinite(y) && Number.isFinite(z)) points.push({ y, z });
    }
    if (points.length) poses.push(points);
  }
  if (!poses.length) return "y";
  return detectUpAxisFromPointFrames(poses);
}

export function upAxisModeLabel(mode: UpAxisMode, detected: UpAxis): string {
  const detectedName = detected === "z" || detected === "-z" ? "Z-up" : "Y-up";
  if (mode === "auto") return `坐标系·自动(${detectedName})`;
  return mode === "y" ? "坐标系·Y-up" : "坐标系·Z-up";
}

export function cycleUpAxisMode(mode: UpAxisMode): UpAxisMode {
  return mode === "auto" ? "y" : mode === "y" ? "z" : "auto";
}

export type LayoutPoint = { x: number; y: number; z: number };

/**
 * 地面偏移要在旋转到视图 Y-up 之后计算。
 * 数据是 Z-up 时，先绕 X 转 -90°，竖直方向才是原来的 Z；
 * 若仍用旋转前的最小 Y 当地面，脚会落在网格中间，身体大量穿地。
 */
export function uprightGroundOffset(
  points: readonly LayoutPoint[],
  roots: readonly LayoutPoint[],
  rotationX: number,
  scale: number,
): [number, number, number] {
  const c = Math.cos(rotationX);
  const s = Math.sin(rotationX);
  let minY = Infinity;
  for (const point of points) {
    const y = point.y * c - point.z * s;
    if (y < minY) minY = y;
  }
  if (!Number.isFinite(minY)) minY = 0;
  const anchors = roots.length ? roots : points;
  let sumX = 0;
  let sumZ = 0;
  let count = 0;
  for (const point of anchors) {
    sumX += point.x;
    sumZ += point.y * s + point.z * c;
    count += 1;
  }
  const meanX = count ? sumX / count : 0;
  const meanZ = count ? sumZ / count : 0;
  return [-meanX * scale, -minY * scale, -meanZ * scale];
}
