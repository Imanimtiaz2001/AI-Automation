// Render dashboard: turns one JSON row from Postgres into a self-contained HTML page.
const { renderDashboard } = require('../../lib/dashboard');
const { buildConfig, readEnvSafely } = require('../../lib/config');

let tz = 'UTC';
try { tz = buildConfig(readEnvSafely(() => $env)).timezone; } catch (e) { /* keep UTC */ }
const data = $input.first().json.data || {};
return [{ json: { html: renderDashboard(data, { timezone: tz }) } }];
