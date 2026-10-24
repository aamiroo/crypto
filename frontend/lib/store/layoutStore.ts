import { create } from "zustand";
import type { LayoutState } from "@/lib/types";
import { loadPersisted, persist, isRecord } from "@/lib/store/persist";

const KEY = "ct_layout";

const DEFAULTS: LayoutState = {
  watchlistOpen: true,
  watchlistWidth: 224,
  rightPanelOpen: true,
};

export const WATCHLIST_MIN = 180;
export const WATCHLIST_MAX = 380;

interface LayoutStore extends LayoutState {
  toggle: (panel: keyof Pick<LayoutState, "watchlistOpen" | "rightPanelOpen">) => void;
  setWatchlistWidth: (w: number) => void;
  reset: () => void;
}

/** Only the three known fields are taken from the cache; a stale or hand-edited
 *  blob must not smuggle a non-number width or a non-boolean flag into layout. */
function sanitizeLayout(value: unknown): LayoutState {
  const base = { ...DEFAULTS };
  if (!isRecord(value)) return base;
  if (typeof value.watchlistOpen === "boolean") base.watchlistOpen = value.watchlistOpen;
  if (typeof value.rightPanelOpen === "boolean") base.rightPanelOpen = value.rightPanelOpen;
  if (typeof value.watchlistWidth === "number" && Number.isFinite(value.watchlistWidth)) {
    base.watchlistWidth = clamp(value.watchlistWidth, WATCHLIST_MIN, WATCHLIST_MAX);
  }
  return base;
}

export const useLayoutStore = create<LayoutStore>((set) => ({
  ...sanitizeLayout(loadPersisted<unknown>(KEY, DEFAULTS)),

  toggle: (panel) =>
    set((s) => {
      const next = { ...s, [panel]: !s[panel] };
      persist(KEY, strip(next));
      return { [panel]: next[panel] } as Partial<LayoutStore>;
    }),

  setWatchlistWidth: (w) =>
    set((s) => {
      const width = clamp(w, WATCHLIST_MIN, WATCHLIST_MAX);
      persist(KEY, { ...strip(s), watchlistWidth: width });
      return { watchlistWidth: width };
    }),

  reset: () => {
    persist(KEY, DEFAULTS);
    set({ ...DEFAULTS });
  },
}));

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/** Projects the store back to plain LayoutState data before persisting: the
 *  live object also carries action functions, which must not reach localStorage. */
function strip(s: LayoutState): LayoutState {
  return {
    watchlistOpen: s.watchlistOpen,
    watchlistWidth: s.watchlistWidth,
    rightPanelOpen: s.rightPanelOpen,
  };
}
