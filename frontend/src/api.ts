import { startLoading, stopLoading } from "./loadingState";

const TOKEN_KEY = "motion_token";
const ACTOR_TOKEN_KEY = "motion_actor_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getActorToken(): string | null {
  return localStorage.getItem(ACTOR_TOKEN_KEY);
}

export function setActorToken(token: string | null) {
  if (token) localStorage.setItem(ACTOR_TOKEN_KEY, token);
  else localStorage.removeItem(ACTOR_TOKEN_KEY);
}

function chineseHttpError(status: number, detail: string): string {
  if (status === 413) return "文件过大，请压缩 mesh 或拆分后重试（上限约 16GB）";
  if (status === 401) return "登录已过期，请重新登录";
  if (status === 403) return "权限不足";
  if (status === 404) return "接口不存在";
  if (status === 400) return detail || "请求无效";
  if (status >= 500) return detail || "服务器错误，请查看后端日志";
  return detail || `请求失败（${status}）`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  startLoading();
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    stopLoading();
    throw new Error(
      "无法连接服务器（Failed to fetch）。请确认用 http://服务器IP/ 打开网页，且 docker compose 服务正常；若上传大 zip，请在系统浏览器中重试。"
    );
  }
  if (res.status === 401) {
    stopLoading();
    const actor = getActorToken();
    setToken(null);
    if (actor && actor !== token && !path.includes("/auth/login")) {
      setToken(actor);
      setActorToken(null);
      window.location.href = "/users";
      throw new Error("视角会话已失效，已回到超级管理者");
    }
    setActorToken(null);
    if (!path.includes("/auth/login")) {
      window.location.href = "/login";
    }
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = data.detail || JSON.stringify(data);
    } catch {
      /* ignore */
    }
    stopLoading();
    const msg = typeof detail === "string" ? detail : JSON.stringify(detail);
    throw new Error(chineseHttpError(res.status, msg));
  }
  if (res.status === 204) {
    stopLoading();
    return undefined as T;
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const data = await res.json();
    stopLoading();
    return data;
  }
  stopLoading();
  return res as unknown as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ access_token: string; role: string; username: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<import("./types").User>("/api/auth/me"),
  impersonate: (userId: number) =>
    request<{ access_token: string; role: string; username: string }>(
      `/api/auth/impersonate/${userId}`,
      { method: "POST" }
    ),
  stopImpersonate: () =>
    request<{ access_token: string; role: string; username: string }>(
      "/api/auth/stop-impersonate",
      { method: "POST" }
    ),
  impersonationTargets: () =>
    request<import("./types").User[]>("/api/auth/impersonation-targets"),
  search: (params: Record<string, string | number | boolean | undefined | null>) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    });
    return request<import("./types").SearchResult>(`/api/clips/search?${q}`);
  },
  facets: () =>
    request<{
      categories: string[];
      subcategories: string[];
      human_formats: string[];
      robot_models: string[];
      qualities: string[];
      stages: string[];
    }>("/api/clips/facets"),
  getClip: (id: number) => request<import("./types").Clip>(`/api/clips/${id}`),
  createClip: (body: Record<string, unknown>) =>
    request<import("./types").Clip>("/api/clips", { method: "POST", body: JSON.stringify(body) }),
  updateClip: (id: number, body: Record<string, unknown>) =>
    request<import("./types").Clip>(`/api/clips/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteClip: (id: number) => request<{ ok: boolean }>(`/api/clips/${id}`, { method: "DELETE" }),
  updateHumanFile: (id: number, body: Record<string, unknown>) =>
    request(`/api/clips/human-files/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  updateRobotFile: (id: number, body: Record<string, unknown>) =>
    request(`/api/clips/robot-files/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  updateRealVideo: (id: number, body: Record<string, unknown>) =>
    request(`/api/clips/real-videos/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  updateSharedText: (id: number, body: Record<string, unknown>) =>
    request(`/api/clips/shared-texts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  uploadHuman: (clipId: number, form: FormData) =>
    request(`/api/clips/${clipId}/human-files`, { method: "POST", body: form }),
  uploadRealVideo: (clipId: number, form: FormData) =>
    request(`/api/clips/${clipId}/real-videos`, { method: "POST", body: form }),
  uploadSharedText: (clipId: number, form: FormData) =>
    request(`/api/clips/${clipId}/shared-texts`, { method: "POST", body: form }),
  deleteClipFile: (kind: "human" | "robot" | "video" | "shared", id: number) =>
    request<{ ok: boolean }>(`/api/files/${kind}/${id}`, { method: "DELETE" }),
  importHumanZip: (form: FormData) =>
    request<{
      created_clip_ids: number[];
      clips: { clip_id: number; summary: string; formats: string[] }[];
      warnings: string[];
      skipped: number;
      folder_id: number | null;
      folder_path: string;
      folder_name: string;
    }>("/api/import/human-zip", { method: "POST", body: form }),
  uploadRobot: (clipId: number, form: FormData) =>
    request(`/api/clips/${clipId}/robot-files`, { method: "POST", body: form }),
  listRobotModels: () => request<import("./types").RobotModel[]>("/api/robot-models"),
  createRobotModel: (form: FormData) =>
    request("/api/robot-models", { method: "POST", body: form }),
  createRobotModelFromPath: (form: FormData) =>
    request("/api/robot-models/from-path", { method: "POST", body: form }),

  listModelAssets: (category?: string) =>
    request<import("./types").ModelAsset[]>(
      `/api/model-assets${category ? `?category=${category}` : ""}`
    ),
  uploadModelAsset: (form: FormData) =>
    request<import("./types").ModelAsset>("/api/model-assets", {
      method: "POST",
      body: form,
    }),
  updateModelAsset: (id: number, body: Record<string, unknown>) =>
    request<import("./types").ModelAsset>(`/api/model-assets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteModelAsset: (id: number) =>
    request<{ ok: boolean }>(`/api/model-assets/${id}`, { method: "DELETE" }),
  modelAssetDownloadUrl: (id: number) => `/api/model-assets/${id}/download`,

  listUsers: () => request<import("./types").User[]>("/api/users"),
  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    }),
  createUser: (body: Record<string, unknown>) =>
    request("/api/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: number, body: Record<string, unknown>) =>
    request(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteUser: (id: number) =>
    request<{ ok: boolean }>(`/api/users/${id}`, { method: "DELETE" }),
  getUserPermissions: (id: number) =>
    request<import("./types").PermissionItem[]>(`/api/users/${id}/permissions`),
  putUserPermissions: (id: number, permissions: import("./types").PermissionItem[]) =>
    request<import("./types").PermissionItem[]>(`/api/users/${id}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ permissions }),
    }),

  listFolders: () => request<import("./types").Folder[]>("/api/folders"),
  createFolder: (body: Record<string, unknown>) =>
    request<import("./types").Folder>("/api/folders", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateFolder: (id: number, body: Record<string, unknown>) =>
    request<import("./types").Folder>(`/api/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteFolder: (id: number) =>
    request<{ ok: boolean }>(`/api/folders/${id}`, { method: "DELETE" }),
  batchClips: (body: {
    action: "move" | "delete";
    clip_ids: number[];
    folder_id?: number | null;
  }) => request<{ ok: boolean; count?: number }>("/api/clips/batch", {
    method: "POST",
    body: JSON.stringify(body),
  }),

  listTaxonomies: (scheme?: string) => {
    const q = scheme ? `?scheme=${encodeURIComponent(scheme)}` : "";
    return request<import("./types").TaxonomyNode[]>(`/api/taxonomies${q}`);
  },
  listTaxonomySchemes: () =>
    request<import("./types").TaxonomySchemeDef[]>("/api/taxonomies/schemes"),
  createTaxonomyScheme: (body: Record<string, unknown>) =>
    request<import("./types").TaxonomySchemeDef>("/api/taxonomies/schemes", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateTaxonomyScheme: (key: string, body: Record<string, unknown>) =>
    request<import("./types").TaxonomySchemeDef>(`/api/taxonomies/schemes/${key}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteTaxonomyScheme: (key: string, cascade = false) =>
    request<{ ok: boolean }>(
      `/api/taxonomies/schemes/${key}${cascade ? "?cascade=true" : ""}`,
      { method: "DELETE" }
    ),
  reorderTaxonomySchemes: (ordered_keys: string[]) =>
    request<import("./types").TaxonomySchemeDef[]>("/api/taxonomies/schemes/reorder", {
      method: "PUT",
      body: JSON.stringify({ ordered_keys }),
    }),
  restoreTaxonomyScheme: (key: string) =>
    request<{ moved: number; missing: string[]; kept: number; root: string }>(
      `/api/taxonomies/schemes/${encodeURIComponent(key)}/restore`,
      { method: "POST" }
    ),
  renumberTaxonomyScheme: (key: string) =>
    request<import("./types").TaxonomyNode[]>(
      `/api/taxonomies/schemes/${encodeURIComponent(key)}/renumber`,
      { method: "POST" }
    ),
  createTaxonomyNode: (body: Record<string, unknown>) =>
    request<import("./types").TaxonomyNode>("/api/taxonomies/nodes", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateTaxonomyNode: (id: number, body: Record<string, unknown>) =>
    request<import("./types").TaxonomyNode>(`/api/taxonomies/nodes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteTaxonomyNode: (id: number) =>
    request<{ ok: boolean }>(`/api/taxonomies/nodes/${id}`, { method: "DELETE" }),
  reorderTaxonomyNodes: (
    parent_id: number | null,
    ordered_ids: number[],
    renumber_codes = true
  ) =>
    request<import("./types").TaxonomyNode[]>("/api/taxonomies/nodes/reorder", {
      method: "PUT",
      body: JSON.stringify({ parent_id, ordered_ids, renumber_codes }),
    }),

  storageOverview: (
    params: Record<string, string | number | undefined | null> = {}
  ) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        q.set(key, String(value));
      }
    });
    return request<import("./types").StorageOverview>(
      `/api/storage/overview${q.size ? `?${q}` : ""}`
    ).then((data) => {
      const units =
        data.units?.length
          ? data.units
          : (data.batches || []).flatMap((batch) => batch.units || []);
      const files =
        data.files?.length
          ? data.files
          : units.flatMap((unit) => unit.files || []);
      return { ...data, units, files };
    });
  },
  storageRescan: () =>
    request<import("./types").CatalogRebuildStatus>("/api/storage/rescan", {
      method: "POST",
    }),
  storageRescanStatus: () =>
    request<import("./types").CatalogRebuildStatus>("/api/storage/rescan/status"),
  storageCreateBatch: (
    name: string,
    extra?: { taxonomy_tag_ids?: Record<string, number> }
  ) =>
    request<import("./types").StorageBatch>("/api/storage/batches", {
      method: "POST",
      body: JSON.stringify({ name, ...extra }),
    }),
  storageUpdateBatch: (name: string, body: Record<string, unknown>) =>
    request<import("./types").StorageBatch>(
      `/api/storage/batches/${encodeURIComponent(name)}`,
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  storageUpdateFileMeta: (path: string, body: Record<string, unknown>) =>
    request<import("./types").StorageFile>(
      `/api/storage/file-meta?path=${encodeURIComponent(path)}`,
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  storageUpdateUploadSession: (
    sessionId: string,
    body: Record<string, unknown>
  ) =>
    request<import("./types").StorageUploadSession>(
      `/api/storage/upload-sessions/${encodeURIComponent(sessionId)}`,
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  storageDeleteUploadSession: (sessionId: string, paths?: string[]) =>
    request<{ ok: boolean; removed: string[]; session_id: string }>(
      `/api/storage/upload-sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
        body: JSON.stringify(paths ? { paths } : {}),
      }
    ),
  storageUpdateUnit: (
    batch: string,
    unitName: string,
    body: Record<string, unknown>
  ) =>
    request<import("./types").StorageUnit>(
      `/api/storage/units/${encodeURIComponent(batch)}/${encodeURIComponent(unitName)}`,
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  storageUpdateNodeTaxonomy: (body: {
    batch: string;
    units: { name: string; taxonomy_tag_ids: Record<string, number | null> }[];
  }) =>
    request<{ updated: number }>("/api/storage/nodes/taxonomy", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  storageRenameBatch: (name: string, next: string) =>
    request<import("./types").StorageBatch>(
      `/api/storage/batches/${encodeURIComponent(name)}/rename`,
      { method: "POST", body: JSON.stringify({ name: next }) }
    ),
  storageDeleteBatch: (name: string) =>
    request<{ ok: boolean }>(
      `/api/storage/batches/${encodeURIComponent(name)}`,
      { method: "DELETE" }
    ),
  storageDownloadBatchUrl: (name: string) =>
    `/api/storage/batches/${encodeURIComponent(name)}/download`,
  storageRenameUnit: (batch: string, unitName: string, next: string) =>
    request<import("./types").StorageUnit>(
      `/api/storage/units/${encodeURIComponent(batch)}/${encodeURIComponent(unitName)}/rename`,
      { method: "POST", body: JSON.stringify({ name: next }) }
    ),
  storageDeleteUnit: (batch: string, unitName: string) =>
    request<{ ok: boolean }>(
      `/api/storage/units/${encodeURIComponent(batch)}/${encodeURIComponent(unitName)}`,
      { method: "DELETE" }
    ),
  storageDownloadUnitUrl: (batch: string, unitName: string) =>
    `/api/storage/units/${encodeURIComponent(batch)}/${encodeURIComponent(unitName)}/download`,
  storageBulkDelete: (body: {
    batches: string[];
    units: { batch: string; name: string }[];
  }) =>
    request<{ ok: boolean; batches: string[]; units: string[] }>(
      "/api/storage/bulk-delete",
      { method: "POST", body: JSON.stringify(body) }
    ),
  storageUpload: (form: FormData) =>
    request<import("./types").StorageFile>("/api/storage/data/upload", {
      method: "POST",
      body: form,
    }),
  storageUploadFolder: (form: FormData) =>
    request<import("./types").StorageFolderUploadResult>(
      "/api/storage/data/upload-folder",
      { method: "POST", body: form }
    ),
  storageUploadZip: (form: FormData) =>
    request<import("./types").StorageFolderUploadResult>(
      "/api/storage/data/upload-zip",
      { method: "POST", body: form }
    ),
  storageRenameFile: (path: string, next: string) =>
    request<import("./types").StorageFile>(
      `/api/storage/file/rename?path=${encodeURIComponent(path)}`,
      { method: "POST", body: JSON.stringify({ name: next }) }
    ),
  storageDeleteFile: (path: string) =>
    request<{ ok: boolean }>(
      `/api/storage/file?path=${encodeURIComponent(path)}`,
      { method: "DELETE" }
    ),
  storageFileUrl: (path: string, download = false) =>
    `/api/storage/file?path=${encodeURIComponent(path)}${
      download ? "&download=true" : ""
    }`,
  storageFileDetail: (path: string) =>
    request<import("./types").StorageFileDetail>(
      `/api/storage/file-detail?path=${encodeURIComponent(path)}`
    ),
  storageModels: () =>
    request<import("./types").ModelRepositoryOverview>("/api/storage/models"),
  storageCreateModelInstance: (ontology: "human" | "robot", name: string) =>
    request<import("./types").ModelInstance>("/api/storage/models/instances", {
      method: "POST",
      body: JSON.stringify({ ontology, name }),
    }),
  storageUpdateModelInstance: (
    ontology: string,
    name: string,
    body: Record<string, unknown>
  ) =>
    request<{ ok: boolean; meta: Record<string, unknown> }>(
      `/api/storage/models/instances/${encodeURIComponent(ontology)}/${encodeURIComponent(name)}`,
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  storageUploadModel: (form: FormData) =>
    request("/api/storage/models/upload", { method: "POST", body: form }),
  storageDeleteModelInstance: (ontology: string, name: string) =>
    request<{ ok: boolean }>(
      `/api/storage/models/instances/${encodeURIComponent(ontology)}/${encodeURIComponent(name)}`,
      { method: "DELETE" }
    ),
  storageDeleteModelFile: (path: string) =>
    request<{ ok: boolean }>(
      `/api/storage/models/file?path=${encodeURIComponent(path)}`,
      { method: "DELETE" }
    ),
  storageSchema: () =>
    request<{
      ontologies: string[];
      modalities: string[];
      fpv_channels: string[];
      model_kinds: Record<string, string[]>;
    }>("/api/storage/schema"),

  repoBrowseTree: () => request<{ tree: unknown }>("/api/repo/browse-tree"),
  repoCatalog: () => request<unknown>("/api/repo/catalog"),
  repoListPacks: (
    params: Record<string, string | number | boolean | undefined | null> = {}
  ) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      q.set(k, String(v));
    }
    const s = q.toString();
    return request<import("./types").RepoPack[]>(`/api/repo/packs${s ? `?${s}` : ""}`);
  },
  repoUpdatePack: (body: Record<string, unknown>) =>
    request<import("./types").RepoPack>("/api/repo/packs", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  repoDeletePack: (body: Record<string, unknown>) =>
    request<{ ok: boolean; deleted?: number }>("/api/repo/packs/delete", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  repoUpdateFile: (id: number, body: Record<string, unknown>) =>
    request<import("./types").RepoFile>(`/api/repo/files/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  repoBatchDeleteFiles: (ids: number[]) =>
    request<{ ok: boolean; deleted?: number }>("/api/repo/files/batch-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  repoDownloadUrl: (id: number) => `/api/repo/files/${id}/download`,
  repoUpload: (form: FormData) =>
    request<import("./types").RepoFile[]>("/api/repo/upload", { method: "POST", body: form }),
  repoUploadZip: (form: FormData) =>
    request<import("./types").RepoFile[]>("/api/repo/upload-zip", { method: "POST", body: form }),

  previewUrl: (kind: "human" | "robot", id: number) => `/api/previews/${kind}/${id}`,
  smplMotionUrl: (id: number) => `/api/previews/human/${id}/smpl`,
  storageSmplMotionUrl: (path: string) =>
    `/api/storage/smpl-motion?path=${encodeURIComponent(path)}`,
  smplModelUrl: (path: string) => `/api/storage/smpl-model?path=${encodeURIComponent(path)}`,
  fileUrl: (kind: "human" | "robot" | "video" | "shared", id: number) =>
    `/api/files/${kind}/${id}`,
  thumbUrl: (clipId: number) => `/api/thumbnails/${clipId}`,
  mediaUrl: (path: string) => `/api/media/${path}`,
};

export async function fetchJsonAuth(url: string) {
  const token = getToken();
  startLoading();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    stopLoading();
    throw new Error("加载失败");
  }
  const data = await res.json();
  stopLoading();
  return data;
}

export async function downloadAuth(url: string, filename?: string) {
  const token = getToken();
  startLoading("下载中…");
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    stopLoading();
    throw new Error("下载失败");
  }
  const blob = await res.blob();
  stopLoading();
  const obj = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = obj;
  a.download = filename || "download";
  a.click();
  URL.revokeObjectURL(obj);
}

export async function downloadAuthPost(
  url: string,
  body: unknown,
  filename?: string
) {
  const token = getToken();
  startLoading("下载中…");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    stopLoading();
    throw new Error("下载失败");
  }
  const blob = await res.blob();
  stopLoading();
  const obj = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = obj;
  a.download = filename || "download";
  a.click();
  URL.revokeObjectURL(obj);
}
