export type Role = "admin" | "editor" | "viewer";
export type Quality = "high" | "medium" | "low";
export type RobotStage = "retarget" | "polish" | "refine" | "real";
export type TaxonomyScheme = string;
export type VideoKind = "human" | "robot_motion";

export interface PermissionItem {
  capability: string;
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
  original_name: string;
  checksum: string | null;
  duration_sec: number | null;
  meta: Record<string, unknown>;
  created_at: string;
  can_download?: boolean;
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
  admin: "管理员",
  editor: "编辑者",
  viewer: "只读",
};

export const PROCESS_STATUS_LABEL: Record<string, string> = {
  pending: "处理中",
  done: "已完成",
  error: "失败",
};

export const VIDEO_KIND_LABEL: Record<string, string> = {
  human: "真人视频",
  robot_motion: "机器人视频",
};

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
  atomic: "原子动作",
  intent: "意图功能",
  style: "风格化模式",
};

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
