// Prepare review request: draft + guardrail evidence + signed approve/reject links for the reviewer.
const { toB64Json, escapeTelegramHtml: esc, escapeAttr, truncate } = require('../../lib/util');

const { cfg, run } = $('Config').first(0).json;
const { content } = $('Extract & validate content').first(0).json;
const fd = $('Guardrails: final decision').first(0).json;
const claim = $('DB: claim item').first(0).json;

function randomToken() {
  const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(24);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

const token = randomToken();
const resumeUrl = $execution.resumeUrl; // n8n signs this URL; our token adds a second, per-draft check
const sep = resumeUrl.includes('?') ? '&' : '?';
const approveUrl = `${resumeUrl}${sep}decision=approve&token=${token}`;
const rejectUrl = `${resumeUrl}${sep}decision=reject&token=${token}`;

const chosen = fd.report.variants.find((v) => v.index === fd.report.chosen_index) || {};
const warnings = (chosen.rule_warnings || []).map((w) => `• ${w.rule}: ${w.detail}`).join('\n');
const when = cfg.publish_strategy === 'schedule' ? `scheduled for the next ${cfg.schedule_time} (${cfg.timezone})` : 'published immediately';
const message = [
  `📝 <b>Draft ready for review</b>${cfg.dry_run ? ' <i>(dry run: approving only simulates the post)</i>' : ''}`,
  `<b>Source:</b> <a href="${escapeAttr(content.url)}">${esc(truncate(content.title, 100))}</a> (${esc(content.type)})`,
  content.image_url ? `<b>Image:</b> <a href="${escapeAttr(content.image_url)}">featured image</a>` : '<b>Image:</b> none (link post)',
  '',
  `<blockquote>${esc(fd.post.text)}</blockquote>`,
  '',
  `<b>Guardrails:</b> rules passed, judge verified ${chosen.claims_checked || 0} claim(s), quality ${chosen.quality || '?'}/5.`,
  warnings ? `<b>Warnings:</b>\n${esc(warnings)}` : '',
  `If approved it will be ${esc(when)}.`,
  '',
  `<a href="${escapeAttr(approveUrl)}">✅ Approve &amp; publish</a>     <a href="${escapeAttr(rejectUrl)}">❌ Reject</a>`,
  `<i>Link expires in ${cfg.review_timeout_hours}h.</i>`,
].filter((l) => l !== '').join('\n');

return [{
  json: {
    review_token: token,
    message: truncate(message, 4000),
    db_payload_b64: toB64Json({
      execution_id: run.execution_id,
      post_id: claim.post_id,
      post_text: fd.post.text,
      angle: fd.post.angle,
      guardrails: fd.report,
      review_token: token,
      llm_usage: fd.usage,
    }),
  },
}];
