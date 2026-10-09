/** 当前页面正在做什么。心跳上报时读取，不经过全局加载条。 */

type Listener = () => void;

let detail = "";
const listeners = new Set<Listener>();

export function presenceDetail() {
  return detail;
}

export function setPresenceDetail(next: string) {
  const text = next.trim().slice(0, 240);
  if (text === detail) return;
  detail = text;
  for (const listener of listeners) listener();
}

export function subscribePresenceDetail(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
