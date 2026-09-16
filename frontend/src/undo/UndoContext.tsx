import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { notifyIndexUpdated } from "../storageOverviewCache";

export const HISTORY_APPLIED_EVENT = "hub-history-applied";

export type HistoryCommand = {
  id: string;
  label: string;
  undo: () => Promise<void> | void;
  redo: () => Promise<void> | void;
  refresh?: boolean;
};

type ExecuteInput = {
  label: string;
  do: () => Promise<void> | void;
  undo: () => Promise<void> | void;
  refresh?: boolean;
};

type UndoContextValue = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
  busy: boolean;
  execute: (command: ExecuteInput) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
};

const UndoContext = createContext<UndoContextValue | null>(null);
const MAX_HISTORY = 80;

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function notifyHistoryApplied(refresh = true) {
  if (!refresh) return;
  notifyIndexUpdated();
  window.dispatchEvent(new Event(HISTORY_APPLIED_EVENT));
}

export function UndoProvider({ children }: { children: ReactNode }) {
  const [past, setPast] = useState<HistoryCommand[]>([]);
  const [future, setFuture] = useState<HistoryCommand[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const pastRef = useRef(past);
  const futureRef = useRef(future);
  pastRef.current = past;
  futureRef.current = future;

  const execute = useCallback(async (command: ExecuteInput) => {
    if (busyRef.current) return;
    await command.do();
    const entry: HistoryCommand = {
      id: newId(),
      label: command.label,
      undo: command.undo,
      redo: command.do,
      refresh: command.refresh,
    };
    setPast((current) => [...current.slice(-(MAX_HISTORY - 1)), entry]);
    setFuture([]);
  }, []);

  const undo = useCallback(async () => {
    if (busyRef.current) return;
    const current = pastRef.current;
    const command = current[current.length - 1];
    if (!command) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await command.undo();
      setPast((items) => items.slice(0, -1));
      setFuture((items) => [...items, command]);
      notifyHistoryApplied(command.refresh !== false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "撤销失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const redo = useCallback(async () => {
    if (busyRef.current) return;
    const current = futureRef.current;
    const command = current[current.length - 1];
    if (!command) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await command.redo();
      setFuture((items) => items.slice(0, -1));
      setPast((items) => [...items, command]);
      notifyHistoryApplied(command.refresh !== false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "重做失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const isUndo = key === "z" && !event.shiftKey;
      const isRedo = key === "y" || (key === "z" && event.shiftKey);
      if (!isUndo && !isRedo) return;
      event.preventDefault();
      if (isUndo) void undo();
      else void redo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const value = useMemo<UndoContextValue>(
    () => ({
      canUndo: past.length > 0 && !busy,
      canRedo: future.length > 0 && !busy,
      undoLabel: past[past.length - 1]?.label || "",
      redoLabel: future[future.length - 1]?.label || "",
      busy,
      execute,
      undo,
      redo,
    }),
    [past, future, busy, execute, undo, redo]
  );

  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}

export function useUndo() {
  const value = useContext(UndoContext);
  if (!value) throw new Error("useUndo 必须在 UndoProvider 内使用");
  return value;
}

export function useUndoOptional() {
  return useContext(UndoContext);
}

export function useHistoryReload(load: () => void | Promise<void>) {
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const onApplied = () => {
      void loadRef.current();
    };
    window.addEventListener(HISTORY_APPLIED_EVENT, onApplied);
    return () => window.removeEventListener(HISTORY_APPLIED_EVENT, onApplied);
  }, []);
}

export function HistoryButtons() {
  const { canUndo, canRedo, undoLabel, redoLabel, undo, redo } = useUndo();
  return (
    <div className="history-buttons">
      <button
        type="button"
        className="history-btn"
        disabled={!canUndo}
        title={undoLabel ? `撤销：${undoLabel}（Ctrl+Z）` : "撤销（Ctrl+Z）"}
        onClick={() => void undo()}
      >
        撤销
      </button>
      <button
        type="button"
        className="history-btn"
        disabled={!canRedo}
        title={redoLabel ? `重做：${redoLabel}（Ctrl+Y）` : "重做（Ctrl+Y）"}
        onClick={() => void redo()}
      >
        重做
      </button>
    </div>
  );
}
