# Integrations Guide

## Overview

Companion includes first-party webhook adapters in the server runtime:
- Slack: `POST /integrations/slack/events`
- Telegram: `POST /integrations/telegram/webhook`

No separate SDK package is required.

## Security Model

- Slack requests are validated with HMAC signature (`x-slack-signature`, `x-slack-request-timestamp`).
- Telegram requests are validated with webhook secret token (`x-telegram-bot-api-secret-token`).
- Oversized payloads are rejected.
- Non-JSON payloads are rejected.
- Replay detection prevents repeated event IDs/update IDs.
- Per-channel/chat rate limits throttle abuse.
- Inbound message guard blocks known prompt-injection/jailbreak payloads and mention-spam patterns.

## Slack Setup

1. Create Slack app and bot token.
2. Enable Event Subscriptions.
3. Set Request URL to `https://<host>/integrations/slack/events`.
4. Subscribe to bot event `message.channels` (or needed message scopes).
5. Install app to workspace.

Environment/config:

```bash
SLACK_ENABLED=true
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_MODE=balanced
```

`companion.yaml` keys:
- `integrations.slack.enabled`
- `integrations.slack.bot_token`
- `integrations.slack.signing_secret`
- `integrations.slack.mode`
- `integrations.slack.max_message_chars`
- `integrations.slack.max_events_per_minute`

## Telegram Setup

1. Create bot with BotFather.
2. Generate webhook secret token.
3. Register webhook:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<host>/integrations/telegram/webhook","secret_token":"<secret>"}'
```

Environment/config:

```bash
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=...
TELEGRAM_SECRET_TOKEN=...
TELEGRAM_MODE=balanced
```

`companion.yaml` keys:
- `integrations.telegram.enabled`
- `integrations.telegram.bot_token`
- `integrations.telegram.secret_token`
- `integrations.telegram.mode`
- `integrations.telegram.max_message_chars`
- `integrations.telegram.max_events_per_minute`

## Operational Notes

- Webhook adapters create/reuse session per Slack channel or Telegram chat.
- If outbound bot token is configured, assistant replies are posted back.
- Keep server secret for API/WS traffic; webhook endpoints are separately authenticated by integration-specific signatures/secrets.
