import type { Role } from "../types";
import { ROLE_LABEL } from "../types";

export const OPEN_ROLE_HELP_KEY = "open-role-help";

const ROLE_DOC: Record<string, string> = {
  visitor: "visitor.md",
  viewer: "visitor.md",
  downloader: "downloader.md",
  annotator: "annotator.md",
  uploader: "uploader.md",
  editor: "super_uploader.md",
  manager: "manager.md",
  super_visitor: "super_visitor.md",
  super_downloader: "super_downloader.md",
  super_annotator: "super_annotator.md",
  super_uploader: "super_uploader.md",
  super_manager: "super_manager.md",
  admin: "super_manager.md",
};

export function helpDocPath(role: Role | string | undefined) {
  const file = ROLE_DOC[role || ""] || "visitor.md";
  return `/help/roles/${file}`;
}

export function helpDocTitle(role: Role | string | undefined) {
  return `${ROLE_LABEL[(role || "visitor") as Role] || role || "游客"}使用说明`;
}

export function requestOpenRoleHelp() {
  sessionStorage.setItem(OPEN_ROLE_HELP_KEY, "1");
}

export function consumeOpenRoleHelp() {
  if (sessionStorage.getItem(OPEN_ROLE_HELP_KEY) !== "1") return false;
  sessionStorage.removeItem(OPEN_ROLE_HELP_KEY);
  return true;
}
