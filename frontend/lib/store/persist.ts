/** Tiny localStorage helpers shared by the persisted zustand stores. */

/** SSR-safe read for store-init: returns `fallback` on the server and on any
 *  parse failure, so importing a persisted store never throws during SSR.
 *
 *  `guard` decides whether the parsed value is usable at all. A wrong-shaped
 *  cache is worse than no cache — the store hands it to code that assumes an
 *  array or an object and the resulting exception kills the page on every
 *  reload — so a rejected value is dropped from storage instead of loaded. */
export function loadPersisted<T>(key: string, fallback: T, guard?: (v: unknown) => v is T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (guard ? guard(parsed) : parsed != null) return parsed as T;
    localStorage.removeItem(key);
  } catch {
    /* corrupt / unavailable storage -> fall back */
  }
  return fallback;
}

/** Best-effort write; swallowing quota / private-mode errors keeps a failed
 *  persist from throwing inside a zustand reducer. */
export function persist(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode -> ignore */
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
