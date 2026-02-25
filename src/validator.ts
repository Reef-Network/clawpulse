/**
 * ClawPulse — Source Scraper
 *
 * Uses crawlee CheerioCrawler to scrape source URLs.
 * Editorial decisions are made by the coordinator agent, not the API.
 */

import { CheerioCrawler, Configuration } from "crawlee";

/** Scrape URLs via crawlee and return a map of URL → extracted text */
export async function scrapeUrls(urls: string[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  const config = new Configuration({ persistStorage: false });

  const crawler = new CheerioCrawler(
    {
      maxConcurrency: 3,
      requestHandlerTimeoutSecs: 15,
      maxRequestRetries: 0,
      requestHandler: async ({ request, $ }) => {
        const title = $("title").text().trim();
        const metaDesc =
          $('meta[name="description"]').attr("content")?.trim() || "";

        // Extract body text, stripping scripts/styles
        $("script, style, nav, footer, header").remove();
        const bodyText = $("body").text().replace(/\s+/g, " ").trim();

        const content = [
          title ? `Title: ${title}` : "",
          metaDesc ? `Description: ${metaDesc}` : "",
          bodyText.slice(0, 2000),
        ]
          .filter(Boolean)
          .join("\n");

        results.set(request.url, content);
      },
      failedRequestHandler: async ({ request }) => {
        results.set(request.url, "");
      },
    },
    config,
  );

  await crawler.run(urls.map((url) => ({ url })));

  return results;
}
