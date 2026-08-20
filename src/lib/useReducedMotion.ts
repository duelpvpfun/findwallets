"use client";

import { useMediaQuery } from "./useMediaQuery";

/**
 * True when the visitor has asked their OS for less animation.
 *
 * The CSS in globals.css already disables every keyframe under
 * `prefers-reduced-motion`, but timers are not CSS: an auto-advancing carousel
 * or a staged row reveal would keep moving the page under someone who asked it
 * not to. Anything driven by JS has to read this.
 *
 * Defaults to `false` during SSR, matching `useMediaQuery` — the first client
 * render corrects it before any timer is armed.
 */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
