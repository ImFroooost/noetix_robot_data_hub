import type { ModelInstance, ModelInstanceFile } from "../types";

export const DEFAULT_HUMAN_MODEL = "smpl_neutral";

export function resolveHumanModelName(value?: string | null) {
  return String(value || "").trim() || DEFAULT_HUMAN_MODEL;
}

export function humanModelFiles(instance?: ModelInstance | null): ModelInstanceFile[] {
  if (!instance) return [];
  return instance.files
    .filter((file) => {
      if (file.kind === "smpl") return true;
      const name = file.name.toLowerCase();
      return name.endsWith(".pkl") || name.endsWith(".npz");
    })
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path, "en"));
}

export function normalizeHumanModelFile(
  files: ModelInstanceFile[],
  current = ""
): string {
  if (!current) {
    return files.length === 1 ? files[0].relative_path : "";
  }
  const match = files.find(
    (file) => file.relative_path === current || file.name === current || file.path === current
  );
  return match?.relative_path || current;
}

export function humanModelFileLabel(files: ModelInstanceFile[], current: string): string {
  if (!current) return "未选择";
  const match = files.find(
    (file) => file.relative_path === current || file.name === current || file.path === current
  );
  return match?.name || current;
}

export function resolveHumanModelFile(
  instance?: ModelInstance | null,
  current = ""
): ModelInstanceFile | undefined {
  const files = humanModelFiles(instance);
  const value = normalizeHumanModelFile(files, current);
  return (
    files.find(
      (file) => file.relative_path === value || file.name === value || file.path === value
    ) || (files.length === 1 ? files[0] : undefined)
  );
}

export function HumanModelFields({
  instances,
  model,
  modelFile,
  extraModel,
  onChange,
}: {
  instances: ModelInstance[];
  model: string;
  modelFile: string;
  extraModel?: string;
  onChange: (model: string, modelFile: string) => void;
}) {
  const current = resolveHumanModelName(model);
  const names = [
    ...new Set(
      [DEFAULT_HUMAN_MODEL, ...instances.map((item) => item.name), extraModel, current].filter(Boolean)
    ),
  ] as string[];
  const selected = instances.find((item) => item.name === current);
  const files = humanModelFiles(selected);
  const value = normalizeHumanModelFile(files, modelFile);
  const options =
    value && !files.some((file) => file.relative_path === value)
      ? [
          ...files,
          {
            id: value,
            path: value,
            name: value,
            kind: "smpl",
            relative_path: value,
            size: 0,
          },
        ]
      : files;

  return (
    <>
      <label>
        人体模型
        <select
          value={current}
          onChange={(event) => {
            const next = event.target.value;
            const nextFiles = humanModelFiles(instances.find((item) => item.name === next));
            onChange(next, nextFiles.length === 1 ? nextFiles[0].relative_path : "");
          }}
        >
          {names.map((name) => (
            <option key={name} value={name}>
              {name === DEFAULT_HUMAN_MODEL ? `${name}（默认）` : name}
            </option>
          ))}
        </select>
      </label>
      {files.length > 1 && (
        <label>
          人体模型文件
          <select
            value={value}
            onChange={(event) => onChange(current, event.target.value)}
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
