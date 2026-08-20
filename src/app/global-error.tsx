"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/** Replaces the root layout entirely, so it has to ship its own <html>/<body>
 * and can't rely on any of the app's providers or global styles. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.75rem",
          background: "#0a0a0a",
          color: "#f5f5f5",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          padding: "1rem",
        }}
      >
        <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>
          Something broke on our end
        </h1>
        <p style={{ maxWidth: "28rem", fontSize: "0.875rem", color: "#a3a3a3", margin: 0 }}>
          The error has been reported. If you had just paid for a scan, recover your claim token at
          /recover with your transaction signature.
        </p>
        <button
          onClick={reset}
          style={{
            marginTop: "0.75rem",
            borderRadius: "0.75rem",
            border: "none",
            background: "#2563eb",
            color: "#fff",
            padding: "0.625rem 1.25rem",
            fontSize: "0.875rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
