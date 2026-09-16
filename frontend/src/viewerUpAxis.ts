import { useEffect, useState } from "react";

/** 数据里「上」是哪个轴 */
export type UpAxis = "y" | "z" | "-y" | "-z";
/** 界面选择：自动识别或手动指定 */
export type UpAxisMode = "auto" | "y" | "z";

const UP_AXIS_KEY = "hub-viewer-up-axis";

export function useUpAxisMode(): [UpAxisMode, (m: UpAxisMode) => void] {
  const [mode, setMode] = useState<UpAxisMode>(() => {
    try {
      const saved = localStorage.getItem(UP_AXIS_KEY);
      if (saved === "y" || saved === "z" || saved === "auto") return saved;
    } catch {
      /* ignore */
    }
    return "auto";
  });
  useEffect(() => {
    try {
      localStorage.setItem(UP_AXIS_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);
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

/** 比较竖直方向在 Y / Z 上的伸展，判断数据更像 Y-up 还是 Z-up。 */
export function detectUpAxisFromExtents(
  spanY: number,
  spanZ: number,
  midY = 0,
  midZ = 0
): UpAxis {
  if (!Number.isFinite(spanY) || !Number.isFinite(spanZ)) return "y";
  if (spanZ > spanY * 1.15) return midZ >= 0 ? "z" : "-z";
  if (spanY > spanZ * 1.15) return midY >= 0 ? "y" : "-y";
  return "y";
}

export function detectUpAxisFromBox(box: {
  min: { y: number; z: number };
  max: { y: number; z: number };
  isEmpty?: () => boolean;
}): UpAxis {
  if (box.isEmpty?.()) return "y";
  return detectUpAxisFromExtents(
    box.max.y - box.min.y,
    box.max.z - box.min.z,
    (box.max.y + box.min.y) / 2,
    (box.max.z + box.min.z) / 2
  );
}

/** 从按关节展开的 XYZ 帧里判断竖直轴（每 3 个数一个关节）。 */
export function detectUpAxisFromJointFrames(frames: number[][], sampleCount = 24): UpAxis {
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const n = Math.min(sampleCount, frames.length);
  for (let i = 0; i < n; i++) {
    const vals = frames[Math.floor((i / Math.max(n - 1, 1)) * (frames.length - 1))] || [];
    for (let j = 0; j + 2 < vals.length; j += 3) {
      const y = vals[j + 1];
      const z = vals[j + 2] ?? 0;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  if (!Number.isFinite(minY)) return "y";
  return detectUpAxisFromExtents(
    maxY - minY,
    maxZ - minZ,
    (maxY + minY) / 2,
    (maxZ + minZ) / 2
  );
}

export function upAxisModeLabel(mode: UpAxisMode, detected: UpAxis): string {
  const detectedName = detected === "z" || detected === "-z" ? "Z-up" : "Y-up";
  if (mode === "auto") return `坐标系·自动(${detectedName})`;
  return mode === "y" ? "坐标系·Y-up" : "坐标系·Z-up";
}

export function cycleUpAxisMode(mode: UpAxisMode): UpAxisMode {
  return mode === "auto" ? "y" : mode === "y" ? "z" : "auto";
}
