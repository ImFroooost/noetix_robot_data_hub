export type Role =
  | "visitor"
  | "downloader"
  | "annotator"
  | "uploader"
  | "manager"
  | "super_visitor"
  | "super_downloader"
  | "super_annotator"
  | "super_uploader"
  | "super_manager"
  | "admin"
  | "editor"
  | "viewer";
export type Quality = "high" | "medium" | "low";
export type RobotStage = "retarget" | "polish" | "refine" | "real";
export type TaxonomyScheme = string;
export type VideoKind =
  | "human"
  | "robot_motion"
  | "robot_policy_sim"
  | "robot_policy_real";
// 数据评价："" 未评价 / pass 直接通过 / needs_fix 需要修改 / discard 建议丢弃
export type ReviewValue = "" | "pass" | "needs_fix" | "discard";

export interface PermissionItem {
  capability: string;
  // ""=文件夹树；否则为分类标准 key，path_prefix 为该分类树节点路径
  scheme?: string;
  path_prefix: string;
  recursive: boolean;
}

export interface User {
  id: number;
  username: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  is_admin?: boolean;
  capabilities?: Record<string, string[]>;
  permissions?: PermissionItem[];
  impersonated_by?: { id: number; username: string } | null;
}

export interface Folder {
  id: number;
  parent_id: number | null;
  name: string;
  path: string;
  sort_order: number;
  created_at?: string;
  clip_count: number;
  child_count: number;
}

export interface TaxonomySchemeDef {
  key: string;
  name: string;
  code_prefix: string;
  sort_order: number;
  builtin: boolean;
  description: string;
  created_at?: string | null;
  node_count?: number;
}

export interface TaxonomyNode {
  id: number;
  scheme: string;
  parent_id: number | null;
  code: string;
  name: string;
  path: string;
  sort_order: number;
  description: string;
  clip_count: number;
  child_count: number;
}

export interface TaxonomyTagBrief {
  id: number;
  scheme: string;
  code?: string;
  name: string;
  path: string;
}

export interface HumanFile {
  id: number;
  clip_id: number;
  format: string;
  label?: string;
  fps: number | null;
  frame_count: number | null;
  quality: Quality;
  review?: ReviewValue | string;
  original_name: string;
  checksum: string | null;
  preview_path: string | null;
  process_status: string;
  process_message: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  can_download?: boolean;
}

export interface RobotFile {
  id: number;
  clip_id: number;
  robot_model_id: number;
  stage: RobotStage;
  format: string;
  label?: string;
  fps: number | null;
  frame_count: number | null;
  quality: Quality;
  review?: ReviewValue | string;
  original_name: string;
  checksum: string | null;
  preview_path: string | null;
  process_status: string;
  process_message: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  robot_model_name?: string | null;
  can_download?: boolean;
}

export interface RealVideo {
  id: number;
  clip_id: number;
  kind: VideoKind | string;
  quality: Quality;
  review?: ReviewValue | string;
  original_name: string;
  checksum: string | null;
  duration_sec: number | null;
  meta: Record<string, unknown>;
  created_at: string;
  can_download?: boolean;
}

export interface SharedText {
  id: number;
  clip_id: number;
  format: string;
  label?: string;
  review?: ReviewValue | string;
  original_name: string;
  checksum: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  can_download?: boolean;
}

