// Traffic that is not a person.
//
// This matters more than it looks. Visitors are the denominator of every
// conversion rate in the scoreboard, so counting a crawler as a visit does not
// add noise evenly: it quietly makes every channel look worse, and the channels
// that attract the most crawling (an indexed landing page, a GitHub README link)
// look worst of all.

const BOT_PATTERN =
  /bot\b|bots\b|crawler|spider|crawl|slurp|facebookexternalhit|embedly|quora link preview|whatsapp|telegram|discordbot|slackbot|preview|monitor|uptime|pingdom|curl\/|wget\/|python-requests|python-urllib|scrapy|axios\/|node-fetch|go-http-client|okhttp|java\/|headlesschrome|phantomjs|lighthouse|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot/i;

/**
 * A missing user agent counts as a bot. Every real browser sends one, so the
 * blank case is a script that did not bother.
 */
export function isLikelyBot(userAgent: string | null | undefined): boolean {
  if (typeof userAgent !== 'string') return true;
  const value = userAgent.trim();
  if (!value) return true;
  return BOT_PATTERN.test(value);
}

/**
 * Whether a request is a real page load rather than a prefetch, an asset or a
 * client-side navigation payload.
 *
 * Next prefetches the register page as soon as a CTA scrolls into view, so
 * without this the funnel would show more signup starts than landing views.
 */
export function isCountableDocumentRequest(headers: Headers): boolean {
  if (headers.get('sec-purpose')?.includes('prefetch')) return false;
  if (headers.get('purpose') === 'prefetch') return false;
  if (headers.get('next-router-prefetch')) return false;
  // An RSC navigation is the same visitor moving inside the app, not a new view.
  if (headers.get('rsc')) return false;

  const dest = headers.get('sec-fetch-dest');
  if (dest) return dest === 'document';

  // Older browsers and anything behind a proxy that strips fetch metadata.
  return headers.get('accept')?.includes('text/html') ?? false;
}
