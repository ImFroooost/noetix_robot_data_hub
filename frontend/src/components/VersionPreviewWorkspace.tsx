import type { ReactNode } from "react";

export type VersionTab = {
  id: number;
  label: string;
  disabled?: boolean;
};

interface Props {
  /** 区块标题旁徽章，如 FBX / 型号·阶段·格式 */
  badge: string;
  /** 版本数量说明 */
  subtitle?: string;
  tabs: VersionTab[];
  activeId: number | null;
  onChange: (id: number) => void;
  headerActions?: ReactNode;
  /** 右侧元信息 */
  inspector?: ReactNode;
  children: ReactNode;
  emptyText?: string;
}

/**
 * Motion Eval 风格：版本 Tab + 单个大预览 + 侧栏元信息。
 */
export function VersionPreviewWorkspace({
  badge,
  subtitle,
  tabs,
  activeId,
  onChange,
  headerActions,
  inspector,
  children,
  emptyText = "暂无文件",
}: Props) {
  if (!tabs.length) {
    return <div className="muted preview-workspace-empty">{emptyText}</div>;
  }

  return (
    <div className="preview-workspace">
      <div className="preview-workspace-head">
        <div className="human-compare-title">
          <span className="human-compare-badge">{badge}</span>
          {subtitle && (
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              {subtitle}
            </span>
          )}
        </div>
        {headerActions}
      </div>

      <div className="source-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeId === t.id}
            className={activeId === t.id ? "active" : ""}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            title={t.label}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="preview-workspace-body">
        <div className="viewer-column">{children}</div>
        {inspector && <aside className="preview-inspector">{inspector}</aside>}
      </div>
    </div>
  );
}
