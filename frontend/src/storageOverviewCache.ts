import { api } from "./api";
import type { StorageOverview } from "./types";

let cached: { key: string; data: StorageOverview } | null = null;

function cacheKey(params: Record<string, string | number | undefined | null>) {
  return JSON.stringify(params);
}

export function invalidateStorageOverview() {
  cached = null;
}

export async function fetchStorageOverview(
  params: Record<string, string | number | undefined | null> = {},
  force = false
) {
  const key = cacheKey(params);
  if (!force && cached && cached.key === key) {
    return cached.data;
  }
  const data = await api.storageOverview(params);
  cached = { key, data };
  return data;
}
