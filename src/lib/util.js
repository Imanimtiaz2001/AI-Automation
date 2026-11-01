'use strict';
/**
 * Small, dependency-free helpers shared by every Code node.
 * This file is inlined into n8n Code nodes by scripts/build-workflows.js,
 * so it must not require anything outside src/lib.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', eacute: 'é', aacute: 'á', iacute: 'í', oacute: 'ó',
  uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', deg: '°',
  euro: '€', pound: '£', yen: '¥', times: '×', frac12: '½', rarr: '→', larr: '←',
};

function decodeEntities(str) {
  if (!str) return '';
  return String(str).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return m;
      try { return String.fromCodePoint(n); } catch (e) { return m; }
    }
    const v = NAMED_ENTITIES[code.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function collapseWhitespace(str) {
  return String(str || '').replace(/[\s ​]+/g, ' ').trim();
}

/** Strip tags and decode entities, producing a single clean line of text. */
function htmlToText(html) {
  return collapseWhitespace(
    decodeEntities(
      String(html || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

/**
 * Minimal URL parser/resolver. n8n's Code-node sandbox (task runner) has no global `URL`, so we cannot
 * rely on it. Handles absolute, protocol-relative, root-relative and relative references.
 * @returns {{protocol:string, hostname:string, port:string, host:string, origin:string, pathname:string, search:string, hash:string, href:string}|null}
 */
function parseUrl(raw, base) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const ABS = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/;
  let m = s.match(ABS);
  if (!m) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return null; // mailto:, javascript:, data: ...
    const b = parseUrl(base);
    if (!b) return null;
    if (s.startsWith('//')) s = `${b.protocol}${s}`;
    else if (s.startsWith('/')) s = `${b.origin}${s}`;
    else if (s.startsWith('?')) s = `${b.origin}${b.pathname}${s}`;
    else if (s.startsWith('#')) s = `${b.origin}${b.pathname}${b.search}${s}`;
    else s = `${b.origin}${b.pathname.replace(/[^/]*$/, '')}${s}`;
    m = s.match(ABS);
    if (!m) return null;
  }
  const protocol = m[1].toLowerCase() + ':';
  const authority = m[2].replace(/^.*@/, '');
  const hm = authority.match(/^(\[[^\]]+\]|[^:]*)(?::(\d*))?$/);
  if (!hm || !hm[1]) return null;
  const hostname = hm[1].toLowerCase();
  const defaultPort = (protocol === 'https:' && hm[2] === '443') || (protocol === 'http:' && hm[2] === '80');
  const port = hm[2] && !defaultPort ? hm[2] : '';
  // normalise dot segments
  const segs = [];
  for (const seg of (m[3] || '/').split('/')) {
    if (seg === '..') { if (segs.length > 1) segs.pop(); } else if (seg !== '.') segs.push(seg);
  }
  let pathname = segs.join('/');
  if (!pathname.startsWith('/')) pathname = '/' + pathname;
  const search = m[4] && m[4] !== '?' ? m[4] : '';
  const hash = m[5] && m[5] !== '#' ? m[5] : '';
  const host = hostname + (port ? `:${port}` : '');
  const origin = `${protocol}//${host}`;
  return { protocol, hostname, port, host, origin, pathname, search, hash, href: origin + pathname + search + hash };
}

/** Lower-cased host, no fragment, no query, no trailing slash. Path case is preserved. */
function normalizeUrl(raw, base) {
  if (!raw) return null;
  const u = parseUrl(raw, base);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  const protocol = /(^|\.)placidway\.com$/.test(u.hostname) ? 'https:' : u.protocol; // the live site is HTTPS-only
  return `${protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** Map a PlacidWay URL to a stable content key such as "article:4617" (slug/subdomain independent). */
const CONTENT_PATTERNS = [
  { type: 'article', re: /\/article\/(\d+)(?:\/|$)/i },
  { type: 'package', re: /\/package\/(\d+)(?:\/|$)/i },
  { type: 'answer', re: /\/answer-detail\/(\d+)(?:\/|$)/i },
];

function contentKeyFromUrl(url, extraHosts) {
  if (!url) return null;
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname;
  const allowed = /(^|\.)placidway\.com$/.test(host) || (extraHosts || []).includes(host);
  if (!allowed) return null;
  for (const p of CONTENT_PATTERNS) {
    const m = url.match(p.re);
    if (m) return { type: p.type, id: m[1], key: `${p.type}:${m[1]}` };
  }
  return null;
}

/** Postgres parameters are passed as one base64 JSON blob: immune to the comma-splitting of
 *  "Query Parameters" and to SQL injection; decoded in SQL with convert_from(decode($1,'base64'),'UTF8')::jsonb */
function toB64Json(obj) {
  const json = JSON.stringify(obj);
  if (typeof Buffer !== 'undefined') return Buffer.from(json, 'utf8').toString('base64');
  return btoa(unescape(encodeURIComponent(json)));
}

function escapeTelegramHtml(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeTelegramHtml(str).replace(/"/g, '&quot;');
}

function truncate(str, max) {
  const s = String(str || '');
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…';
}

/** Character count as Facebook / humans see it (code points, not UTF-16 units). */
function charLength(str) {
  return [...String(str || '')].length;
}

/** Lower-case, unify quotes/dashes, strip punctuation except digits/letters, collapse spaces. */
function normalizeForMatch(str) {
  return collapseWhitespace(
    String(str || '')
      .toLowerCase()
      .replace(/[‘’`´]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[‐‑‒–—―]/g, '-')
      .replace(/(\d),(\d{3})/g, '$1$2')
      .replace(/[^a-z0-9$%.\-' ]+/g, ' ')
      .replace(/(\D)\.|\.(\D|$)/g, '$1 $2')
  );
}

/** Pulls the provider's own error text out of n8n's wrapped messages like 400 - "{\"error\":{\"message\":\"...\"}}". */
function innerApiMessage(error) {
  const flat = typeof error === 'string' ? error : JSON.stringify(error || {});
  const msgs = [...flat.matchAll(/\\*"message\\*"\s*:\s*\\*"((?:[^"\\]|\\[^"])*)/g)]
    .map((m) => m[1].replace(/\\+$/, '').replace(/\\+(["/])/g, '$1'))
    .filter((m) => m && !/^\d{3} - $/.test(m));
  return msgs.length ? msgs[msgs.length - 1] : null;
}

function safeJsonParse(text) {
  if (text && typeof text === 'object') return text;
  if (typeof text !== 'string') return null;
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1];
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(t.slice(first, last + 1)); } catch (e) { return null; }
  }
  return null;
}

module.exports = {
  parseUrl, decodeEntities, collapseWhitespace, htmlToText, normalizeUrl, contentKeyFromUrl, toB64Json,
  escapeTelegramHtml, escapeAttr, truncate, charLength, normalizeForMatch, safeJsonParse, innerApiMessage,
};
