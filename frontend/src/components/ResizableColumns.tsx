import {
  Children,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePersistedState } from "../hooks/usePersistedState";

type Props = {
  storageKey: string;
  /** 前 N-1 栏的默认宽度（px）；最后一栏自适应 */
  defaults: number[];
  mins?: number[];
  maxes?: number[];
  className?: string;
  children: ReactNode;
  /** 显示重置按钮 */
  showReset?: boolean;
};

function useIsNarrow(query = "(max-width: 768px)") {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

export function ResizableColumns({
  storageKey,
  defaults,
  mins,
  maxes,
  className = "",
  children,
  showReset = true,
}: Props) {
  const panes = useMemo(() => Children.toArray(children).filter(Boolean), [children]);
  const fixedCount = Math.max(0, panes.length - 1);
  const defaultFixed = defaults.slice(0, fixedCount);
  const minFixed = (mins || defaultFixed.map(() => 160)).slice(0, fixedCount);
  const maxFixed = (maxes || defaultFixed.map(() => 640)).slice(0, fixedCount);

  const [widths, setWidths] = usePersistedState<number[]>(
    `layout:cols:${storageKey}`,
    defaultFixed
  );

  // sync length if pane count changes
  const fixedWidths = useMemo(() => {
    const next = [...widths];
    while (next.length < fixedCount) next.push(defaultFixed[next.length] ?? 220);
    return next.slice(0, fixedCount).map((w, i) => {
      const lo = minFixed[i] ?? 120;
      const hi = maxFixed[i] ?? 800;
      return Math.min(hi, Math.max(lo, w || lo));
    });
  }, [widths, fixedCount, defaultFixed, minFixed, maxFixed]);

  const narrow = useIsNarrow();
  const dragRef = useRef<{
    index: number;
    startX: number;
    startW: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (index: number, e: React.PointerEvent) => {
      if (narrow) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      dragRef.current = {
        index,
        startX: e.clientX,
        startW: fixedWidths[index] ?? defaultFixed[index] ?? 220,
      };
      document.body.classList.add("is-resizing-cols");
    },
    [narrow, fixedWidths, defaultFixed]
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const lo = minFixed[drag.index] ?? 120;
      const hi = maxFixed[drag.index] ?? 800;
      const nextW = Math.min(hi, Math.max(lo, drag.startW + dx));
      setWidths((prev) => {
        const base = [...prev];
        while (base.length < fixedCount) base.push(defaultFixed[base.length] ?? 220);
        const out = base.slice(0, fixedCount);
        out[drag.index] = nextW;
        return out;
      });
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.classList.remove("is-resizing-cols");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("is-resizing-cols");
    };
  }, [fixedCount, defaultFixed, minFixed, maxFixed, setWidths]);

  const reset = () => setWidths(defaultFixed);

  if (panes.length === 0) return null;

  if (narrow || panes.length === 1) {
    return <div className={`resizable-columns is-stacked ${className}`.trim()}>{panes}</div>;
  }

  const template = [...fixedWidths.map((w) => `${w}px`), "minmax(0, 1fr)"].reduce<string[]>(
    (acc, col, i) => {
      if (i > 0) acc.push("6px");
      acc.push(col);
      return acc;
    },
    []
  );

  const nodes: ReactNode[] = [];
  panes.forEach((pane, i) => {
    if (i > 0) {
      nodes.push(
        <div
          key={`h-${i - 1}`}
          className="resize-handle resize-handle-col"
          role="separator"
          aria-orientation="vertical"
          aria-label={`调整第 ${i} 栏宽度`}
          title="拖动调整宽度；双击重置该栏"
          onPointerDown={(e) => onPointerDown(i - 1, e)}
          onDoubleClick={() => {
            setWidths((prev) => {
              const next = [...prev];
              while (next.length < fixedCount) next.push(defaultFixed[next.length] ?? 220);
              const out = next.slice(0, fixedCount);
              out[i - 1] = defaultFixed[i - 1] ?? 220;
              return out;
            });
          }}
        />
      );
    }
    nodes.push(
      <div key={`p-${i}`} className="resizable-pane">
        {pane}
      </div>
    );
  });

  return (
    <div className={`resizable-columns-wrap ${className}`.trim()}>
      {showReset && (
        <div className="layout-reset-row">
          <button type="button" className="secondary layout-reset-btn" onClick={reset}>
            重置栏宽
          </button>
        </div>
      )}
      <div
        className="resizable-columns"
        style={{ gridTemplateColumns: template.join(" ") }}
      >
        {nodes}
      </div>
    </div>
  );
}

/** 可垂直拖拽调整高度的模块 */
export function ResizableHeight({
  storageKey,
  defaultHeight,
  min = 160,
  max = 900,
  className = "",
  children,
}: {
  storageKey: string;
  defaultHeight: number;
  min?: number;
  max?: number;
  className?: string;
  children: ReactNode;
}) {
  const [height, setHeight] = usePersistedState(`layout:h:${storageKey}`, defaultHeight);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const narrow = useIsNarrow();

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.min(max, Math.max(min, drag.startH + (e.clientY - drag.startY)));
      setHeight(next);
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.classList.remove("is-resizing-rows");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [min, max, setHeight]);

  return (
    <div
      className={`resizable-height ${className}`.trim()}
      style={narrow ? undefined : { height, minHeight: min }}
    >
      <div className="resizable-height-body">{children}</div>
      {!narrow && (
        <div
          className="resize-handle resize-handle-row"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整模块高度"
          title="拖动调整高度；双击重置"
          onPointerDown={(e) => {
            e.preventDefault();
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            dragRef.current = { startY: e.clientY, startH: height };
            document.body.classList.add("is-resizing-rows");
          }}
          onDoubleClick={() => setHeight(defaultHeight)}
        />
      )}
    </div>
  );
}
