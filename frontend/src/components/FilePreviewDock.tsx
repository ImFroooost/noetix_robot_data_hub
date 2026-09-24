import { useEffect, useMemo, useState, type DragEvent } from "react";
import type { StorageFile } from "../types";
import { usePreview } from "../preview/PreviewContext";
import { BUILD_ID } from "../buildId";
import { FilePreview } from "./FilePreview";

function gridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 3;
}

function colSpanFor(index: number, total: number, cols: number): number {
  if (total <= 1) return 1;
  const rows = Math.ceil(total / cols);
  const fullRows = rows - 1;
  const lastRowStart = fullRows * cols;
  const lastRowCount = total - lastRowStart;
  if (index < lastRowStart) return 1;
  if (lastRowCount === cols) return 1;
  if (lastRowCount === 1) return cols;
  if (lastRowCount === 2 && cols === 3) {
    return index - lastRowStart === 0 ? 2 : 1;
  }
  return 1;
}

export function FilePreviewDock({
  onActivate,
}: {
  onActivate?: (file: StorageFile) => void;
}) {
  const preview = usePreview();
  const [moduleFullscreen, setModuleFullscreen] = useState(false);
  const [focused, setFocused] = useState<number[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  const overlayOpen = moduleFullscreen || focused.length > 0;
  const visibleIndexes = useMemo(() => {
    if (focused.length) return [...focused].sort((a, b) => a - b);
    if (!preview.contrastMode) {
      const active = preview.slots.findIndex((s) => s);
      if (active >= 0) return [active];
      return [0];
    }
    return preview.slots.map((_, index) => index);
  }, [focused, preview.slots, preview.contrastMode]);

  const filledCount = visibleIndexes.filter((i) => preview.slots[i]).length;
  const cols = gridColumns(filledCount || visibleIndexes.length);

  const exitFullscreen = () => {
    setFocused([]);
    setModuleFullscreen(false);
  };

  const toggleModuleFullscreen = () => {
    if (moduleFullscreen && !focused.length) {
      setModuleFullscreen(false);
      return;
    }
    setFocused([]);
    setModuleFullscreen(true);
  };

  const toggleWindowFullscreen = (index: number) => {
    setFocused((current) => {
      if (current.includes(index)) {
        const next = current.filter((item) => item !== index);
        if (!next.length) setModuleFullscreen(false);
        return next;
      }
      return [...current, index].sort((a, b) => a - b);
    });
  };

  useEffect(() => {
    if (!overlayOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        exitFullscreen();
      }
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [overlayOpen]);

  useEffect(() => {
    setFocused((current) => current.filter((index) => index < preview.slots.length));
  }, [preview.slots.length]);

  useEffect(() => {
    if (overlayOpen) return;
    const id = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
    return () => window.cancelAnimationFrame(id);
  }, [overlayOpen]);

  const onDragStart = (e: DragEvent<HTMLDivElement>, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragIndex !== null && dragIndex !== index) {
      setDropTarget(index);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== index) {
      preview.reorder(dragIndex, index);
    }
    setDragIndex(null);
    setDropTarget(null);
  };

  const onDragEnd = () => {
    setDragIndex(null);
    setDropTarget(null);
  };

  return (
    <section
      className={`storage-preview-section ${overlayOpen ? "is-fullscreen" : ""}`}
    >
      <div className="storage-preview-toolbar">
        <div>
          <h3>同屏预览</h3>
          <p className="muted">
            可同时打开任意批次、任意单元中的文件；切换左侧列表不会清空。已打开{" "}
            {preview.filledCount} 个
            {overlayOpen ? " · Esc 退出全屏" : ""}
            {" · 构建 "}
            {BUILD_ID}
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className={preview.contrastMode ? "" : "secondary"}
            title="激活后点击文件会依次添加为新窗口；不激活时只显示最新点击的文件"
            onClick={() => preview.setContrastMode(!preview.contrastMode)}
          >
            对比模式
          </button>
          <button type="button" className="secondary" onClick={preview.addSlot}>
            添加窗口
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!preview.filledCount}
            onClick={preview.clear}
          >
            清空预览
          </button>
          <button type="button" onClick={toggleModuleFullscreen}>
            {moduleFullscreen && !focused.length ? "退出全屏" : "模块全屏"}
          </button>
        </div>
      </div>
      {overlayOpen && preview.slots.length > 1 && (
        <div className="storage-preview-fs-picks">
          <span className="muted">全屏窗口</span>
          {preview.slots.map((file, index) => {
            const selected = !focused.length || focused.includes(index);
            return (
              <button
                key={`pick:${index}`}
                type="button"
                className={selected ? "" : "secondary"}
                onClick={() => {
                  if (!focused.length) {
                    setFocused([index]);
                    return;
                  }
                  toggleWindowFullscreen(index);
                }}
              >
                窗口 {index + 1}
                {file ? ` · ${file.format}` : ""}
              </button>
            );
          })}
          {focused.length ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setFocused([]);
                setModuleFullscreen(true);
              }}
            >
              显示全部
            </button>
          ) : null}
          <button type="button" className="secondary" onClick={exitFullscreen}>
            退出全屏
          </button>
        </div>
      )}
      <div
        className={`storage-preview-grid ${visibleIndexes.length === 1 ? "is-solo" : ""}`}
        style={
          overlayOpen
            ? {
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridAutoRows: "1fr",
              }
            : undefined
        }
      >
        {visibleIndexes.map((index, displayIndex) => {
          const file = preview.slots[index];
          const windowFullscreen = focused.includes(index);
          const isDropTarget = dropTarget === index && dragIndex !== null && dragIndex !== index;
          const span = overlayOpen ? colSpanFor(displayIndex, filledCount || visibleIndexes.length, cols) : 1;
          return (
            <div
              key={`${file?.id || "empty"}:${index}`}
              className={`storage-preview-box ${
                preview.activeIndex === index ? "active" : ""
              } ${isDropTarget ? "is-drop-target" : ""} ${dragIndex === index ? "is-dragging" : ""}`}
              style={span > 1 ? { gridColumn: `span ${span}` } : undefined}
              onClick={() => {
                preview.setActive(index);
                if (file) onActivate?.(file);
              }}
              onDragOver={(e) => onDragOver(e, index)}
              onDrop={(e) => onDrop(e, index)}
            >
              <div
                className="storage-preview-header"
                draggable={overlayOpen}
                onDragStart={(e) => onDragStart(e, index)}
                onDragEnd={onDragEnd}
              >
                <span>
                  窗口 {index + 1}
                  {file ? ` · ${file.format}` : ""}
                </span>
                <div className="storage-preview-header-actions">
                  <button
                    type="button"
                    className="storage-preview-icon-btn"
                    title={
                      windowFullscreen
                        ? "移出全屏"
                        : focused.length
                          ? "加入全屏"
                          : "全屏此窗口"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleWindowFullscreen(index);
                    }}
                  >
                    {windowFullscreen ? "↙" : "⤢"}
                  </button>
                  {file && (
                    <button
                      type="button"
                      className="storage-preview-close"
                      title="关闭此预览"
                      onClick={(event) => {
                        event.stopPropagation();
                        preview.removeAt(index);
                        setFocused((current) =>
                          current
                            .filter((item) => item !== index)
                            .map((item) => (item > index ? item - 1 : item))
                        );
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
              <div className="storage-preview-content">
                {file ? (
                  <FilePreview file={file} />
                ) : (
                  <div className="storage-preview-empty">
                    窗口 {index + 1}
                    <br />
                    点击数据单元中的文件添加到此窗口
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
