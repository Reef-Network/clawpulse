/**
 * ClawPulse — Twitter Integration
 *
 * Conditional module — only initializes if all 4 OAuth env vars are present.
 * If disabled, all exports are safe no-ops.
 */

import { TwitterApi } from "twitter-api-v2";

let client: TwitterApi | null = null;

export function isTwitterEnabled(): boolean {
  return client !== null;
}

export function initTwitter(): boolean {
  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    console.log("[twitter] Disabled — missing env vars");
    return false;
  }

  client = new TwitterApi({
    appKey: apiKey,
    appSecret: apiSecret,
    accessToken,
    accessSecret,
  });

  console.log("[twitter] Enabled");
  return true;
}

export async function postTweet(text: string): Promise<string | null> {
  if (!client) return null;
  const result = await client.v2.tweet(text);
  return result.data.id;
}
