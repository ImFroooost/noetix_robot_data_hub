import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { StorageFile } from "../types";

const MIN_SLOTS = 2;

export type PreviewSlot = StorageFile | null;

type PreviewContextValue = {
  slots: PreviewSlot[];
  activeIndex: number;
  activeFile: StorageFile | null;
  filledCount: number;
  add: (file: StorageFile) => void;
  removeAt: (index: number) => void;
  removeByPaths: (paths: string[]) => void;
  syncFromOverview: (files: StorageFile[], units: { files: StorageFile[] }[]) => void;
  setActive: (index: number) => void;
  addSlot: () => void;
  clear: () => void;
};

const PreviewContext = createContext<PreviewContextValue | null>(null);

function trimSlots(slots: PreviewSlot[]) {
  let last = slots.length - 1;
  while (last >= MIN_SLOTS && slots[last] == null) last -= 1;
  return slots.slice(0, Math.max(MIN_SLOTS, last + 1));
}

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [slots, setSlots] = useState<PreviewSlot[]>(() =>
    Array.from({ length: MIN_SLOTS }, () => null)
  );
  const [activeIndex, setActiveIndex] = useState(0);

  const add = useCallback((file: StorageFile) => {
    setSlots((current) => {
      const existing = current.findIndex((item) => item?.id === file.id);
      if (existing >= 0) {
        setActiveIndex(existing);
        return current;
      }
      const emptyActive = current[activeIndex] == null ? activeIndex : -1;
      const empty = current.findIndex((item) => item == null);
      const target = emptyActive >= 0 ? emptyActive : empty;
      if (target >= 0) {
        setActiveIndex(target);
        return current.map((item, index) => (index === target ? file : item));
      }
      setActiveIndex(current.length);
      return [...current, file];
    });
  }, [activeIndex]);

  const removeAt = useCallback((index: number) => {
    setSlots((current) => {
      const next = current.map((item, itemIndex) => (itemIndex === index ? null : item));
      return trimSlots(next);
    });
    setActiveIndex((current) => (current === index ? 0 : current));
  }, []);

  const removeByPaths = useCallback((paths: string[]) => {
    const gone = new Set(paths);
    setSlots((current) =>
      trimSlots(current.map((item) => (item && gone.has(item.path) ? null : item)))
    );
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
    setSlots((current) => {
      setActiveIndex(current.length);
      return [...current, null];
    });
  }, []);

  const clear = useCallback(() => {
    setSlots(Array.from({ length: MIN_SLOTS }, () => null));
    setActiveIndex(0);
  }, []);

  const value = useMemo<PreviewContextValue>(
    () => ({
      slots,
      activeIndex,
      activeFile: slots[activeIndex] || null,
      filledCount: slots.filter(Boolean).length,
      add,
      removeAt,
      removeByPaths,
      syncFromOverview,
      setActive: setActiveIndex,
      addSlot,
      clear,
    }),
    [slots, activeIndex, add, removeAt, removeByPaths, syncFromOverview, addSlot, clear]
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
