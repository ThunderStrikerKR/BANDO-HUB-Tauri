import type { CatalogReport, OfficialLink } from "./types.js";

const validCachedOfficialUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !["bandostand.com", "www.bandostand.com", "bandomall.co.kr", "www.bandomall.co.kr"]
        .includes(url.hostname)) return false;
    const segments = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/product/detail.html") {
      const ids = url.searchParams.getAll("product_no");
      return ids.length === 1 && /^[0-9]+$/.test(ids[0]);
    }
    return segments.length >= 3 && segments[0] === "product" &&
      segments[1] !== "detail.html" && /^[0-9]+$/.test(segments[2]);
  } catch {
    return false;
  }
};

/**
 * This list is derived only from the BUNDLED 2026-11-01 catalog snapshot.
 * It does not crawl the live website. The user must fetch an individual
 * detail URL separately to see current official prices.
 */
export function officialLinksFromSnapshot(report: CatalogReport): OfficialLink[] {
  const seen = new Set<string>();
  const links: OfficialLink[] = [];
  for (const product of report.products) {
    if (!product.siteId || !product.name.trim()) continue;
    const url = product.variants
      .map(variant => variant.url?.trim() || "")
      .find(validCachedOfficialUrl);
    if (!url) continue;
    const parsed = new URL(url);
    const productNumber = parsed.pathname === "/product/detail.html"
      ? parsed.searchParams.get("product_no")
      : parsed.pathname.split("/").filter(Boolean)[2];
    if (product.siteId !== productNumber) continue;
    // Deduplicate multiple color or size options for the same official item.
    const siteKey = parsed.hostname.replace(/^www\./, "") + "|" + productNumber;
    if (seen.has(siteKey)) continue;
    seen.add(siteKey);
    links.push({ name: product.name.trim(), url });
  }
  return links.sort((a,b) => a.name.localeCompare(b.name, "ko"));
}
