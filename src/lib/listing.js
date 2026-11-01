'use strict';
const { htmlToText, normalizeUrl, contentKeyFromUrl, parseUrl } = require('./util');
const { stripChrome } = require('./extract');

/**
 * Parses a PlacidWay listing page (articles, packages or Q&A answers, newest-modified first)
 * into candidate items. We match on URL *patterns* (/article/{id}/, /package/{id}/, /answer-detail/{id}/)
 * instead of CSS classes, so a redesign of the cards does not break extraction.
 *
 * @param {string} html
 * @param {string} pageUrl absolute URL of the listing page (used to resolve relative links)
 * @param {string} expectedType only keep links of this type (listings also link to other content in sidebars)
 */
function parseListing(html, pageUrl, expectedType) {
  const out = new Map();
  const anchorRe = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  let position = 0;
  const cleaned = stripChrome(String(html || ''));
  const page = parseUrl(pageUrl);
  const pageHost = page ? page.hostname : '';
  while ((m = anchorRe.exec(cleaned)) !== null) {
    const url = normalizeUrl(m[2].replace(/&amp;/g, '&'), pageUrl);
    if (!url) continue;
    const ck = contentKeyFromUrl(url, [pageHost]);
    if (!ck) continue;
    if (expectedType && ck.type !== expectedType) continue;
    const anchorText = htmlToText(m[3]);
    const existing = out.get(ck.key);
    if (existing) {
      // Same item linked twice (image + title); keep the most descriptive anchor text.
      if (anchorText.length > (existing.title_hint || '').length && anchorText.length < 300) existing.title_hint = anchorText;
      continue;
    }
    out.set(ck.key, {
      content_key: ck.key,
      type: ck.type,
      source_id: ck.id,
      url,
      slug: decodeURIComponent(url.split('/').pop() || ''),
      title_hint: anchorText.length >= 10 && anchorText.length < 300 ? anchorText : '',
      position: position++,
    });
  }
  return [...out.values()].map((c) => ({
    ...c,
    title_hint: c.title_hint || c.slug.replace(/[-_]+/g, ' ').trim(),
  }));
}

module.exports = { parseListing };
