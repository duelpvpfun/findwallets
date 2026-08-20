import type { ErrorEvent } from "@sentry/nextjs";

/**
 * Anything here would let whoever reads an event redeem someone else's purchase
 * or sign in as them. `signature` covers both a payment transaction id and a
 * sign-in signature; `aw_user` is the session cookie, which is a bearer
 * credential for a whole account.
 */
const SECRET_QUERY_PARAMS = ["claim", "claimToken", "nonce", "key", "signature"];
const SECRET_HEADERS = [
  "x-owner-key",
  "x-claim-token",
  "x-scan-session",
  "authorization",
  "cookie",
  "set-cookie",
];

/** Request-body / extra-context keys carrying the same secrets. */
const SECRET_BODY_KEYS = ["claimToken", "nonce", "signature", "aw_user", "aw_admin"];

const REDACTED = "[redacted]";

function scrubUrl(url: string): string {
  try {
    // A relative URL still needs a base to parse; the origin is discarded below
    // when the input was relative.
    const parsed = new URL(url, "https://scrub.invalid");
    let touched = false;
    for (const param of SECRET_QUERY_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, REDACTED);
        touched = true;
      }
    }
    if (!touched) return url;
    return url.startsWith("http") ? parsed.toString() : parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

/**
 * Strips claim tokens, nonces and owner keys from every event before it leaves
 * the process. A leaked claim token in an error report is a free scan for
 * whoever reads it.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  if (event.request) {
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    if (event.request.query_string && typeof event.request.query_string === "object") {
      for (const param of SECRET_QUERY_PARAMS) {
        if (param in event.request.query_string) {
          (event.request.query_string as Record<string, string>)[param] = REDACTED;
        }
      }
    } else if (typeof event.request.query_string === "string") {
      event.request.query_string = scrubUrl(`?${event.request.query_string}`).replace(/^\?/, "");
    }
    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        if (SECRET_HEADERS.includes(name.toLowerCase())) {
          event.request.headers[name] = REDACTED;
        }
      }
    }
    delete event.request.cookies;

    // A sign-in POSTs `{ wallet, nonce, signature }`, so the body carries a
    // replayable credential even though the URL doesn't.
    if (event.request.data && typeof event.request.data === "object") {
      const data = event.request.data as Record<string, unknown>;
      for (const key of SECRET_BODY_KEYS) {
        if (key in data) data[key] = REDACTED;
      }
    }
  }

  if (event.extra) {
    for (const key of SECRET_BODY_KEYS) {
      if (key in event.extra) event.extra[key] = REDACTED;
    }
  }

  for (const crumb of event.breadcrumbs ?? []) {
    if (typeof crumb.data?.url === "string") crumb.data.url = scrubUrl(crumb.data.url);
  }

  return event;
}
