import { create } from "zustand";
import type { ThemeName } from "@/lib/types";

interface ThemeState {
  theme: ThemeName;
  toggle: () => void;
  setTheme: (t: ThemeName) => void;
}

function getInitial(): ThemeName {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem("theme") as ThemeName | null;
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(t: ThemeName) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", t);
  document.documentElement.classList.toggle("dark", t === "dark");
  document.documentElement.classList.toggle("light", t === "light");
  localStorage.setItem("theme", t);
}

// Apply on import (module level for SSR safety)
if (typeof window !== "undefined") {
  const t = getInitial();
  requestAnimationFrame(() => applyTheme(t));
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: typeof window !== "undefined" ? getInitial() : "dark",
  toggle: () => set((s) => {
    const next = s.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    return { theme: next };
  }),
  setTheme: (theme) => { applyTheme(theme); set({ theme }); },
}));
