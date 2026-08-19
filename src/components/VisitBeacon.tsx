"use client";

import { useEffect } from "react";

/**
 * Records a page view for the owner dashboard. Fires after paint and ignores
 * failures, so analytics can never delay or break the page. /admin is excluded
 * so the owner's own visits don't pollute the numbers.
 */
export default function VisitBeacon() {
  useEffect(() => {
    const path = window.location.pathname;
    if (path.startsWith("/admin")) return;

    const controller = new AbortController();
    void fetch("/api/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
      signal: controller.signal,
      keepalive: true,
    }).catch(() => {});

    return () => controller.abort();
  }, []);

  return null;
}
