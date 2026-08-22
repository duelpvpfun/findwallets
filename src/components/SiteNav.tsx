import Link from "next/link";

/**
 * The site's two halves, as tabs, in the middle of every header.
 *
 * The feed used to be a link tucked in beside the wallet button, which read as
 * an aside. It is one of the two things this site does — scan a token, or watch
 * the wallets buy in real time — so it belongs in the navigation, in the middle,
 * with the current section marked. A visitor who lands on one should be able to
 * see the other exists without reading the page.
 *
 * A plain server component taking the active tab as a prop rather than reading
 * `usePathname`: the feed page is server-rendered, and a hook here would make
 * the whole header a client component for information the page already knows.
 *
 * The live dot sits on the feed tab whether or not it is active — it is a
 * property of the feed, not a selection state.
 */
export default function SiteNav({ active }: { active: "scan" | "feed" }) {
  return (
    <nav
      aria-label="Sections"
      className="flex shrink-0 items-center gap-1 rounded-full border border-neutral-800 bg-neutral-900/60 p-1"
    >
      <Tab href="/" label="Scan" active={active === "scan"} />
      <Tab
        href="/feed"
        label="Live feed"
        shortLabel="Feed"
        live
        active={active === "feed"}
      />
    </nav>
  );
}

function Tab({
  href,
  label,
  shortLabel,
  live = false,
  active,
}: {
  href: string;
  label: string;
  shortLabel?: string;
  live?: boolean;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold transition-colors sm:px-3.5 ${
        active
          ? "bg-neutral-800 text-neutral-50"
          : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-100"
      }`}
    >
      {live && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-live-pulse" />}
      {shortLabel ? (
        <>
          <span className="sm:hidden">{shortLabel}</span>
          <span className="hidden sm:inline">{label}</span>
        </>
      ) : (
        label
      )}
    </Link>
  );
}
