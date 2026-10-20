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

/** 去掉两端离群的刚体、marker，只留身体主体的高度。 */
function robustSpan(sorted: readonly number[]): number {
  if (sorted.length < 3) return 0;
  const span = quantile(sorted, 0.95) - quantile(sorted, 0.05);
  if (span > 1e-8) return span;
  return Math.max(0, sorted[sorted.length - 1] - sorted[0]);
}

/**
 * 这一帧有多少比例的点跑到地面以下。
 * 身高用主体而不是最远的那个点，避免一块远处刚体把容差放得过大。
 * 低于身高约 8% 的接触算贴地。返回值越大，穿到地下的越多。
 */
function frameGroundPenetration(points: readonly Yz[], up: UpAxis): { pen: number; span: number } | null {
  const heights = sortedHeights(points, up);
  if (heights.length < 3) return null;
  const span = robustSpan(heights);
  if (span < 1e-8) return null;
  const floor = -span * 0.08;
  let below = 0;
  for (const h of heights) if (h < floor) below += 1;
  const ratio = below / heights.length;
  const tail = Math.max(0, -quantile(heights, 0.1)) / span;
  return { pen: ratio * 0.55 + Math.min(1, tail) * 0.45, span };
}

/**
 * 用各帧里骨架、刚体、marker 相对地面的穿模选朝上方向。
 * 正确朝向通常只有脚底轻微贴地；大量跑到地面下的朝向会被丢掉。
 * 两个方向穿模差不多时，再看单帧里哪根轴更长。
 */
export function detectUpAxisFromPointFrames(frames: readonly (readonly Yz[])[]): UpAxis {
  const pen = { y: 0, "-y": 0, z: 0, "-z": 0 };
  const used = { y: 0, "-y": 0, z: 0, "-z": 0 };
  const spanSum = { y: 0, "-y": 0, z: 0, "-z": 0 };
  let spanFrames = 0;
  for (const frame of frames) {
    if (frame.length < 3) continue;
    let measured = false;
    for (const up of UP_CANDIDATES) {
      const score = frameGroundPenetration(frame, up);
      if (score == null) continue;
      pen[up] += score.pen;
      spanSum[up] += score.span;
      used[up] += 1;
      measured = true;
    }
    if (measured) spanFrames += 1;
  }
  if (!spanFrames) return "y";
  const avg = (up: UpAxis) => (used[up] ? pen[up] / used[up] : 1);
  const meanSpan = (up: UpAxis) => (used[up] ? spanSum[up] / used[up] : 0);
  const meanSpanY = Math.max(meanSpan("y"), meanSpan("-y"));
  const meanSpanZ = Math.max(meanSpan("z"), meanSpan("-z"));
  const yUp = avg("-y") + 0.08 < avg("y") ? "-y" : "y";
  const zUp = avg("-z") + 0.08 < avg("z") ? "-z" : "z";
  const yPen = avg(yUp);
  const zPen = avg(zUp);
  if (Math.abs(yPen - zPen) > 0.12) return yPen < zPen ? yUp : zUp;
  if (meanSpanZ > meanSpanY * 1.15) return zUp;
  if (meanSpanY > meanSpanZ * 1.15) return yUp;
  return yPen <= zPen ? yUp : zUp;
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
