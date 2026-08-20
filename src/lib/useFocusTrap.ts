"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Keeps Tab inside a modal and restores focus to whatever opened it.
 *
 * Written by hand rather than pulled in as a dependency: this is the only modal
 * in the app that needs it, and `inert` on the rest of the page is not yet
 * reliable enough across the mobile browsers this product's users are on.
 *
 * The element list is re-read on every Tab rather than cached, because these
 * dialogs swap their contents (carousel panels, payment states) while open.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const previous = document.activeElement as HTMLElement | null;

    // Focus the container itself rather than its first control: landing on
    // "Next" means a screen reader starts mid-dialog with no idea what it is.
    if (!container.contains(document.activeElement)) container.focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const items = Array.from(container!.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;

      if (event.shiftKey && (current === first || current === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      // Guard against restoring focus to a node that has since been removed.
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [ref, active]);
}
