// Remembers where the visitor was on the plan (scene, proposed toggle, zoom)
// so "العودة للمخطط" lands on the same spot. sessionStorage is optional:
// every call is guarded so private mode or blocked storage just means a
// fresh view.

const KEY = 'office-twin:view-state';
let memory = null;

export function saveViewState(state) {
  memory = state;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — in-memory copy is enough for this session */
  }
}

export function loadViewState() {
  if (memory) return memory;
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearViewState() {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
