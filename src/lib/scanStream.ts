"use client";

import type { ScanEvent, ScanResult, TokenMeta } from "./types";

/**
 * Reads the NDJSON stream from `/api/top-traders?stream=1`, reporting progress
 * as pages arrive and resolving with the final result line. Falls back to
 * parsing the whole body as JSON if the server answered without streaming.
 *
 * `onToken` fires as soon as the token resolves, well before any trader page.
 * The server has always sent that line and this function used to drop it, so a
 * buyer scanning a second coin sat looking at the FIRST coin's name, logo and
 * table for the whole scan — which reads as "it ignored me", or worse, as
 * cached data they just paid for.
 */
export async function consumeScanStream(
  res: Response,
  onProgress: (found: number, requested: number) => void,
  onToken?: (token: TokenMeta) => void
): Promise<ScanResult | { error: string }> {
  const isNdjson = res.headers.get("content-type")?.includes("ndjson");
  if (!isNdjson || !res.body) {
    return (await res.json()) as ScanResult | { error: string };
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let result: ScanResult | { error: string } | null = null;

  function handleLine(line: string) {
    if (!line.trim()) return;
    let event: ScanEvent;
    try {
      event = JSON.parse(line) as ScanEvent;
    } catch {
      return;
    }
    if (event.type === "token") onToken?.(event.token);
    else if (event.type === "progress") onProgress(event.found, event.requested);
    else if (event.type === "result") result = event.result;
    else if (event.type === "error") result = { error: event.error };
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  handleLine(buffer);

  // The stream closed without a terminal line — the function was killed.
  return result ?? { error: "The scan was interrupted. Please try again." };
}
