#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
AUTH_HEADER="Authorization: Bearer ${COMPANION_SECRET:-dev-secret}"

echo "[1/5] health"
curl -fsS "${API_URL}/health" -H "${AUTH_HEADER}" | sed -n '1,120p'

echo "[2/5] integration telemetry config"
curl -fsS "${API_URL}/integrations/telemetry/config" -H "${AUTH_HEADER}" | sed -n '1,200p'

echo "[3/5] integration telemetry stats"
curl -fsS "${API_URL}/integrations/telemetry/stats" -H "${AUTH_HEADER}" | sed -n '1,200p'

echo "[4/5] telegram webhook auth check (expect secure rejection when not fully configured)"
TELEGRAM_STATUS=$(curl -sS -o /tmp/companion_telegram_smoke.json -w "%{http_code}" \
  -X POST "${API_URL}/integrations/telegram/webhook" \
  -H "Content-Type: application/json" \
  -H "x-telegram-bot-api-secret-token: invalid" \
  -d '{"update_id":1,"message":{"text":"test","chat":{"id":1},"from":{"id":1}}}')

echo "telegram_status=${TELEGRAM_STATUS}"
cat /tmp/companion_telegram_smoke.json | sed -n '1,120p'

if [[ "${TELEGRAM_STATUS}" != "400" && "${TELEGRAM_STATUS}" != "401" && "${TELEGRAM_STATUS}" != "404" ]]; then
  echo "telegram webhook auth check failed"
  exit 1
fi

echo "[5/5] slack webhook auth check (expect secure rejection when not fully configured)"
SLACK_STATUS=$(curl -sS -o /tmp/companion_slack_smoke.json -w "%{http_code}" \
  -X POST "${API_URL}/integrations/slack/events" \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: $(date +%s)" \
  -H "x-slack-signature: v0=invalid" \
  -d '{"type":"event_callback","event":{"type":"message","text":"test","channel":"C1","user":"U1"}}')

echo "slack_status=${SLACK_STATUS}"
cat /tmp/companion_slack_smoke.json | sed -n '1,120p'

if [[ "${SLACK_STATUS}" != "400" && "${SLACK_STATUS}" != "401" && "${SLACK_STATUS}" != "404" ]]; then
  echo "slack webhook auth check failed"
  exit 1
fi

echo "webhook smoke checks passed"
