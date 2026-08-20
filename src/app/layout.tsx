import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AccountProvider from "@/components/AccountProvider";
import VisitBeacon from "@/components/VisitBeacon";
import { SITE_URL } from "@/lib/siteUrl";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const TITLE = "Alpha Wallet Finder — top memecoin traders by realized PNL";
const DESCRIPTION =
  "Paste any Solana, BNB Chain or Base memecoin contract address to surface its top 500 trading wallets, their entry/exit prices, and realized PNL — exportable straight to your tracking bot.";

export const metadata: Metadata = {
  metadataBase: SITE_URL,
  title: { default: TITLE, template: "%s · Alpha Wallet Finder" },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Alpha Wallet Finder",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    creator: "@crypce0",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-neutral-950">
        {/* Wallet session, shared by the header, the paywall and /profile. One
            /api/auth/me call per page load rather than one per component. */}
        <AccountProvider>{children}</AccountProvider>
        <VisitBeacon />
      </body>
    </html>
  );
}
