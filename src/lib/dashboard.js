'use strict';
const { escapeTelegramHtml: esc, escapeAttr, truncate } = require('./util');

const STATUS_COLORS = {
  published: '#0f7b4f', scheduled: '#2457c5', pending_review: '#a15c00', approved: '#a15c00', dry_run: '#6b6b80',
  blocked: '#b42318', failed: '#b42318', rejected: '#7a4d00', review_expired: '#7a4d00', processing: '#6b6b80',
  skipped: '#6b6b80', no_content: '#a15c00', running: '#6b6b80',
};

function badge(status) {
  const c = STATUS_COLORS[status] || '#6b6b80';
  return `<span class="badge" style="--c:${c}">${esc(String(status || '').replace(/_/g, ' '))}</span>`;
}

function fmt(ts, tz) {
  if (!ts) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
  } catch (e) { return esc(ts); }
}

function renderDashboard(data, opts) {
  const tz = (opts && opts.timezone) || 'UTC';
  const s = data.stats || {};
  const rs = data.run_stats || {};
  const tiles = [
    ['Published', s.published], ['Scheduled', s.scheduled], ['Awaiting review', s.pending_review],
    ['Dry-run drafts', s.dry_run], ['Blocked by guardrails', s.blocked], ['Failed (retrying)', s.failed],
    ['Reactions', s.reactions], ['Comments', s.comments], ['Shares', s.shares], ['Clicks', s.clicks],
  ].map(([k, v]) => `<div class="tile"><div class="v">${Number(v || 0).toLocaleString('en-US')}</div><div class="k">${esc(k)}</div></div>`).join('');

  const posts = (data.posts || []).map((p) => `
    <tr>
      <td>${fmt(p.published_at || p.scheduled_for || p.created_at, tz)}</td>
      <td>${badge(p.status)}${p.attempts > 1 ? `<div class="muted">attempt ${p.attempts}</div>` : ''}</td>
      <td><div class="t"><a href="${escapeAttr(p.url)}" target="_blank" rel="noopener">${esc(truncate(p.title || p.url, 90))}</a></div>
          <div class="muted">${esc(p.content_type)} · ${esc(p.category || 'general')}</div>
          ${p.post_text ? `<details><summary>Post text</summary><pre>${esc(p.post_text)}</pre></details>` : ''}
          ${p.guardrail_reason && p.status === 'blocked' ? `<div class="err">${esc(p.guardrail_reason)}</div>` : ''}
          ${p.last_error && p.status === 'failed' ? `<div class="err">${esc(truncate(p.last_error, 200))}</div>` : ''}</td>
      <td>${p.fb_permalink ? `<a href="${escapeAttr(p.fb_permalink)}" target="_blank" rel="noopener">open</a>` : esc(p.fb_post_id || '—')}</td>
      <td class="num">${p.reactions ?? '—'}</td><td class="num">${p.comments ?? '—'}</td><td class="num">${p.shares ?? '—'}</td><td class="num">${p.clicks ?? '—'}</td>
    </tr>`).join('');

  const runs = (data.runs || []).map((r) => `
    <tr>
      <td>${fmt(r.started_at, tz)}</td><td>${esc(r.trigger_mode || '')}${r.dry_run ? ' · dry' : ''}${r.review_mode === 'approval' ? ' · review' : ''}</td>
      <td>${badge(r.status)}</td><td>${esc(r.content_key || '—')}</td>
      <td>${r.error_code ? `<span class="err">${esc(r.error_code)}</span> ${esc(truncate(r.error_message || '', 120))}` : ''}</td>
      <td class="num">${r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + 's' : '—'}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="120"><title>PlacidWay Autopost</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d24;--muted:#6b6b80;--line:#e6e3dc;--accent:#0f7b4f}
@media (prefers-color-scheme:dark){:root{--bg:#141418;--card:#1d1d24;--ink:#ecebe7;--muted:#9a9aab;--line:#2c2c36}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.sub{color:var(--muted);margin-bottom:18px}.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.v{font-size:22px;font-weight:650}.k{color:var(--muted);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow-x:auto}table{width:100%;border-collapse:collapse}
th,td{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}.num{text-align:right;font-variant-numeric:tabular-nums}.muted{color:var(--muted);font-size:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);white-space:nowrap}
.err{color:#b42318;font-size:12px}a{color:var(--accent)}pre{white-space:pre-wrap;font:12px/1.4 ui-monospace,monospace;background:var(--bg);padding:8px;border-radius:6px;max-width:520px}
details summary{cursor:pointer;color:var(--muted);font-size:12px}
</style></head><body><main>
<h1>PlacidWay → Facebook autopost</h1>
<div class="sub">Updated ${fmt(data.generated_at, tz)} (${esc(tz)}) · last 7 days: ${Number(rs.last_7d || 0)} runs, ${Number(rs.failed_7d || 0)} failed, avg ${((rs.avg_duration_ms || 0) / 1000).toFixed(1)}s</div>
<div class="tiles">${tiles}</div>
<h2>Posts</h2>
<div class="card"><table><thead><tr><th>When</th><th>Status</th><th>Item</th><th>Facebook</th><th class="num">Reactions</th><th class="num">Comments</th><th class="num">Shares</th><th class="num">Clicks</th></tr></thead>
<tbody>${posts || '<tr><td colspan="8" class="muted">No posts yet. Run the workflow manually to create the first one.</td></tr>'}</tbody></table></div>
<h2>Run log</h2>
<div class="card"><table><thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th>Item</th><th>Error</th><th class="num">Duration</th></tr></thead>
<tbody>${runs || '<tr><td colspan="6" class="muted">No runs yet.</td></tr>'}</tbody></table></div>
</main></body></html>`;
}

module.exports = { renderDashboard };
