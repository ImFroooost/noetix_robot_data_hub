import { useRef, useState, type DragEvent } from "react";
import {
  filesFromDataTransfer,
  filesFromFileList,
  folderHasUrdf,
  type RelFile,
} from "../utils/folderUpload";

interface Props {
  onFiles: (files: RelFile[]) => void;
  disabled?: boolean;
  hint?: string;
}

export function FolderDropZone({ onFiles, disabled, hint }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [summary, setSummary] = useState("");
  const [localError, setLocalError] = useState("");

  const apply = (files: RelFile[]) => {
    setLocalError("");
    if (!files.length) {
      setLocalError("未读取到文件，请重试拖拽或选择文件夹");
      return;
    }
    if (!folderHasUrdf(files)) {
      setLocalError("该文件夹中未找到 .urdf / .xacro，请确认选择了机器人资源目录");
      return;
    }
    setSummary(`已选择 ${files.length} 个文件（含 URDF）`);
    onFiles(files);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (disabled) return;
    try {
      const files = await filesFromDataTransfer(e.dataTransfer);
      apply(files);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "读取文件夹失败");
    }
  };

  return (
    <div className="stack">
      <div
        className={`dropzone ${dragging ? "dragging" : ""} ${disabled ? "disabled" : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragging(false);
        }}
        onDrop={onDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
      >
        <div className="dropzone-title">拖拽文件夹到这里</div>
        <div className="muted">或点击选择文件夹（支持 Chrome / Edge / Firefox）</div>
        {hint && <div className="muted" style={{ fontSize: "0.85rem" }}>{hint}</div>}
        {summary && <div className="success">{summary}</div>}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        disabled={disabled}
        onChange={(e) => apply(filesFromFileList(e.target.files))}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />
      {localError && <div className="error">{localError}</div>}
    </div>
  );
}
