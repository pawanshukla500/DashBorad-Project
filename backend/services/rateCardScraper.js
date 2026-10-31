/**
 * Deprecated legacy scraper.
 *
 * The former implementation supplied fabricated fee rows and wrote them
 * directly to PostgreSQL. Rate cards are now read by the authenticated
 * desktop worker, staged locally, compared through the backend API, and
 * published only after operator review.
 */
export async function scrapeRateCard() {
  return {
    success: false,
    error: 'Direct backend scraping is disabled. Use the desktop worker extraction and review workflow.'
  };
}
