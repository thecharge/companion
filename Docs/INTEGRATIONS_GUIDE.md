# Integrations Guide

## Overview

Companion includes first-party webhook adapters in the server runtime:
- Slack: `POST /integrations/slack/events`
- Telegram: `POST /integrations/telegram/webhook`

No separate SDK package is required.

## What You Need

Before enabling integrations, make sure all items below are ready:

1. A publicly reachable HTTPS URL for your Companion server (webhooks must be reachable by Slack/Telegram).
2. A strong API secret for Companion (`COMPANION_SECRET`, not `dev-secret`).
3. Slack bot app credentials:
- bot token (`xoxb-...`)
- signing secret
- workspace/team ID, allowed channel IDs, allowed user IDs
4. Telegram bot credentials:
- bot token (from BotFather)
- webhook secret token
- allowed chat IDs and allowed user IDs
5. Production safety settings:
- `NODE_ENV=production`
- sandbox pinned to container runtime (`docker` or `podman`)
- direct fallback disabled for tools where possible

## Security Model

- Slack requests are validated with HMAC signature (`x-slack-signature`, `x-slack-request-timestamp`).
- Telegram requests are validated with webhook secret token (`x-telegram-bot-api-secret-token`).
- Oversized payloads are rejected.
- Non-JSON payloads are rejected.
- Replay detection prevents repeated event IDs/update IDs.
- Per-channel/chat rate limits throttle abuse.
- Inbound message guard blocks known prompt-injection/jailbreak payloads and mention-spam patterns.
- Trusted sender allowlists are supported for both providers.
- Optional passphrase gate (`required_passphrase`) can be enforced as a second factor for message acceptance.

## Required Configuration

Set these in `companion.yaml` (or env vars consumed by it):

```yaml
integrations:
  slack:
    enabled: true
    bot_token: ${SLACK_BOT_TOKEN:-}
    signing_secret: ${SLACK_SIGNING_SECRET:-}
    trusted_user_ids: ["U01234567"]
    trusted_channel_ids: ["C01234567"]
    trusted_team_ids: ["T01234567"]
    required_passphrase: ${SLACK_REQUIRED_PASSPHRASE:-}
    mode: balanced
    default_session_title: "Slack Session"
    max_message_chars: 2000
    max_events_per_minute: 30

  telegram:
    enabled: true
    bot_token: ${TELEGRAM_BOT_TOKEN:-}
    secret_token: ${TELEGRAM_SECRET_TOKEN:-}
    trusted_user_ids: [123456789]
    trusted_chat_ids: [123456789]
    required_passphrase: ${TELEGRAM_REQUIRED_PASSPHRASE:-}
    mode: balanced
    default_session_title: "Telegram Session"
    max_message_chars: 2000
    max_events_per_minute: 30
```

Recommended env values:

```bash
COMPANION_SECRET=<long-random-secret>

SLACK_ENABLED=true
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_REQUIRED_PASSPHRASE=<shared-passphrase>

TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=...
TELEGRAM_SECRET_TOKEN=<long-random-secret>
TELEGRAM_REQUIRED_PASSPHRASE=<shared-passphrase>
```

## Slack Setup (Detailed)

1. Create a Slack app and bot user.
2. In OAuth scopes, add at least:
- `chat:write` (send replies)
- `channels:history` (read channel messages)
3. Enable Event Subscriptions.
4. Set Request URL to:
- `https://<your-host>/integrations/slack/events`
5. Subscribe to bot events, at minimum:
- `message.channels`
6. Install or reinstall the app to workspace.
7. Capture and store:
- Bot token (`xoxb-...`)
- Signing secret
8. Restrict who can talk to the bot:
- add specific sender IDs to `trusted_user_ids`
- add specific channel IDs to `trusted_channel_ids`
- add your workspace ID to `trusted_team_ids`
9. If you require a second factor, set `required_passphrase` and require users to prefix messages with it.

## Telegram Setup (Detailed)

1. Create bot with BotFather.
2. Generate a long random webhook secret token.
3. Register webhook with secret token:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<host>/integrations/telegram/webhook","secret_token":"<secret>"}'
```

4. Send a message to your bot and fetch IDs:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
```

Use the response to collect:
- `message.from.id` -> trusted user
- `message.chat.id` -> trusted chat

5. Add these IDs to `trusted_user_ids` and `trusted_chat_ids`.
6. If you require a second factor, set `required_passphrase` and require users to prefix messages with it.

## Verification Checklist

Run this after setup:

1. Companion health endpoint returns `ok`.
2. Slack URL verification succeeds automatically.
3. Telegram webhook set succeeds (`"ok": true`).
4. Untrusted sender is ignored (`reason: untrusted_user` or `untrusted_chat`).
5. Trusted sender with passphrase is accepted.

Quick Telegram signed test:

```bash
curl -s -X POST http://localhost:3000/integrations/telegram/webhook \
  -H "Content-Type: application/json" \
  -H "x-telegram-bot-api-secret-token: ${TELEGRAM_SECRET_TOKEN}" \
  -d '{"update_id": 1, "message": {"text": "<passphrase> ping", "chat": {"id": 123456789}, "from": {"id": 123456789}}}'
```

Quick Slack URL verification test:

```bash
curl -s -X POST http://localhost:3000/integrations/slack/events \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: $(date +%s)" \
  -H "x-slack-signature: invalid" \
  -d '{"type":"url_verification","challenge":"ok"}'
```

Expected result: unauthorized when signature is invalid.

## Official Provider References

- Slack signed secrets and event subscriptions:
  - `https://api.slack.com/authentication/verifying-requests-from-slack`
  - `https://api.slack.com/apis/connections/events-api`
- Telegram webhook secret token:
  - `https://core.telegram.org/bots/api#setwebhook`

## Operational Notes

- Webhook adapters create/reuse session per Slack channel or Telegram chat.
- If outbound bot token is configured, assistant replies are posted back.
- Webhook routes are public by design, but access is controlled by provider signature/secret validation plus your allowlists.
- In production, do not leave allowlists empty.
- Startup checks emit warnings in `NODE_ENV=production` when allowlists/passphrases are missing.

