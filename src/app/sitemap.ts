import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/siteUrl";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL.toString(),
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
  ];
}
