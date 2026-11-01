'use strict';
const { decodeEntities, htmlToText, normalizeUrl, collapseWhitespace, contentKeyFromUrl, parseUrl } = require('./util');

/**
 * Extracts title, summary, featured image, body text and facts from a PlacidWay detail page.
 * Strategy (most to least reliable):
 *   1. Open Graph / meta tags the site publishes for social sharing (og:title, og:description, og:image,
 *      product price meta on packages). These are maintained for Facebook previews, so they are stable.
 *   2. JSON-LD blocks, if present (articleBody, FAQ answers).
 *   3. Main-content text blocks (h1-h4, p, li, table rows) after removing chrome (nav/header/footer/aside/
 *      forms/scripts) and stopping at "related/top packages" sections so sidebar prices never become "facts".
 * No external dependencies, so the exact same code runs in n8n and in the unit tests.
 */

function parseAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

function extractMeta(html) {
  const meta = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const a = parseAttributes(m[0]);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content !== undefined && meta[key] === undefined) meta[key] = collapseWhitespace(a.content);
  }
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const a = parseAttributes(m[0]);
    if ((a.rel || '').toLowerCase() === 'canonical' && a.href) meta['link:canonical'] = a.href;
  }
  const t = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (t) meta['html:title'] = htmlToText(t[1]);
  return meta;
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const stack = Array.isArray(parsed) ? parsed : [parsed];
      while (stack.length) {
        const node = stack.shift();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
        out.push(node);
      }
    } catch (e) { /* ignore malformed JSON-LD */ }
  }
  return out;
}

const CHROME_TAGS = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'header', 'nav', 'footer', 'aside', 'form', 'button', 'select'];

