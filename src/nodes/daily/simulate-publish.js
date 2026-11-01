// Simulate publish (dry run): shows exactly what would be sent to the Graph API, sends nothing.
const { plan } = $input.first().json;
return [{
  json: {
    ok: true,
    simulated: true,
    post_id: `dryrun_${$execution.id}`,
    photo_id: null,
    endpoint: plan.primary.endpoint,
    would_send: { method: 'POST', url: plan.primary.url, body: plan.primary.body },
    scheduled_for: plan.scheduled_for,
  },
}];
