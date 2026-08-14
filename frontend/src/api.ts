const TOKEN_KEY = "motion_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function chineseHttpError(status: number, detail: string): string {
  if (status === 413) return "文件过大，请压缩 mesh 或拆分后重试（上限约 4GB）";
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
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new Error(
      "无法连接服务器（Failed to fetch）。请确认用 http://服务器IP/ 打开网页，且 docker compose 服务正常；若上传大 zip，请在系统浏览器中重试。"
    );
  }
  if (res.status === 401) {
    setToken(null);
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
    const msg = typeof detail === "string" ? detail : JSON.stringify(detail);
    throw new Error(chineseHttpError(res.status, msg));
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res as unknown as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ access_token: string; role: string; username: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<import("./types").User>("/api/auth/me"),
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
  uploadHuman: (clipId: number, form: FormData) =>
    request(`/api/clips/${clipId}/human-files`, { method: "POST", body: form }),
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

  listUsers: () => request<import("./types").User[]>("/api/users"),
  createUser: (body: Record<string, unknown>) =>
    request("/api/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: number, body: Record<string, unknown>) =>
    request(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

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
  fileUrl: (kind: "human" | "robot" | "video", id: number) => `/api/files/${kind}/${id}`,
  thumbUrl: (clipId: number) => `/api/thumbnails/${clipId}`,
  mediaUrl: (path: string) => `/api/media/${path}`,
};

export async function fetchJsonAuth(url: string) {
  const token = getToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error("加载失败");
  return res.json();
}

export async function downloadAuth(url: string, filename?: string) {
  const token = getToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error("下载失败");
  const blob = await res.blob();
  const obj = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = obj;
  a.download = filename || "download";
  a.click();
  URL.revokeObjectURL(obj);
}
