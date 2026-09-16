import {
  MOTION_KIND_OPTIONS,
  resolveMotionKind,
  type MotionKind,
} from "../types";

export function MotionKindFields({
  value,
  onChange,
}: {
  value: string;
  onChange: (kind: MotionKind) => void;
}) {
  return (
    <label>
      运动类型
      <select
        value={resolveMotionKind(value)}
        onChange={(event) => onChange(resolveMotionKind(event.target.value))}
      >
        {MOTION_KIND_OPTIONS.map(([kind, label]) => (
          <option key={kind} value={kind}>
            {label}
            {kind === "skeleton" ? "（默认）" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
