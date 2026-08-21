import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/siteUrl";
import { alertsArePublic } from "@/lib/alerts/config";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL.toString(),
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    // Only once the page is actually public. Listing an owner-only page would
    // invite a crawler to a 404 and waste the crawl budget on it.
    ...(alertsArePublic()
      ? [
          {
            url: new URL("/feed", SITE_URL).toString(),
            lastModified: new Date(),
            changeFrequency: "hourly" as const,
            priority: 0.8,
          },
        ]
      : []),
  ];
}
