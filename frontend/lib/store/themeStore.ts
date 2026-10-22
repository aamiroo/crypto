import { create } from "zustand";
import type { ThemeName } from "@/lib/types";

interface ThemeState {
  theme: ThemeName;
  toggle: () => void;
  setTheme: (t: ThemeName) => void;
}

/** Resolve the initial theme: trust a stored value only when it is one of the
 *  known names, otherwise honour the OS `prefers-color-scheme`; SSR -> dark. */
function getInitial(): ThemeName {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem("theme") as ThemeName | null;
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** One switch updates every representation at once: the `[data-theme]` attr that
 *  drives the CSS palette, the dark/light class mirroring the SSR <html>, and
 *  localStorage so a reload starts on the chosen theme. */
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
