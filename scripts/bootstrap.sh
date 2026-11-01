#!/usr/bin/env bash
# One-command setup: start the stack, create the 4 credentials, import + activate the 3 workflows.
# Idempotent: re-running updates workflows/credentials in place (fixed IDs).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Missing .env  -> cp .env.example .env  and fill it"; exit 1; }
set -a; . ./.env; [ -f .env.secrets ] && . ./.env.secrets; set +a

echo "▶ starting postgres, n8n and the task runner"
docker compose up -d

echo -n "▶ waiting for n8n"
for i in $(seq 1 60); do
  if docker compose exec -T n8n node -e "fetch('http://127.0.0.1:5678/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then echo " ready"; break; fi
  echo -n "."; sleep 3
  [ "$i" = 60 ] && { echo; echo "n8n did not become healthy; see: docker compose logs n8n"; exit 1; }
done

if [ -f .env.secrets ]; then
  echo "▶ importing credentials (encrypted by n8n; secrets are passed only to this one command)"
  docker compose exec -T \
    -e LLM_API_KEY -e FB_PAGE_ACCESS_TOKEN -e TELEGRAM_BOT_TOKEN -e POSTGRES_PASSWORD -e POSTGRES_USER \
    n8n sh -c 'node /scripts/credentials-from-env.js > /tmp/pw-creds.json && n8n import:credentials --input=/tmp/pw-creds.json; rc=$?; rm -f /tmp/pw-creds.json; exit $rc'
else
  echo "▶ no .env.secrets: create the 4 credentials in the n8n UI (see README > Credentials)"
fi

echo "▶ importing workflows"
docker compose exec -T n8n n8n import:workflow --separate --input=/workflows

echo "▶ activating (publishing) workflows"
for id in pwDailyPost00001 pwEngagement0001 pwDashboard00001; do
  docker compose exec -T n8n n8n publish:workflow --id="$id" || echo "  could not publish $id (activate it in the UI)"
done
docker compose restart n8n >/dev/null

cat <<MSG

✅ Done.
   n8n editor:  ${WEBHOOK_URL:-http://localhost:5678/}   (first visit: create the owner account)
   Dashboard:   ${WEBHOOK_URL:-http://localhost:5678/}webhook/placidway-dashboard
   Demo run:    open "PlacidWay → Facebook: daily post" and click "Execute workflow" (manual run).
   Mode:        PW_DRY_RUN=${PW_DRY_RUN:-true}  PW_REVIEW_MODE=${PW_REVIEW_MODE:-auto}  (edit .env, then: docker compose up -d)
MSG