export interface ModelAsset {
  id: number;
  category: "human" | "robot" | string;
  name: string;
  format: string;
  description: string;
  original_name: string;
  checksum: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface StorageFile {
  id: string;
  path: string;
  name: string;
  unit_name: string;
  size: number;
  modified_at: string;
  ontology: "human" | "robot";
  modality: string;
  channel: string;
  format: string;
  batch: string;
  uploader: StorageUploader | null;
  fps?: number | null;
  frame_count?: number | null;
  duration_sec?: number | null;
  width?: number | null;
  height?: number | null;
  joint_count?: number | null;
  sample_rate?: number | null;
  column_count?: number | null;
  taxonomy_tag_ids?: Record<string, number>;
  taxonomy_tags?: Record<string, TaxonomyTagBrief>;
  annotation?: StorageAnnotation;
}

export type MotionKind = "skeleton" | "object" | "merged";

export interface StorageAnnotation {
  quality?: string;
  note?: string;
  status?: string;
  robot_style?: string;
  robot_version?: string;
  human_model?: string;
  human_model_file?: string;
  motion_kind?: MotionKind | string;
  person_name?: string;
  gender?: string;
  height?: string;
  fps?: number | string;
  [key: string]: unknown;
}

export const DEFAULT_MOTION_KIND: MotionKind = "skeleton";

export const MOTION_KIND_OPTIONS: [MotionKind, string][] = [
  ["skeleton", "骨架数据"],
  ["object", "物体数据"],
  ["merged", "合并数据"],
];

export function isMotionKind(value: unknown): value is MotionKind {
  return value === "skeleton" || value === "object" || value === "merged";
}

export function resolveMotionKind(value?: unknown): MotionKind {
  return isMotionKind(value) ? value : DEFAULT_MOTION_KIND;
}

export function motionKindLabel(value?: unknown): string {
  const kind = resolveMotionKind(value);
  return MOTION_KIND_OPTIONS.find(([key]) => key === kind)?.[1] || "骨架数据";
}

export function isMotionModality(modality?: string | null) {
  return String(modality || "").toLowerCase() === "motion";
}

export const DEFAULT_CSV_FPS = 30;

export function isCsvFormat(format?: string | null) {
  return String(format || "").trim().toLowerCase() === "csv";
}

/** 人体 SMPL/SMPL-X/SMPL-H 动作：format 为 smpl，或文件是 npz。 */
export function isSmplFormat(format?: string | null, name?: string | null) {
  const fmt = String(format || "").trim().toLowerCase();
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  return fmt === "smpl" || ext === "npz";
}

export function isSmplMotionFile(file?: {
  ontology?: string | null;
  modality?: string | null;
  format?: string | null;
  name?: string | null;
} | null) {
  if (!file) return false;
  return (
    String(file.ontology || "").toLowerCase() === "human" &&
    String(file.modality || "").toLowerCase() === "motion" &&
    isSmplFormat(file.format, file.name)
  );
}

export function needsManualCsvFps(ontology?: string | null, format?: string | null) {
  if (String(ontology || "").toLowerCase() !== "robot") return false;
  return String(format || "")
    .toLowerCase()
    .split(/[,\s]+/)
    .includes("csv");
}

export function parseCsvFps(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 10000
    ? numeric
    : DEFAULT_CSV_FPS;
}

export interface StorageFileDetail extends StorageFile {
  unit_taxonomy_tag_ids?: Record<string, number>;
  unit_taxonomy_tags?: Record<string, TaxonomyTagBrief>;
  unit_annotation?: StorageAnnotation;
  batch_taxonomy_tag_ids?: Record<string, number>;
  batch_taxonomy_tags?: Record<string, TaxonomyTagBrief>;
  batch_annotation?: StorageAnnotation;
}

export interface StorageUploader {
  id: number;
  username: string;
  uploaded_at?: string;
  file_count?: number;
}

export interface StorageUnit {
  key: string;
  batch: string;
  name: string;
  file_count: number;
  files: StorageFile[];
  taxonomy_tag_ids: Record<string, number>;
  taxonomy_tags: Record<string, TaxonomyTagBrief>;
  annotation: StorageAnnotation;
  meta: Record<string, unknown>;
  uploaders: StorageUploader[];
}

export interface StorageBatch {
  name: string;
  unit_count: number;
  file_count: number;
  units: StorageUnit[];
  meta: Record<string, unknown>;
  uploaders: StorageUploader[];
  taxonomy_tag_ids?: Record<string, number>;
  taxonomy_tags?: Record<string, TaxonomyTagBrief>;
  annotation?: StorageAnnotation;
}

export interface StorageUploadSession {
  id: string;
  created_at: string;
  user_id: number;
  username: string;
  source: "folder" | "file" | "legacy" | string;
  legacy?: boolean;
  batch: string;
  ontology: string;
  modality: string;
  channel: string;
  format: string;
  annotation: StorageAnnotation;
  taxonomy_tag_ids?: Record<string, number>;
  taxonomy_tags?: Record<string, TaxonomyTagBrief>;
  paths: string[];
  unit_names: string[];
  file_count: number;
  uploaded: number;
  replaced: number;
}

export interface StorageOverview {
  updated_at: string;
  index_updated_at?: string;
  modalities: string[];
  ontologies: string[];
  uploaders: StorageUploader[];
  batches: StorageBatch[];
  units: StorageUnit[];
  files: StorageFile[];
  upload_sessions?: StorageUploadSession[];
}

export interface CatalogRebuildStats {
  file_count?: number;
  unit_count?: number;
  batch_count?: number;
  model_file_count?: number;
  model_instance_count?: number;
}

export interface CatalogRebuildStatus {
  status: "idle" | "running" | "done" | "error";
  phase: string;
  percent: number;
  message: string;
  stats?: CatalogRebuildStats | null;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export type StorageFolderUploadStatus =
  | "uploaded"
  | "replaced"
  | "skip"
  | "failed";

export interface StorageFolderUploadItem {
  name: string;
  unit_name: string;
  status: StorageFolderUploadStatus;
  detail?: string;
  file?: StorageFile;
}

export interface StorageFolderUploadResult {
  batch: string;
  total: number;
  uploaded: number;
  replaced: number;
  skipped: number;
  failed: number;
  items: StorageFolderUploadItem[];
  upload_session_id?: string | null;
}

export interface ModelInstanceFile {
  id: string;
  path: string;
  name: string;
  kind: string;
  relative_path: string;
  size: number;
}

export interface ModelInstance {
  key: string;
  ontology: "human" | "robot";
  name: string;
  kinds: string[];
  files: ModelInstanceFile[];
  meta: Record<string, unknown>;
}

export interface ModelRepositoryOverview {
  updated_at: string;
  instances: ModelInstance[];
  kinds: Record<string, string[]>;
}

export interface Clip {
  id: number;
  folder_id?: number | null;
  folder_path?: string;
  atomic_tag_id?: number | null;
  intent_tag_id?: number | null;
  style_tag_id?: number | null;
  atomic_tag?: TaxonomyTagBrief | null;
  intent_tag?: TaxonomyTagBrief | null;
  style_tag?: TaxonomyTagBrief | null;
  taxonomy_tags?: Record<string, TaxonomyTagBrief>;
  category: string;
  subcategory: string;
  summary: string;
  description: string;
  action_code?: string;
  action_name?: string;
  brief?: string;
  detail_def?: string;
  action_version?: string;
  routine_label?: string;
  duel_label?: string;
  compute_level?: string;
  multimodal_overall?: string;
  multimodal_segment?: string;
  multimodal_atomic?: string;
  tags: string[];
  duration_sec: number | null;
  sort_order?: number;
  thumbnail_path: string | null;
  created_by: number | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
  human_files: HumanFile[];
  robot_files: RobotFile[];
  real_videos?: RealVideo[];
  shared_texts?: SharedText[];
  can_download?: boolean;
  can_edit?: boolean;
  can_annotate?: boolean;
  can_upload?: boolean;
}

export interface ClipListItem {
  id: number;
  folder_id?: number | null;
  folder_path?: string;
  taxonomy_tags?: Record<string, TaxonomyTagBrief>;
  category: string;
  subcategory: string;
  summary: string;
  description: string;
  action_code?: string;
  action_name?: string;
  action_version?: string;
  tags: string[];
  duration_sec: number | null;
  sort_order?: number;
  thumbnail_path: string | null;
  created_at: string;
  human_formats: string[];
  robot_stages: string[];
  robot_models: string[];
  shared_formats?: string[];
  video_kinds?: string[];
  has_slice?: boolean;
  has_video?: boolean;
}

export interface SearchResult {
  total: number;
  page: number;
  page_size: number;
  items: ClipListItem[];
}

export interface RobotModel {
  id: number;
  name: string;
  description: string;
  urdf_path: string;
  package_path: string;
  joint_names: string[];
  meta: Record<string, unknown>;
  created_at: string;
}

export interface RepoFile {
  id: number;
  action_unit_id: number;
  action_id?: string;
  action_def?: Record<string, unknown>;
  dimensions: Record<string, unknown>;
  modality: string;
  ontology: string;
  format: string;
  source_name: string;
  repo_path: string;
  original_name: string;
  checksum: string | null;
  fps: number | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface RepoPack {
  key: string;
  modality: string;
  ontology: string;
  source_name: string;
  file_count: number;
  formats: string[];
  action_ids: string[];
  project: string;
  quality: string;
  fps: number | null;
  action_def: Record<string, unknown>;
  engineering: Record<string, unknown>;
  meta: Record<string, unknown>;
  created_at: string | null;
  files: RepoFile[];
}

export const QUALITY_LABEL: Record<Quality, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export const STAGE_LABEL: Record<RobotStage, string> = {
  retarget: "重定向",
  polish: "精修",
  refine: "二次精修",
  real: "真机",
};

export const ROLE_LABEL: Record<Role, string> = {
  visitor: "游客",
  downloader: "下载者",
  annotator: "标注者",
  uploader: "上传者",
  manager: "管理者",
  super_visitor: "超级游客",
  super_downloader: "超级下载者",
  super_annotator: "超级标注者",
  super_uploader: "超级上传者",
  super_manager: "超级管理者",
  admin: "超级管理者",
  editor: "超级上传者",
  viewer: "游客",
};

export const ROLE_OPTIONS: Role[] = [
  "visitor",
  "downloader",
  "annotator",
  "uploader",
  "manager",
  "super_visitor",
  "super_downloader",
  "super_annotator",
  "super_uploader",
  "super_manager",
];

export const SUPER_ROLES = new Set<Role>([
  "super_visitor",
  "super_downloader",
  "super_annotator",
  "super_uploader",
  "super_manager",
  "admin",
]);

export const ROLE_CAPABILITIES: Record<Role, string[]> = {
  visitor: ["browse"],
  downloader: ["browse", "download"],
  annotator: ["browse", "annotate"],
  uploader: ["browse", "download", "annotate", "upload"],
  manager: ["browse", "download", "annotate", "upload", "manage_data"],
  super_visitor: ["browse"],
  super_downloader: ["browse", "download"],
  super_annotator: ["browse", "annotate"],
  super_uploader: ["browse", "download", "annotate", "upload"],
  super_manager: [
    "browse",
    "download",
    "annotate",
    "upload",
    "manage_data",
    "manage_users",
  ],
  admin: ["browse", "download", "annotate", "upload", "manage_data", "manage_users"],
  editor: ["browse", "download", "annotate", "upload"],
  viewer: ["browse"],
};

export const CAPABILITY_COLUMNS = [
  { key: "browse", label: "可浏览" },
  { key: "download", label: "可下载" },
  { key: "annotate", label: "可标注" },
  { key: "upload", label: "可上传" },
  { key: "manage_data", label: "可管理数据" },
  { key: "manage_users", label: "可管理用户" },
] as const;

export function isSuperRole(role: Role | string | undefined): boolean {
  return !!role && SUPER_ROLES.has(role as Role);
}

export function isSuperManager(role: Role | string | undefined): boolean {
  return role === "super_manager" || role === "admin";
}

export const PROCESS_STATUS_LABEL: Record<string, string> = {
  pending: "处理中",
  done: "已完成",
  error: "失败",
};

export const VIDEO_KIND_LABEL: Record<string, string> = {
  human: "真人视频",
  robot_motion: "motion播放",
  robot_policy_sim: "策略仿真",
  robot_policy_real: "策略真机",
};

export const ROBOT_VIDEO_KINDS: VideoKind[] = [
  "robot_motion",
  "robot_policy_sim",
  "robot_policy_real",
];

export const REVIEW_LABEL: Record<string, string> = {
  "": "未评价",
  pass: "直接通过",
  needs_fix: "需要修改",
  discard: "建议丢弃",
};

export const REVIEW_OPTIONS: { value: ReviewValue; label: string }[] = [
  { value: "", label: "未评价" },
  { value: "pass", label: "直接通过" },
  { value: "needs_fix", label: "需要修改" },
  { value: "discard", label: "建议丢弃" },
];

export const MODEL_CATEGORY_LABEL: Record<string, string> = {
  human: "人体",
  robot: "机器人",
};

export const HUMAN_MODEL_FORMATS = ["fbx", "bvh", "smpl", "blend"];
export const ROBOT_MODEL_FORMATS = ["urdf", "xml", "fbx", "blend"];

export const MODALITY_LABEL: Record<string, string> = {
  motion: "动作",
  video: "视频",
  language: "语言",
};

export const ONTOLOGY_LABEL: Record<string, string> = {
  human: "人体",
  robot: "机器人",
};

export const TAXONOMY_SCHEME_LABEL: Record<string, string> = {
  atomic: "原子or组合",
  intent: "动作意图",
  style: "动作风格",
};

export function compactTaxonomyTagIds(
  ids: Record<string, number | "">
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(ids).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number"
    )
  );
}

export function taxonomySchemeLabel(
  scheme: string,
  schemes?: TaxonomySchemeDef[] | null
): string {
  const found = schemes?.find((s) => s.key === scheme);
  if (found?.name) return found.name;
  return TAXONOMY_SCHEME_LABEL[scheme] || scheme;
}

export function processStatusLabel(status: string | null | undefined): string {
  if (!status) return "-";
  return PROCESS_STATUS_LABEL[status] || status;
}

export function clipDisplayName(clip: {
  action_name?: string;
  summary?: string;
  id: number;
}): string {
  return clip.action_name || clip.summary || `条目 #${clip.id}`;
}

const PLAYABLE_HUMAN = new Set(["bvh", "fbx", "csv", "npy", "npz", "json"]);
const PLAYABLE_ROBOT = new Set(["csv", "npy", "npz", "json"]);

export function isPlayableHumanFormat(fmt: string | null | undefined): boolean {
  return !!fmt && PLAYABLE_HUMAN.has(fmt.toLowerCase());
}

export function isPlayableRobotFormat(fmt: string | null | undefined): boolean {
  return !!fmt && PLAYABLE_ROBOT.has(fmt.toLowerCase());
}
