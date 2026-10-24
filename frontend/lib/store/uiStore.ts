import { create } from "zustand";
import { loadPersisted, persist } from "@/lib/store/persist";

export type MobilePanel = "none" | "watchlist" | "book";

interface UiState {
  shortcutsOpen: boolean;
  alertsOpen: boolean;
  /** Which side drawer is open on small screens (CSS hides drawers otherwise). */
  mobilePanel: MobilePanel;
  /** Floating drawings list over the chart. Persisted: a user who keeps it open
   *  would otherwise have to reopen it after every reload. */
  drawingsOpen: boolean;
  setShortcutsOpen: (o: boolean) => void;
  setAlertsOpen: (o: boolean) => void;
  toggleShortcuts: () => void;
  setMobilePanel: (p: MobilePanel) => void;
  setDrawingsOpen: (o: boolean) => void;
  toggleDrawings: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  shortcutsOpen: false,
  alertsOpen: false,
  mobilePanel: "none",
  drawingsOpen: loadPersisted<boolean>("ct_draw_panel", false, (v): v is boolean => typeof v === "boolean"),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setAlertsOpen: (alertsOpen) => set({ alertsOpen }),
  toggleShortcuts: () => set((s) => ({ shortcutsOpen: !s.shortcutsOpen })),
  setMobilePanel: (mobilePanel) => set({ mobilePanel }),
  setDrawingsOpen: (drawingsOpen) => { persist("ct_draw_panel", drawingsOpen); set({ drawingsOpen }); },
  toggleDrawings: () =>
    set((s) => {
      const drawingsOpen = !s.drawingsOpen;
      persist("ct_draw_panel", drawingsOpen);
      return { drawingsOpen };
    }),
}));
