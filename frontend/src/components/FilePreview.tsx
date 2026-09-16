import { useEffect, useState } from "react";
import { api, getToken } from "../api";
import type { StorageFile } from "../types";
import { isSmplMotionFile } from "../types";
import { AnimationFormatPreview, animationFormatOf } from "./AnimationFormatPreview";
import { isRobotMotionCsv, RobotCsvPreview } from "./RobotCsvPreview";
import { SmplPreview } from "./SmplSkeleton";

/** 人体 SMPL/SMPL-X/SMPL-H 动作文件（npz，format 标记为 smpl）。 */
export function isSmplMotion(file: StorageFile) {
  return isSmplMotionFile(file);
}

export function FilePreview({ file }: { file: StorageFile | null }) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const animationFormat = file ? animationFormatOf(file) : null;
  const smplMotion = file ? isSmplMotion(file) : false;

  useEffect(() => {
    let objectUrl = "";
    let cancelled = false;
    setUrl("");
    setText("");
    setError("");
    if (!file || animationFormat || smplMotion || isRobotMotionCsv(file)) return;
    const token = getToken();
    fetch(api.storageFileUrl(file.path), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("预览加载失败");
        if (file.modality === "text" || ["json", "txt", "csv", "xml", "urdf"].includes(file.format)) {
          const content = await res.text();
          if (!cancelled) setText(content.slice(0, 12000));
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "预览失败");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file?.path, animationFormat, smplMotion]);

  if (!file) return <div className="storage-preview-empty">点击数据单元中的文件添加到此窗口</div>;
  if (animationFormat) {
    return (
      <AnimationFormatPreview
        url={api.storageFileUrl(file.path)}
        format={animationFormat}
        durationHint={file.duration_sec}
      />
    );
  }
  if (smplMotion) {
    return <SmplPreview file={file} />;
  }
  if (isRobotMotionCsv(file)) {
    return <RobotCsvPreview file={file} />;
  }
  if (error) return <div className="storage-preview-empty">{error}</div>;
  if (text) return <pre className="storage-text-preview">{text}</pre>;
  if (!url) return <div className="storage-preview-empty">正在加载 {file.name}…</div>;
  if (file.modality.includes("video")) {
    return <video controls autoPlay src={url} className="storage-media-preview" />;
  }
  if (file.modality === "audio") {
    return <audio controls autoPlay src={url} style={{ width: "90%" }} />;
  }
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(file.format)) {
    return <img src={url} alt={file.name} className="storage-media-preview" />;
  }
  return (
    <div className="storage-preview-empty">
      {file.name}
      <br />
      此格式暂不支持浏览器内预览，可下载查看
    </div>
  );
}
