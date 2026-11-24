import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

type Listener = (time: number, fps: number) => void;

const ClockContext = createContext<{
  subscribe: (listener: Listener) => () => void;
  report: (time: number, fps?: number) => void;
} | null>(null);

export function PlaybackClockProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const api = useMemo(
    () => ({
      subscribe(listener: Listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      report(time: number, fps = 0) {
        listeners.current.forEach((listener) => listener(time, fps));
      },
    }),
    []
  );
  return <ClockContext.Provider value={api}>{children}</ClockContext.Provider>;
}

export function useReportPlayback(time: number, fps = 0) {
  const clock = useContext(ClockContext);
  useLayoutEffect(() => {
    clock?.report(time, fps);
  }, [clock, time, fps]);
}

export function usePlayback() {
  const clock = useContext(ClockContext);
  const [playback, setPlayback] = useState({ time: 0, fps: 0 });
  useEffect(() => {
    if (!clock) return;
    return clock.subscribe((time, fps) => {
      setPlayback((current) => {
        const nextFps = fps > 0 ? fps : current.fps;
        if (Math.abs(current.time - time) < 1e-4 && nextFps === current.fps) return current;
        return { time, fps: nextFps };
      });
    });
  }, [clock]);
  return playback;
}
