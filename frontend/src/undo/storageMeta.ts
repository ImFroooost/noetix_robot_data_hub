import { api } from "../api";

export type StorageMetaTarget =
  | { kind: "batch"; name: string }
  | { kind: "unit"; batch: string; name: string }
  | { kind: "file"; path: string }
  | { kind: "upload_session"; id: string; paths: string[] };

export async function patchStorageMeta(
  target: StorageMetaTarget,
  body: Record<string, unknown>
) {
  if (target.kind === "batch") {
    await api.storageUpdateBatch(target.name, body);
    return;
  }
  if (target.kind === "unit") {
    await api.storageUpdateUnit(target.batch, target.name, body);
    return;
  }
  if (target.kind === "file") {
    await api.storageUpdateFileMeta(target.path, body);
    return;
  }
  await api.storageUpdateUploadSession(target.id, {
    ...body,
    paths: target.paths,
  });
}

export async function undoUploadSession(sessionId?: string | null, paths: string[] = []) {
  if (sessionId) {
    await api.storageDeleteUploadSession(sessionId);
    return;
  }
  for (const path of paths) {
    await api.storageDeleteFile(path);
  }
}
