import { api, getToken } from "../api";

export async function fetchAuth(url: string) {
  const token = getToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`文件下载失败（${res.status}）`);
  return res;
}

export function normalizeRepoPath(path: string) {
  const parts: string[] = [];
  for (const raw of path.replace(/\\/g, "/").split("/")) {
    if (!raw || raw === ".") continue;
    if (raw === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(raw);
  }
  return parts.join("/");
}

function joinRepo(...parts: string[]) {
  return normalizeRepoPath(parts.filter(Boolean).join("/"));
}

export function meshPathCandidates(
  loaderPath: string,
  packageRoot: string,
  sourceFilePath: string
) {
  const cleaned = loaderPath
    .replace(/^file:\/\//, "")
    .replace(/^\/+/, "")
    .replace(/^package:\/\/[^/]+\//, "");
  const sourceDir = sourceFilePath.replace(/\/[^/]+$/, "");
  const fileName =
    cleaned
      .split("/")
      .filter((part) => part && part !== "." && part !== "..")
      .pop() || "";
  return [
    ...new Set(
      [
        joinRepo(packageRoot, "meshes", fileName),
        joinRepo(sourceDir, "..", "meshes", fileName),
        joinRepo(sourceDir, "meshes", fileName),
        joinRepo(packageRoot, cleaned),
        joinRepo(sourceDir, cleaned),
        normalizeRepoPath(cleaned),
      ].filter(Boolean)
    ),
  ];
}

export async function fetchRepoMesh(
  loaderPath: string,
  packageRoot: string,
  sourceFilePath: string
) {
  const candidates = meshPathCandidates(loaderPath, packageRoot, sourceFilePath);
  let lastError: Error | null = null;
  for (const path of candidates) {
    try {
      const res = await fetchAuth(api.storageFileUrl(path));
      return { path, buffer: await res.arrayBuffer() };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error("网格加载失败");
    }
  }
  throw lastError || new Error(`找不到网格：${loaderPath}`);
}
