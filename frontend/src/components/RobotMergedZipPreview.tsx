import { useEffect, useState } from "react";
import { unzipSync } from "fflate";
import { api } from "../api";
import type { StorageFile } from "../types";
import { fetchAuth } from "../utils/repoMesh";
import { RobotCsvPreview } from "./RobotCsvPreview";

export function isRobotMergedZip(file: {
  path?: string;
  ontology?: string;
  format?: string;
  annotation?: { motion_kind?: string } | null;
}) {
  const path = (file.path || "").replace(/\\/g, "/");
  const fmt = (file.format || path.split(".").pop() || "").toLowerCase();
  return (
    (file.ontology === "robot" || path.includes("/robot/")) &&
    fmt === "zip" &&
    (path.includes("/merged/") || file.annotation?.motion_kind === "merged")
  );
}

export function RobotMergedZipPreview({ file }: { file: StorageFile }) {
  const [sources, setSources] = useState<{ csvUrl: string; objectXmlUrl: string; objectCsvUrl: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    setSources(null);
    setError("");
    fetchAuth(file.path.startsWith("blob:") ? file.path : api.storageFileUrl(file.path), { cache: "no-cache" })
      .then((res) => res.arrayBuffer())
      .then((buffer) => {
        if (cancelled) return;
        const entries = unzipSync(new Uint8Array(buffer));
        const names = Object.keys(entries).map((item) => item.replace(/\\/g, "/").toLowerCase());
        const find = (test: (name: string) => boolean) => {
          const index = names.findIndex(test);
          return index < 0 ? "" : URL.createObjectURL(new Blob([entries[Object.keys(entries)[index]]]));
        };
        const csvUrl = find((name) => name.startsWith("skeleton/") && name.endsWith(".csv"));
        const objectCsvUrl = find((name) => name.startsWith("object/") && name.endsWith(".csv"));
        const objectXmlUrl = find((name) => name.startsWith("object/") && name.endsWith(".xml"));
        [csvUrl, objectCsvUrl, objectXmlUrl].filter(Boolean).forEach((url) => created.push(url));
        if (!csvUrl || !objectCsvUrl || !objectXmlUrl) {
          throw new Error("zip 里需要 skeleton/*.csv、object/*.csv 和 object/*.xml");
        }
        setSources({ csvUrl, objectXmlUrl, objectCsvUrl });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "zip 预览失败");
      });
    return () => {
      cancelled = true;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [file.path]);

  if (error) return <div className="storage-preview-empty">{error}</div>;
  if (!sources) return <div className="storage-preview-empty">正在解压合并数据…</div>;
  return <RobotCsvPreview file={file} sources={sources} />;
}
