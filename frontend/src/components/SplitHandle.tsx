import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export function useStoredNumber(key: string, fallback: number) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      const next = raw == null ? Number.NaN : Number(raw);
      return Number.isFinite(next) ? next : fallback;
    } catch {
      return fallback;
    }
  });
  const update = (next: number | ((current: number) => number)) => {
    setValue((current) => {
      const value = typeof next === "function" ? next(current) : next;
      try {
        localStorage.setItem(key, String(Math.round(value)));
      } catch {
        /* ignore */
      }
      return value;
    });
  };
  return [value, update] as const;
}

export function clampPane(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function SplitHandle({
  axis,
  onDelta,
}: {
  axis: "x" | "y";
  onDelta: (delta: number) => void;
}) {
  const last = useRef(0);
  const dragging = useRef(false);

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-col-resize", "is-row-resize");
  };

  return (
    <div
      className={`split-handle split-handle-${axis}`}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      onPointerDown={(event) => {
        event.preventDefault();
        dragging.current = true;
        last.current = axis === "x" ? event.clientX : event.clientY;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add(axis === "x" ? "is-col-resize" : "is-row-resize");
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const pos = axis === "x" ? event.clientX : event.clientY;
        const delta = pos - last.current;
        last.current = pos;
        if (delta) onDelta(delta);
      }}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}
