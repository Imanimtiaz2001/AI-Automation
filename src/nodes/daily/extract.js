// Extract & validate content: parses each fetched detail page and keeps the first usable one.
const { extractPage, validateContent, llmContext } = require('../../lib/extract');
const { toB64Json, truncate } = require('../../lib/util');

const { cfg, run } = $('Config').first(0).json;
const picks = $('Select candidates').all(0);
const pages = $input.all();

const problems = [];
for (let i = 0; i < pages.length; i++) {
  const pick = picks[i] && picks[i].json;
  if (!pick) continue;
  const c = pick.candidate;
  const page = pages[i].json;
  if (page.error || typeof page.html !== 'string') {
    const e = page.error || {};
    problems.push(`${c.content_key}: ${e.message || 'fetch failed'}`);
    continue;
  }
  const content = extractPage(page.html, { url: c.url, type: c.type, baseUrl: cfg.base_url, titleHint: c.title_hint });
  const issues = validateContent(content, { statusCode: 200, minBodyChars: cfg.min_body_chars });
  if (issues.length) { problems.push(`${c.content_key}: ${issues.join(', ')}`); continue; }

  content.content_key = c.content_key;      // listing-derived key wins (canonical can point at a subdomain)
  content.url = c.url;
  content.category = c.category;
  content.llm_context = llmContext(content, 7000);
  const source = {
    title: content.title, summary: content.summary, image_url: content.image_url, price: content.price,
    word_count: content.word_count, published_at: content.published_at, modified_at: content.modified_at,
    canonical: content.canonical, extracted_at: new Date().toISOString(), excerpt: truncate(content.body_text, 600),
  };
  return [{
    json: {
      content,
      candidate: c,
      skipped_candidates: problems,
      claim_payload_b64: toB64Json({
        execution_id: run.execution_id,
        content_key: c.content_key, url: c.url, type: c.type, category: c.category,
        title: content.title, summary: content.summary, image_url: content.image_url,
        selection_reason: c.selection_reason,
        source,
        selection: { ...pick.summary, rank: pick.rank, score: c.score, reason: c.selection_reason, skipped: problems },
        max_attempts: cfg.max_attempts,
        dry_run: cfg.dry_run,
      }),
    },
  }];
}
throw new Error(`NO_VALID_CONTENT: ${problems.join(' | ') || 'no candidate pages'}`);
