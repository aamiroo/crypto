import { create } from "zustand";

export type MobilePanel = "none" | "watchlist" | "book";

interface UiState {
  shortcutsOpen: boolean;
  alertsOpen: boolean;
  /** Which side drawer is open on small screens (CSS hides drawers otherwise). */
  mobilePanel: MobilePanel;
  setShortcutsOpen: (o: boolean) => void;
  setAlertsOpen: (o: boolean) => void;
  toggleShortcuts: () => void;
  setMobilePanel: (p: MobilePanel) => void;
}

export const useUiStore = create<UiState>((set) => ({
  shortcutsOpen: false,
  alertsOpen: false,
  mobilePanel: "none",
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setAlertsOpen: (alertsOpen) => set({ alertsOpen }),
  toggleShortcuts: () => set((s) => ({ shortcutsOpen: !s.shortcutsOpen })),
  setMobilePanel: (mobilePanel) => set({ mobilePanel }),
}));
