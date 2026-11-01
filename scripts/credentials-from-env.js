#!/usr/bin/env node
'use strict';
/**
 * Writes an n8n credentials import file from environment variables, using the fixed credential IDs the
 * workflows reference. `n8n import:credentials` encrypts the plain `data` objects with N8N_ENCRYPTION_KEY.
 *   node scripts/credentials-from-env.js > /tmp/creds.json && n8n import:credentials --input=/tmp/creds.json
 * Missing secrets get a placeholder so the import still succeeds; fix them later in the n8n UI.
 */
const { CREDENTIALS } = require('./n8n-builder');

const e = process.env;
const placeholder = (v, name) => (v && String(v).trim()) || `SET_ME_${name}`;
const ref = (k) => Object.values(CREDENTIALS[k])[0];

const creds = [
  {
    ...ref('postgres'), type: 'postgres',
    data: {
      host: e.PW_DB_HOST || 'postgres', port: Number(e.PW_DB_PORT || 5432), database: e.PW_DB_NAME || 'placidway',
      user: e.PW_DB_USER || e.POSTGRES_USER || 'placidway', password: e.PW_DB_PASSWORD || e.POSTGRES_PASSWORD || '',
      ssl: 'disable', allowUnauthorizedCerts: false, sshTunnel: false, maxConnections: 10,
    },
  },
  { ...ref('llm'), type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${placeholder(e.LLM_API_KEY, 'LLM_API_KEY')}` } },
  { ...ref('facebook'), type: 'httpQueryAuth', data: { name: 'access_token', value: placeholder(e.FB_PAGE_ACCESS_TOKEN, 'FB_PAGE_ACCESS_TOKEN') } },
  { ...ref('telegram'), type: 'telegramApi', data: { accessToken: placeholder(e.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN'), baseUrl: e.TELEGRAM_API_BASE_URL || 'https://api.telegram.org' } },
];
process.stdout.write(JSON.stringify(creds, null, 2) + '\n');
