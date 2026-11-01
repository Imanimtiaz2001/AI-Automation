'use strict';
const { parseUrl } = require('./util');
/**
 * Minimal RFC 9309 robots.txt implementation.
 *  - groups are selected by the most specific matching user-agent token, falling back to "*"
 *  - rules support "*" wildcards and "$" end anchors; the longest matching rule wins, "allow" wins ties
 *  - 4xx (robots.txt unavailable)  => everything allowed
 *  - 5xx / network error (unreachable) => everything disallowed (RFC 9309 section 2.3.1.4)
 */

function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  const sitemaps = [];
  let crawlDelay = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') { sitemaps.push(value); continue; }
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const n = parseFloat(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }
  return { groups, sitemaps, crawlDelay };
}

function selectGroups(parsed, userAgent) {
  const token = String(userAgent || '').split(/[\/\s]/)[0].toLowerCase();
  const specific = parsed.groups.filter((g) => g.agents.some((a) => a !== '*' && token && token.includes(a)));
  if (specific.length) return specific;
  return parsed.groups.filter((g) => g.agents.includes('*'));
}

function ruleToRegex(path) {
  let anchored = false;
  let p = path;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  const esc = p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + esc + (anchored ? '$' : ''));
}

function isAllowed(parsed, userAgent, urlOrPath) {
  let path = String(urlOrPath || '/');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    const u = parseUrl(path);
    path = u ? u.pathname + u.search : '/';
  }
  if (path === '/robots.txt') return true;
  const groups = selectGroups(parsed, userAgent);
  let best = null;
  for (const g of groups) {
    for (const r of g.rules) {
      if (r.path === '') continue; // "Disallow:" (empty) means allow everything
      if (!ruleToRegex(r.path).test(path)) continue;
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow, rule: r.path };
    }
  }
  return best ? best.allow : true;
}

function crawlDelayFor(parsed, userAgent) {
  const groups = selectGroups(parsed, userAgent);
  const delays = groups.map((g) => g.crawlDelay).filter((d) => d != null);
  return delays.length ? Math.max(...delays) : null;
}

/**
 * Turns an HTTP response for /robots.txt into a policy object.
 * @returns {{mode:'parsed'|'allow_all'|'disallow_all', parsed:object|null, reason:string}}
 */
function robotsPolicyFromResponse(statusCode, body) {
  const s = Number(statusCode);
  if (s >= 200 && s < 300) return { mode: 'parsed', parsed: parseRobots(body), reason: `robots.txt ${s}` };
  if (s >= 400 && s < 500) return { mode: 'allow_all', parsed: null, reason: `robots.txt ${s}: treated as allow-all (RFC 9309)` };
  return { mode: 'disallow_all', parsed: null, reason: `robots.txt ${s || 'unreachable'}: treated as disallow-all (RFC 9309)` };
}

function policyAllows(policy, userAgent, url) {
  if (policy.mode === 'allow_all') return true;
  if (policy.mode === 'disallow_all') return false;
  return isAllowed(policy.parsed, userAgent, url);
}

module.exports = { parseRobots, isAllowed, crawlDelayFor, robotsPolicyFromResponse, policyAllows };
