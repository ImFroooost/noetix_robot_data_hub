/** Motive 与后来合并进 FBX 的标记点、刚体名字。两组规则要同时认。 */

export function captureLabel(name: string) {
  return name.trim().toLowerCase().replace(/[:\s]+/g, "_");
}

/**
 * 刚体键，用来把同一刚体上的点收成一组。
 * - `C3D:Rigid_Body_001_Marker_003`、`c3d_chair_marker_001`
 * - `C3D:b_PAI1_0`、`b_TABLE1_3`
 * 桌子四角和骨架点不在这里，它们有自己的画法。
 */
export function rigidMarkerKey(name: string): string | null {
  const flat = captureLabel(name).replace(/^c3d_/, "");
  const motive = flat.match(/^(.*)_marker_?\d+$/);
  if (motive) {
    const key = motive[1];
    if (!key || key === "table" || key === "unlabeled" || key.includes("skeleton")) return null;
    return key;
  }
  const body = flat.match(/^b_(.+)_(\d+)$/);
  if (body && body[1] && body[1] !== "unlabeled") return body[1];
  return null;
}

/** 刚体在画面上的名字，尽量保留文件里的大小写。 */
export function rigidPrettyName(name: string, key: string) {
  const flat = name.trim().replace(/^C3D[:_\s]*/i, "");
  const body = flat.match(/^b_(.+)_\d+$/i);
  if (body?.[1]) return body[1];
  const motive = flat.match(/^(.*)_Marker_?\d+$/i);
  if (motive?.[1]) return motive[1].replace(/_/g, " ");
  return key.replace(/_+/g, " ");
}

export function pointDisplayName(name: string) {
  return name.replace(/^C3D:/i, "").trim();
}

/** `Skeleton 001_LeftUpLeg` → `LeftUpLeg`。没有这层前缀时用原名。 */
export function skeletonJointName(name: string) {
  const match = name.match(/^(?:c3d[:_\s]*)?(skeleton[_ \d]*\d+)[_:\s]+(.+)$/i);
  return (match?.[2] || name).trim();
}

export function isNamedSkeletonBone(name: string) {
  return /skeleton/i.test(name);
}
