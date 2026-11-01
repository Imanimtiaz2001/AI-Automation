// Plan listing requests: applies robots.txt (RFC 9309) before any page is requested.
const { robotsPolicyFromResponse, policyAllows, crawlDelayFor } = require('../../lib/robots');

const { cfg } = $('Config').first(0).json;
const res = $input.first().json; // { data, statusCode, headers }
const policy = robotsPolicyFromResponse(res.statusCode, res.data);
if (policy.mode === 'disallow_all') throw new Error(`SITE_DOWN: ${policy.reason}`);

const crawlDelay = policy.parsed ? crawlDelayFor(policy.parsed, cfg.user_agent) : null;
const intervalMs = Math.max(cfg.request_interval_ms, crawlDelay ? crawlDelay * 1000 : 0);

const items = [];
const blocked = [];
for (const [type, path] of Object.entries(cfg.sources)) {
  const url = cfg.base_url + path;
  if (policyAllows(policy, cfg.user_agent, url)) items.push({ json: { type, url, interval_ms: intervalMs, robots: policy } });
  else blocked.push(url);
}
if (!items.length) throw new Error(`ROBOTS_DISALLOWED: robots.txt disallows ${blocked.join(', ')}`);
return items;
