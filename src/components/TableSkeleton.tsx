/** Placeholder rows while a scan runs. A centered spinner gave no sense of what
 * was coming or how much of it. */
export default function TableSkeleton({ rows = 8, note }: { rows?: number; note?: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/40">
      <div className="flex items-center gap-3 border-b border-neutral-800/80 px-4 py-4 sm:px-5">
        <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-neutral-800 sm:h-11 sm:w-11" />
        <div className="flex-1 space-y-2">
          <div className="h-3.5 w-40 animate-pulse rounded bg-neutral-800" />
          <div className="h-2.5 w-24 animate-pulse rounded bg-neutral-800/70" />
        </div>
      </div>

      <div className="grid grid-cols-3 divide-x divide-neutral-800/80 border-b border-neutral-800/80 bg-neutral-950/40">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2 px-3 py-3 sm:px-5">
            <div className="h-2.5 w-20 animate-pulse rounded bg-neutral-800/70" />
            <div className="h-3.5 w-16 animate-pulse rounded bg-neutral-800" />
          </div>
        ))}
      </div>

      <div className="divide-y divide-neutral-900/70">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-4 sm:px-5">
            <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded bg-neutral-800" />
            <div className="h-3.5 w-6 shrink-0 animate-pulse rounded bg-neutral-800" />
            <div className="h-3.5 flex-1 animate-pulse rounded bg-neutral-800/80" />
            <div className="hidden h-3.5 w-16 animate-pulse rounded bg-neutral-800/60 sm:block" />
            <div className="h-3.5 w-20 shrink-0 animate-pulse rounded bg-neutral-800" />
          </div>
        ))}
      </div>

      {note && <p className="px-4 py-3 text-center text-xs text-neutral-600 sm:px-5">{note}</p>}
    </div>
  );
}
