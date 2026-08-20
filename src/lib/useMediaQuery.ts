"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * SSR-safe `matchMedia`. Used to mount either the table or the card list rather
 * than rendering both and hiding one with CSS — at Top 500 that was ~1000 live
 * row subtrees, which is what made a single state update block the main thread.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query]
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  // The server can't know the viewport; false means the card list renders first
  // and the table swaps in on hydration for wide screens.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
