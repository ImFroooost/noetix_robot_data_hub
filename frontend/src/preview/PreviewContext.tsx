import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { StorageFile } from "../types";
import { useUndoOptional } from "../undo/UndoContext";

const MIN_SLOTS = 2;

export type PreviewSlot = StorageFile | null;

type PreviewContextValue = {
  slots: PreviewSlot[];
  activeIndex: number;
  activeFile: StorageFile | null;
  filledCount: number;
  contrastMode: boolean;
  add: (file: StorageFile) => void;
  removeAt: (index: number) => void;
  removeByPaths: (paths: string[]) => void;
  replaceByPath: (oldPath: string, file: StorageFile) => void;
  syncFromOverview: (files: StorageFile[], units: { files: StorageFile[] }[]) => void;
  setActive: (index: number) => void;
  addSlot: () => void;
  clear: () => void;
  setContrastMode: (on: boolean) => void;
  reorder: (from: number, to: number) => void;
};

const PreviewContext = createContext<PreviewContextValue | null>(null);

function trimSlots(slots: PreviewSlot[]) {
  let last = slots.length - 1;
  while (last >= MIN_SLOTS && slots[last] == null) last -= 1;
  return slots.slice(0, Math.max(MIN_SLOTS, last + 1));
}

export function PreviewProvider({ children }: { children: ReactNode }) {
  const history = useUndoOptional();
  const [slots, setSlots] = useState<PreviewSlot[]>(() =>
    Array.from({ length: MIN_SLOTS }, () => null)
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [contrastMode, setContrastModeState] = useState(false);
  const slotsRef = useRef(slots);
  const activeRef = useRef(activeIndex);
  slotsRef.current = slots;
  activeRef.current = activeIndex;

  const restore = useCallback((nextSlots: PreviewSlot[], nextActive: number) => {
    setSlots(nextSlots);
    setActiveIndex(nextActive);
  }, []);

  const setContrastMode = useCallback((on: boolean) => {
    setContrastModeState(on);
  }, []);

  const add = useCallback((file: StorageFile) => {
    const prevSlots = slotsRef.current;
    const prevActive = activeRef.current;
    const existing = prevSlots.findIndex((item) => item?.id === file.id);
    if (existing >= 0) {
      setActiveIndex(existing);
      return;
    }
    if (!contrastMode) {
      const nextSlots = Array.from({ length: MIN_SLOTS }, () => null);
      nextSlots[0] = file;
      slotsRef.current = nextSlots;
      activeRef.current = 0;
      setSlots(nextSlots);
      setActiveIndex(0);
      void history?.execute({
        label: `预览 ${file.name}`,
        refresh: false,
        do: () => restore(nextSlots, 0),
        undo: () => restore(prevSlots, prevActive),
      });
      return;
    }
    const emptyActive = prevSlots[prevActive] == null ? prevActive : -1;
    const empty = prevSlots.findIndex((item) => item == null);
    const target = emptyActive >= 0 ? emptyActive : empty;
    const nextSlots =
      target >= 0
        ? prevSlots.map((item, index) => (index === target ? file : item))
        : [...prevSlots, file];
    const nextActive = target >= 0 ? target : prevSlots.length;
    slotsRef.current = nextSlots;
    activeRef.current = nextActive;
    setSlots(nextSlots);
    setActiveIndex(nextActive);
    void history?.execute({
      label: `预览 ${file.name}`,
      refresh: false,
      do: () => restore(nextSlots, nextActive),
      undo: () => restore(prevSlots, prevActive),
    });
  }, [history, restore]);

  const removeAt = useCallback((index: number) => {
    const prevSlots = slotsRef.current;
    const prevActive = activeRef.current;
    const nextSlots = trimSlots(prevSlots.map((item, itemIndex) => (itemIndex === index ? null : item)));
    const nextActive = prevActive === index ? 0 : prevActive;
    slotsRef.current = nextSlots;
    activeRef.current = nextActive;
    setSlots(nextSlots);
    setActiveIndex(nextActive);
    void history?.execute({
      label: "关闭预览",
      refresh: false,
      do: () => restore(nextSlots, nextActive),
      undo: () => restore(prevSlots, prevActive),
    });
  }, [history, restore]);

  const removeByPaths = useCallback((paths: string[]) => {
    const gone = new Set(paths);
    setSlots((current) =>
      trimSlots(current.map((item) => (item && gone.has(item.path) ? null : item)))
    );
  }, []);

  const replaceByPath = useCallback((oldPath: string, file: StorageFile) => {
    setSlots((current) => {
      const next = current.map((item) => (item && item.path === oldPath ? file : item));
      slotsRef.current = next;
      return next;
    });
  }, []);

  const syncFromOverview = useCallback(
    (files: StorageFile[], units: { files: StorageFile[] }[]) => {
      setSlots((current) =>
        current.map((file) => {
          if (!file) return file;
          return (
            files.find((item) => item.path === file.path) ||
            units.flatMap((unit) => unit.files).find((item) => item.path === file.path) ||
            file
          );
        })
      );
    },
    []
  );

  const addSlot = useCallback(() => {
    const prevSlots = slotsRef.current;
    const prevActive = activeRef.current;
    const nextSlots = [...prevSlots, null];
    const nextActive = prevSlots.length;
    slotsRef.current = nextSlots;
    activeRef.current = nextActive;
    setSlots(nextSlots);
    setActiveIndex(nextActive);
    void history?.execute({
      label: "添加预览窗口",
      refresh: false,
      do: () => restore(nextSlots, nextActive),
      undo: () => restore(prevSlots, prevActive),
    });
  }, [history, restore]);

  const clear = useCallback(() => {
    const prevSlots = slotsRef.current;
    const prevActive = activeRef.current;
    const nextSlots = Array.from({ length: MIN_SLOTS }, () => null);
    slotsRef.current = nextSlots;
    activeRef.current = 0;
    setSlots(nextSlots);
    setActiveIndex(0);
    void history?.execute({
      label: "清空预览",
      refresh: false,
      do: () => restore(nextSlots, 0),
      undo: () => restore(prevSlots, prevActive),
    });
  }, [history, restore]);

  const reorder = useCallback((from: number, to: number) => {
    const prevSlots = slotsRef.current;
    if (from === to || from < 0 || to < 0 || from >= prevSlots.length || to >= prevSlots.length) return;
    const nextSlots = [...prevSlots];
    const [moved] = nextSlots.splice(from, 1);
    nextSlots.splice(to, 0, moved);
    slotsRef.current = nextSlots;
    setSlots(nextSlots);
  }, []);

  const value = useMemo<PreviewContextValue>(
    () => ({
      slots,
      activeIndex,
      activeFile: slots[activeIndex] || null,
      filledCount: slots.filter(Boolean).length,
      contrastMode,
      add,
      removeAt,
      removeByPaths,
      replaceByPath,
      syncFromOverview,
      setActive: setActiveIndex,
      addSlot,
      clear,
      setContrastMode,
      reorder,
    }),
    [slots, activeIndex, contrastMode, add, removeAt, removeByPaths, replaceByPath, syncFromOverview, addSlot, clear, setContrastMode, reorder]
  );

  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

export function usePreview() {
  const value = useContext(PreviewContext);
  if (!value) {
    throw new Error("usePreview 必须在 PreviewProvider 内使用");
  }
  return value;
}
