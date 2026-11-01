// Config (engagement sync): same PW_* settings as the daily workflow.
const { buildConfig, readEnvSafely } = require('../../lib/config');
const cfg = buildConfig(readEnvSafely(() => $env));
return [{ json: { cfg } }];
