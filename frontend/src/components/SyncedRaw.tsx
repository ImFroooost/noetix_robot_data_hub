import { useEffect, useRef, useState } from "react";
import { usePlayback } from "../playbackClock";
import { loadFrameDoc, type FrameDoc } from "../utils/rawFile";

export function SyncedRaw({ files }: { files: File[] }) {
  const playback = usePlayback();
  const [doc, setDoc] = useState<FrameDoc | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const key = files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join("|");

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    loadFrameDoc(filesRef.current)
      .then((next) => {
        if (!cancelled) setDoc(next);
      })
      .catch(() => {
        if (!cancelled) setDoc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!doc) return null;
  const frame = doc.frameAt(playback.time, playback.fps);
  return (
    <section className="viz-raw">
      <h3>{frame.count > 0 ? `原始数据 · 第 ${frame.index} 帧 / ${frame.count} · ${playback.time.toFixed(2)}s` : "原始数据"}</h3>
      <pre className="viz-raw-frame">{frame.text}</pre>
    </section>
  );
}
