/**
 * ClawPulse — Source Validator
 *
 * Uses crawlee CheerioCrawler to scrape source URLs and OpenAI to assess credibility.
 * The app IS an OpenClaw instance — LLM validation always runs.
 */

import { CheerioCrawler, Configuration } from "crawlee";
import OpenAI from "openai";
import { VALID_CATEGORIES, type Category, type ValidationResult } from "./types.js";

const validCategorySet = new Set<string>(VALID_CATEGORIES);

let openai: OpenAI;

export function initValidator(): void {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

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

/** Validate a breaking story submission */
export async function validateStory(input: {
  headline: string;
  summary: string;
  category: string;
  sourceUrls: string[];
}): Promise<ValidationResult> {
  const { headline, summary, category, sourceUrls } = input;

  // Basic field checks
  if (!headline || headline.length < 10) {
    return { valid: false, notes: "Headline must be at least 10 characters." };
  }
  if (!summary || summary.length < 20) {
    return { valid: false, notes: "Summary must be at least 20 characters." };
  }
  if (!validCategorySet.has(category)) {
    return {
      valid: false,
      notes: `Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`,
    };
  }
  if (!sourceUrls || sourceUrls.length === 0) {
    return { valid: false, notes: "At least one source URL is required." };
  }

  // Scrape source URLs
  let scraped: Map<string, string>;
  try {
    scraped = await scrapeUrls(sourceUrls);
  } catch {
    return {
      valid: false,
      notes: "Failed to scrape source URLs. Please retry.",
    };
  }

  // Check if any URLs were reachable
  const reachableContent = [...scraped.values()].filter((v) => v.length > 0);
  if (reachableContent.length === 0) {
    return {
      valid: false,
      notes: "None of the provided source URLs were reachable.",
    };
  }

  // Build scraped content summary for LLM
  const scrapedSummary = [...scraped.entries()]
    .map(
      ([url, content]) =>
        `URL: ${url}\n${content || "(unreachable)"}`,
    )
    .join("\n---\n");

  // LLM credibility assessment
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `You are a news credibility assessor for ClawPulse, a breaking news intelligence feed. Evaluate whether a submitted story appears credible based on the headline, summary, and scraped source content.

Respond with ONLY valid JSON (no markdown, no code fences):
{"credible": true/false, "confidence": 0.0-1.0, "reasoning": "brief explanation"}

Be reasonable — if the sources are major news outlets and the content relates to the headline, it is likely credible. Reject stories that are clearly fabricated, have no supporting source content, or where sources contradict the claims.`,
        },
        {
          role: "user",
          content: `HEADLINE: ${headline}
SUMMARY: ${summary}
CATEGORY: ${category}

SCRAPED SOURCES:
${scrapedSummary}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() || "";
    const assessment = JSON.parse(raw) as {
      credible: boolean;
      confidence: number;
      reasoning: string;
    };

    if (assessment.credible) {
      return {
        valid: true,
        notes: `Validated (confidence: ${assessment.confidence}). ${assessment.reasoning}`,
      };
    } else {
      return {
        valid: false,
        notes: `Rejected: ${assessment.reasoning}`,
      };
    }
  } catch {
    return {
      valid: false,
      notes: "Validation service unavailable, please retry.",
    };
  }
}
