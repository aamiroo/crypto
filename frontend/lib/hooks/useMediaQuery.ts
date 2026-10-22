"use client";

import { useEffect, useState } from "react";

/** SSR-safe media query hook. Returns false during SSR / first paint. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mrl = window.matchMedia(query);
    const update = () => setMatches(mrl.matches);
    update();
    mrl.addEventListener("change", update);
    return () => mrl.removeEventListener("change", update);
  }, [query]);

  return matches;
}

export const DESKTOP_QUERY = "(min-width: 1100px)";
