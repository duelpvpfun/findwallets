/** Canonical origin. NEXT_PUBLIC_SITE_URL wins so preview deploys can be pointed
 * at the production host; VERCEL_PROJECT_PRODUCTION_URL is the fallback. */
export const SITE_URL = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "https://www.alphawallets.fun")
);
