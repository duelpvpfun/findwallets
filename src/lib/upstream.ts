// Solana Tracker and Birdeye both throw an Error carrying an optional upstream
// status, so the routes can translate either without branching on the chain.
type UpstreamError = Error & { status?: number };

function isUpstreamError(err: unknown): err is UpstreamError {
  return err instanceof Error && "status" in err;
}

/**
 * Never returns the upstream body: those messages name the provider, endpoint and
 * plan/quota state, which is free reconnaissance for anyone probing the API. The
 * detail is logged server-side instead.
 */
export function upstreamMessage(err: unknown, fallback = "Failed to fetch trader data."): string {
  if (!isUpstreamError(err)) return fallback;
  const status = err.status ?? 502;
  if (status === 404) return "That token wasn't found. Check the contract address and chain.";
  if (status === 429) return "The data provider is rate limiting us. Try again in a moment.";
  if (status >= 500) return "The data provider is having problems. Try again shortly.";
  return fallback;
}

export function upstreamStatus(err: unknown): number {
  return (isUpstreamError(err) && err.status) || 502;
}
