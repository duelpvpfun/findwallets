import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/siteUrl";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Nothing here is useful to a crawler, and /recover takes a signature.
      disallow: ["/api/", "/admin", "/recover"],
    },
    sitemap: new URL("/sitemap.xml", SITE_URL).toString(),
  };
}
