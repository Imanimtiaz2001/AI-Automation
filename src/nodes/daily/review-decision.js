// Review decision: the Wait node resumes with the reviewer's click (or with no query after the timeout).
const resumed = $input.first().json || {};
const q = resumed.query || {};
const expected = $('Prepare review request').first(0).json.review_token;
let decision;
let reason;
if (!q.decision) { decision = 'review_expired'; reason = 'no decision before the review window closed'; }
else if (q.token !== expected) { decision = 'rejected'; reason = 'invalid review token (treated as reject)'; }
else if (q.decision === 'approve') { decision = 'approved'; reason = 'approved by reviewer'; }
else { decision = 'rejected'; reason = 'rejected by reviewer'; }
return [{ json: { approved: decision === 'approved', decision, reason, decided_at: new Date().toISOString() } }];
