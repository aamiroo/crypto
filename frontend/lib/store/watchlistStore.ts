import { create } from "zustand";
import { loadPersisted, persist } from "@/lib/store/persist";

const KEY = "ct_favorites";
const DEFAULT_FAVORITES = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

interface WatchlistStore {
  favorites: string[];
  isFavorite: (symbol: string) => boolean;
  toggleFavorite: (symbol: string) => void;
  addFavorite: (symbol: string) => void;
  removeFavorite: (symbol: string) => void;
  reset: () => void;
}

export const useWatchlistStore = create<WatchlistStore>((set, get) => ({
  favorites: loadPersisted<string[]>(KEY, DEFAULT_FAVORITES),

  isFavorite: (symbol) => get().favorites.includes(symbol),

  toggleFavorite: (symbol) =>
    set((s) => {
      const favorites = s.favorites.includes(symbol)
        ? s.favorites.filter((x) => x !== symbol)
        : [...s.favorites, symbol];
      persist(KEY, favorites);
      return { favorites };
    }),

  addFavorite: (symbol) =>
    set((s) => {
      if (s.favorites.includes(symbol)) return {};
      const favorites = [...s.favorites, symbol];
      persist(KEY, favorites);
      return { favorites };
    }),

  removeFavorite: (symbol) =>
    set((s) => {
      const favorites = s.favorites.filter((x) => x !== symbol);
      persist(KEY, favorites);
      return { favorites };
    }),

  reset: () => {
    persist(KEY, DEFAULT_FAVORITES);
    set({ favorites: DEFAULT_FAVORITES });
  },
}));