function stripChrome(html) {
  let h = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of CHROME_TAGS) {
    h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  // Elements whose class/id clearly marks them as navigation, modals or cookie banners.
  h = h.replace(/<(div|section|ul)\b[^>]*(?:class|id)\s*=\s*["'][^"']*\b(?:cookie|modal|popup|navbar|breadcrumb|footer|sidebar|newsletter|login|signup)\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return h;
}

const BOILERPLATE = new RegExp([
  'cookie', 'subscribe', 'newsletter', 'free quote', 'request (a )?(free )?(info|quote|call)', 'all rights reserved',
  'log ?in', 'sign ?up', 'whatsapp', 'privacy (policy|statement)', 'terms (and|&) conditions', '©', 'copyright',
  '\\+1[- ]?888', 'patients served', 'share (this|on)', 'click here', 'contact us', 'download (the )?app',
  'was this (article|answer) helpful', 'follow us',
].join('|'), 'i');

const END_MARKERS = /^(related|similar|you may also|people also (ask|read)|top (packages|clinics|doctors|experiences|destinations)|more (articles|packages|answers)|recent (articles|posts|answers)|popular|other (packages|treatments)|explore more|featured (clinics|packages))/i;

function extractBlocks(html) {
  const cleaned = stripChrome(html);
  const startIdx = (() => {
    const h1 = cleaned.search(/<h1\b/i);
    return h1 >= 0 ? h1 : 0;
  })();
  const body = cleaned.slice(startIdx);
  const blocks = [];
  const seen = new Set();
  const re = /<(h[1-4]|p|li|tr|blockquote|dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const tag = m[1].toLowerCase();
    let text;
    if (tag === 'tr') {
      const cells = [];
      const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let c;
      while ((c = cellRe.exec(m[2])) !== null) cells.push(htmlToText(c[2]));
      text = cells.filter(Boolean).join(' | ');
    } else {
      // skip containers that only wrap other blocks (e.g. <li><p>..</p></li>): inner blocks are captured separately
      if (/<(p|li|h[1-4]|table)\b/i.test(m[2])) continue;
      text = htmlToText(m[2]);
    }
    const isHeading = /^h[1-4]$/.test(tag);
    if (isHeading && END_MARKERS.test(text) && blocks.length >= 3) break;
    if (!text || text.length < (isHeading ? 6 : tag === 'tr' ? 5 : 25)) continue;
    if (text.length < 160 && BOILERPLATE.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({ tag, text });
  }
  return blocks;
}

function absolutize(url, base) {
  if (!url) return null;
  const u = parseUrl(url, base);
  return u ? u.href : null;
}

/** Generic site images (logos, listing banners, SVG icons) are not a featured image. */
function isUsableImage(url) {
  if (!url) return false;
  if (!/^https:\/\//i.test(url)) return false;
  if (/\.svg(\?|$)/i.test(url)) return false;
  if (/logo|favicon|placeholder|default[-_]image|\/frontend\/images\//i.test(url)) return false;
  return true;
}

/**
 * PlacidWay serves images through Cloudflare image resizing. If an og:image is a raw S3 URL we request the
 * 1200x630 padded rendition (Facebook's recommended link/photo size) through the same public endpoint the
 * site itself uses for og:image. Already-transformed URLs are left as they are.
 */
function facebookSizedImage(url, baseUrl) {
  if (!url) return null;
  if (/\/cdn-cgi\/image\//.test(url)) return url;
  if (/placidwaycdn\.s3\.amazonaws\.com/i.test(url)) {
    return `${baseUrl.replace(/\/+$/, '')}/cdn-cgi/image/quality=85,fit=pad,width=1200,height=630/${url}`;
  }
  return url;
}

function numbersIn(text) {
  const set = new Set();
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const n = m[0].replace(/,(?=\d{3}\b)/g, '').replace(/,$/, '');
    set.add(n.replace(/\.0+$/, ''));
  }
  return [...set];
}

/**
 * @param {string} html
 * @param {{url:string, type:string, statusCode?:number, baseUrl?:string, titleHint?:string}} ctx
 */
function extractPage(html, ctx) {
  const baseUrl = ctx.baseUrl || 'https://www.placidway.com';
  const meta = extractMeta(String(html || ''));
  const jsonld = extractJsonLd(String(html || ''));
  const blocks = extractBlocks(String(html || ''));

  const h1 = blocks.find((b) => b.tag === 'h1');
  const title = collapseWhitespace(meta['og:title'] || (h1 && h1.text) || meta['html:title'] || ctx.titleHint || '');
  const description = collapseWhitespace(meta['og:description'] || meta.description || meta['twitter:description'] || '');

  let image = absolutize(meta['og:image'] || meta['twitter:image'] || meta['og:image:url'] || '', ctx.url);
  const ldImage = jsonld.map((n) => (typeof n.image === 'string' ? n.image : n.image && (n.image.url || (Array.isArray(n.image) && n.image[0])))).find(Boolean);
  if (!isUsableImage(image) && ldImage) image = absolutize(typeof ldImage === 'string' ? ldImage : ldImage.url, ctx.url);
  const imageUrl = isUsableImage(image) ? facebookSizedImage(image, baseUrl) : null;

  const priceAmount = meta['product:price:amount'] || meta['og:price:amount'] || meta['product:price.amount']
    || Object.entries(meta).filter(([k]) => /price[:._]?amount/.test(k)).map(([, v]) => v)[0] || null;
  const priceCurrency = meta['product:price:currency'] || meta['og:price:currency']
    || Object.entries(meta).filter(([k]) => /price[:._]?currency/.test(k)).map(([, v]) => v)[0] || null;

  const ldText = jsonld
    .flatMap((n) => {
      const t = [];
      if (typeof n.articleBody === 'string') t.push(n.articleBody);
      if (n['@type'] === 'FAQPage' && Array.isArray(n.mainEntity)) {
        for (const q of n.mainEntity) {
          if (q && q.name) t.push(String(q.name));
          const a = q && q.acceptedAnswer && q.acceptedAnswer.text;
          if (a) t.push(htmlToText(a));
        }
      }
      return t;
    })
    .map(collapseWhitespace)
    .filter(Boolean);

  const blockText = blocks.map((b) => (/^h[1-4]$/.test(b.tag) ? `## ${b.text}` : b.text));
  const bodyParts = blockText.join('\n').length >= 400 ? blockText : [...blockText, ...ldText];
  let bodyText = bodyParts.join('\n');
  if (bodyText.length > 15000) bodyText = bodyText.slice(0, 15000);

  const published = meta['article:published_time'] || jsonld.map((n) => n.datePublished).find(Boolean) || null;
  const modified = meta['article:modified_time'] || meta['og:updated_time'] || jsonld.map((n) => n.dateModified).find(Boolean) || null;

  const priceLine = priceAmount ? `Package price listed on the page: from ${priceCurrency === 'USD' || !priceCurrency ? '$' : priceCurrency + ' '}${Number(priceAmount).toLocaleString('en-US')}` : '';
  const factsCorpus = [title, description, priceLine, bodyText].filter(Boolean).join('\n');
  const ck = contentKeyFromUrl(ctx.url) || {};

  return {
    url: normalizeUrl(ctx.url),
    content_key: ck.key || null,
    type: ctx.type || ck.type || 'page',
    title,
    summary: description,
    image_url: imageUrl,
    image_source: imageUrl ? 'og:image' : null,
    canonical: meta['link:canonical'] || null,
    published_at: published,
    modified_at: modified,
    price: priceAmount ? { amount: Number(priceAmount), currency: priceCurrency || 'USD' } : null,
    body_text: bodyText,
    facts_corpus: factsCorpus,
    source_numbers: numbersIn(factsCorpus),
    word_count: bodyText.split(/\s+/).filter(Boolean).length,
    block_count: blocks.length,
  };
}

/** Returns a list of reasons the page is unusable (empty list = usable). */
function validateContent(content, { statusCode, minBodyChars }) {
  const problems = [];
  if (statusCode && (statusCode < 200 || statusCode >= 300)) problems.push(`HTTP ${statusCode}`);
  if (!content.title || content.title.length < 10) problems.push('missing title');
  if ((content.body_text || '').length < (minBodyChars || 400)) problems.push(`body too short (${(content.body_text || '').length} chars)`);
  if (/page not found|404|error/i.test(content.title || '') && (content.body_text || '').length < 1500) problems.push('looks like an error page');
  return problems;
}

/** Text the LLM sees: the most useful part of the page within a token budget. */
function llmContext(content, maxChars) {
  const limit = maxChars || 7000;
  const head = [
    `TITLE: ${content.title}`,
    content.summary ? `SUMMARY: ${content.summary}` : null,
    content.price ? `LISTED PRICE: from ${content.price.currency === 'USD' ? '$' : content.price.currency + ' '}${content.price.amount.toLocaleString('en-US')}` : null,
    `CONTENT TYPE: ${content.type}`,
    `URL: ${content.url}`,
    'BODY:',
  ].filter(Boolean).join('\n');
  const room = Math.max(1000, limit - head.length);
  const body = content.body_text.length > room ? content.body_text.slice(0, room) + '\n[...truncated]' : content.body_text;
  return `${head}\n${body}`;
}

module.exports = {
  extractPage, validateContent, llmContext, extractMeta, extractBlocks, extractJsonLd, numbersIn,
  isUsableImage, facebookSizedImage, stripChrome,
};
