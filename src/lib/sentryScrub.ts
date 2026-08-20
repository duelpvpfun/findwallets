import type { ErrorEvent } from "@sentry/nextjs";

/** Anything here would let whoever reads an event redeem someone else's purchase. */
const SECRET_QUERY_PARAMS = ["claim", "claimToken", "nonce", "key"];
const SECRET_HEADERS = ["x-owner-key", "x-claim-token", "x-scan-session", "authorization", "cookie"];

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
  }

  for (const crumb of event.breadcrumbs ?? []) {
    if (typeof crumb.data?.url === "string") crumb.data.url = scrubUrl(crumb.data.url);
  }

  return event;
}
