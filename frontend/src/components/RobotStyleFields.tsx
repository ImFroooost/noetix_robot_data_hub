import type { ModelInstance, ModelInstanceFile } from "../types";

export function robotDescriptionVersions(
  instance?: ModelInstance | null
): ModelInstanceFile[] {
  if (!instance) return [];
  return instance.files
    .filter((file) => {
      if (file.kind !== "standard_description") return false;
      const name = file.name.toLowerCase();
      return name.endsWith(".urdf") || name.endsWith(".xml");
    })
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path, "en"));
}

export function normalizeRobotVersion(
  versions: ModelInstanceFile[],
  current = ""
): string {
  if (!current) {
    return versions.length === 1 ? versions[0].relative_path : "";
  }
  const match = versions.find(
    (file) => file.relative_path === current || file.name === current
  );
  return match?.relative_path || current;
}

export function robotVersionLabel(
  versions: ModelInstanceFile[],
  current: string
): string {
  if (!current) return "未选择";
  const match = versions.find(
    (file) => file.relative_path === current || file.name === current
  );
  return match?.name || current;
}

export function RobotStyleFields({
  instances,
  style,
  version,
  extraStyle,
  onChange,
}: {
  instances: ModelInstance[];
  style: string;
  version: string;
  extraStyle?: string;
  onChange: (style: string, version: string) => void;
}) {
  const names = [
    ...new Set(
      [...instances.map((item) => item.name), extraStyle, style].filter(Boolean)
    ),
  ] as string[];
  const selected = instances.find((item) => item.name === style);
  const versions = robotDescriptionVersions(selected);
  const value = normalizeRobotVersion(versions, version);
  const options =
    value && !versions.some((file) => file.relative_path === value)
      ? [
          ...versions,
          {
            id: value,
            path: value,
            name: value,
            kind: "standard_description",
            relative_path: value,
            size: 0,
          },
        ]
      : versions;

  return (
    <>
      <label>
        机器人款式
        <select
          value={style}
          onChange={(event) => {
            const next = event.target.value;
            const nextVersions = robotDescriptionVersions(
              instances.find((item) => item.name === next)
            );
            onChange(
              next,
              nextVersions.length === 1 ? nextVersions[0].relative_path : ""
            );
          }}
        >
          <option value="">未选择</option>
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {versions.length > 1 && (
        <label>
          机器人版本
          <select
            value={value}
            onChange={(event) => onChange(style, event.target.value)}
          >
            <option value="">未选择</option>
            {options.map((file) => (
              <option key={file.relative_path} value={file.relative_path}>
                {file.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
