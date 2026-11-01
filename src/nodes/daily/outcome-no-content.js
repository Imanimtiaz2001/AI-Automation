// Outcome: no content. Every candidate on the listing pages has already been used.
const { buildOutcome } = require('../../lib/outcome');

const { cfg, run } = $('Config').first(0).json;
const s = $input.first().json.summary || {};
const reason = `No unused items: ${s.considered || 0} considered, ${(s.rejected && s.rejected.already_used) || 0} already used, ${(s.rejected && s.rejected.robots) || 0} disallowed by robots.txt.`;
return [{ json: buildOutcome('no_content', { cfg, execution_id: run.execution_id, reason, details_json: { selection: s } }) }];
