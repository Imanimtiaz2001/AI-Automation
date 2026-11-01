// Outcome: skipped. Today's post already exists (scheduled retry slots) or another run claimed the item.
const { buildOutcome } = require('../../lib/outcome');

const { cfg, run } = $('Config').first(0).json;
const reason = $prevNode.name === 'Claimed?'
  ? 'item was claimed by a concurrent run'
  : 'a post for today already exists; this scheduled slot is only a retry';
return [{ json: buildOutcome('skipped', { cfg, execution_id: run.execution_id, reason, details_json: { skip_reason: reason } }) }];
