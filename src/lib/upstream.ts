// Solana Tracker and Birdeye both throw an Error carrying an optional upstream
// status, so the routes can translate either without branching on the chain.
type UpstreamError = Error & { status?: number };

function isUpstreamError(err: unknown): err is UpstreamError {
  return err instanceof Error && "status" in err;
}

export function upstreamMessage(err: unknown, fallback = "Failed to fetch trader data."): string {
  return isUpstreamError(err) ? err.message : fallback;
}

export function upstreamStatus(err: unknown): number {
  return (isUpstreamError(err) && err.status) || 502;
}
