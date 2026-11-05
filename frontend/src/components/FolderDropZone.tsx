import { useRef, useState, type DragEvent } from "react";
import {
  filesFromDataTransfer,
  filesFromFileList,
  folderHasUrdf,
  type RelFile,
} from "../utils/folderUpload";

interface Props {
  onFiles: (files: RelFile[]) => void;
  onZip?: (file: File) => void;
  allowZip?: boolean;
  disabled?: boolean;
  hint?: string;
}

export function FolderDropZone({ onFiles, onZip, allowZip, disabled, hint }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [summary, setSummary] = useState("");
  const [localError, setLocalError] = useState("");

  const applyZip = (file: File | null | undefined) => {
    if (!file || !onZip) return;
    if (!/\.zip$/i.test(file.name)) {
      setLocalError("请选择 .zip 文件");
      return;
    }
    setLocalError("");
    setSummary(`已选择 zip：${file.name}`);
    onZip(file);
  };

  const apply = (files: RelFile[]) => {
    if (allowZip && files.length === 1 && /\.zip$/i.test(files[0].path) && !files[0].path.includes("/")) {
      applyZip(files[0].file);
      return;
    }
    setLocalError("");
    if (!files.length) {
      setLocalError("未读取到文件，请重试拖拽或选择文件夹");
      return;
    }
    if (!folderHasUrdf(files)) {
      setLocalError("该文件夹中未找到 .urdf / .xacro，请确认选择了机器人资源目录");
      return;
    }
    setSummary(`已选择文件夹，${files.length} 个文件（含 URDF）`);
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
        <div className="dropzone-title">{allowZip ? "拖入文件夹或 zip" : "拖拽文件夹到这里"}</div>
        <div className="muted">
          {allowZip ? "也可以点击下面的按钮选择" : "或点击选择文件夹（支持 Chrome / Edge / Firefox）"}
        </div>
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
      {allowZip && (
        <>
          <div className="row">
            <button type="button" className="secondary" disabled={disabled} onClick={() => inputRef.current?.click()}>
              选择文件夹
            </button>
            <button type="button" className="secondary" disabled={disabled} onClick={() => zipRef.current?.click()}>
              选择 zip
            </button>
          </div>
          <input
            ref={zipRef}
            type="file"
            accept=".zip,application/zip"
            style={{ display: "none" }}
            disabled={disabled}
            onChange={(e) => {
              applyZip(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </>
      )}
      {localError && <div className="error">{localError}</div>}
    </div>
  );
}
