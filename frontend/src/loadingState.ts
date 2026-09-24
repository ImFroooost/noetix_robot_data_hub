/** Global loading indicator state. */

type Listener = (active: boolean, label: string) => void;

let activeCount = 0;
let currentLabel = "";
const listeners = new Set<Listener>();

function notify() {
  const active = activeCount > 0;
  for (const fn of listeners) {
    fn(active, currentLabel);
  }
}

export function startLoading(label = "") {
  activeCount += 1;
  if (label) currentLabel = label;
  notify();
}

export function stopLoading() {
  activeCount = Math.max(0, activeCount - 1);
  if (activeCount === 0) currentLabel = "";
  notify();
}

export function subscribeLoading(fn: Listener): () => void {
  listeners.add(fn);
  fn(activeCount > 0, currentLabel);
  return () => {
    listeners.delete(fn);
  };
}
