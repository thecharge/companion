# Integrations Guide

## Overview

Companion includes first-party webhook adapters in the server runtime:
- Slack: `POST /integrations/slack/events`
- Telegram: `POST /integrations/telegram/webhook`

No separate SDK package is required.

## Real-World Webhook Runbook

Use this sequence exactly when you want the integrations to work outside local theory.

1. Start Companion server:

```bash
bun run server
```

2. Expose it on a public HTTPS URL (required by Slack/Telegram):

```bash
# Example with cloudflared
cloudflared tunnel --url http://localhost:3000

# Or with ngrok
ngrok http 3000
```

3. Copy the HTTPS URL from the tunnel output, for example `https://abc123.trycloudflare.com`.
4. Use that URL for Slack Event Subscriptions and Telegram `setWebhook`.
5. Verify webhook registration is healthy before testing messages.

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
    max_message_chars: 16000
    max_events_per_minute: 240

  telegram:
    enabled: true
    bot_token: ${TELEGRAM_BOT_TOKEN:-}
    secret_token: ${TELEGRAM_SECRET_TOKEN:-}
    trusted_user_ids: [123456789]
    trusted_chat_ids: [123456789]
    required_passphrase: ${TELEGRAM_REQUIRED_PASSPHRASE:-}
    mode: balanced
    default_session_title: "Telegram Session"
    max_message_chars: 16000
    max_events_per_minute: 240
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

Integration option reference (verbose meanings):

| Option | Location | Default | Description |
| --- | --- | --- | --- |
| Slack Enable Flag | `integrations.slack.enabled` / `SLACK_ENABLED` | `false` | Turns Slack webhook handling on or off. When disabled, endpoint returns not found. |
| Slack Bot Token | `integrations.slack.bot_token` / `SLACK_BOT_TOKEN` | empty | OAuth bot token used to send replies back into Slack channels. |
| Slack Signing Secret | `integrations.slack.signing_secret` / `SLACK_SIGNING_SECRET` | empty | Secret used to validate Slack request signatures (`x-slack-signature`). |
| Slack Trusted User IDs | `integrations.slack.trusted_user_ids` | empty list | Allowlist of Slack sender user IDs permitted to trigger processing. |
| Slack Trusted Channel IDs | `integrations.slack.trusted_channel_ids` | empty list | Allowlist of channel IDs where bot messages are accepted. |
| Slack Trusted Team IDs | `integrations.slack.trusted_team_ids` | empty list | Allowlist of workspace/team IDs for inbound events. |
| Slack Required Passphrase | `integrations.slack.required_passphrase` / `SLACK_REQUIRED_PASSPHRASE` | empty | Optional required message prefix for step-up trust control. |
| Slack Runtime Mode Override | `integrations.slack.mode` / `SLACK_MODE` | unset (`balanced` in example env) | Optional per-integration mode override for sessions created from Slack events. |
| Slack Session Title Template | `integrations.slack.default_session_title` | `Slack Session` | Default title assigned to sessions created by Slack messages. |
| Slack Max Message Characters | `integrations.slack.max_message_chars` | `16000` | Character limit before message guard rejects/ignores unsafe or oversized payloads. |
| Slack Max Events Per Minute | `integrations.slack.max_events_per_minute` | `240` | Per-channel ingress rate limit to control abuse/spam. |
| Telegram Enable Flag | `integrations.telegram.enabled` / `TELEGRAM_ENABLED` | `false` | Turns Telegram webhook handling on or off. |
| Telegram Bot Token | `integrations.telegram.bot_token` / `TELEGRAM_BOT_TOKEN` | empty | Bot API token used to post replies into Telegram chats. |
| Telegram Webhook Secret | `integrations.telegram.secret_token` / `TELEGRAM_SECRET_TOKEN` | empty | Expected secret in `x-telegram-bot-api-secret-token` header. |
| Telegram Trusted User IDs | `integrations.telegram.trusted_user_ids` | empty list | Allowlist of sender user IDs allowed to trigger processing. |
| Telegram Trusted Chat IDs | `integrations.telegram.trusted_chat_ids` | empty list | Allowlist of chat IDs where bot processing is permitted. |
| Telegram Required Passphrase | `integrations.telegram.required_passphrase` / `TELEGRAM_REQUIRED_PASSPHRASE` | empty | Optional required prefix users must include in messages. |
| Telegram Runtime Mode Override | `integrations.telegram.mode` / `TELEGRAM_MODE` | unset (`balanced` in example env) | Optional per-integration mode override for Telegram-originated sessions. |
| Telegram Session Title Template | `integrations.telegram.default_session_title` | `Telegram Session` | Default title assigned to sessions created by Telegram messages. |
| Telegram Max Message Characters | `integrations.telegram.max_message_chars` | `16000` | Character limit before guard rejects/ignores oversized input. |
| Telegram Max Events Per Minute | `integrations.telegram.max_events_per_minute` | `240` | Per-chat ingress rate limit for abuse protection. |

For the complete global configuration matrix (all `companion.yaml` sections, env vars, runtime-only env vars, and override behavior), see:
- `Docs/CONFIGURATION_GUIDE.md`

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

10. Invite the bot to the target channel before expecting events.

Slack command examples:

```text
/invite @your-bot-name
```

How to get trusted IDs for `companion.yaml`:

1. Workspace ID (`trusted_team_ids`): from Slack app dashboard basic info.
2. Channel ID (`trusted_channel_ids`): open channel details or copy link (`/archives/C...`).
3. User ID (`trusted_user_ids`): user profile menu -> copy member ID (`U...`).

Slack webhook registration verification:

1. In Slack Event Subscriptions, Request URL must show as verified.
2. If it fails, check server logs for `invalid slack signature` or content-type errors.

Local signature test with a valid computed signature:

```bash
SLACK_SIGNING_SECRET='replace-me'
TS=$(date +%s)
BODY='{"type":"url_verification","challenge":"ok"}'
BASE="v0:${TS}:${BODY}"
SIG="v0=$(printf '%s' "$BASE" | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" -hex | sed 's/^.* //')"

curl -s -X POST http://localhost:3000/integrations/slack/events \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: ${TS}" \
  -H "x-slack-signature: ${SIG}" \
  -d "$BODY"
```

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

Check webhook status after registration:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

Expected:
- `ok: true`
- your webhook URL present
- empty `last_error_message`

## Verification Checklist

Run this after setup:

1. Companion health endpoint returns `ok`.
2. Slack URL verification succeeds automatically.
3. Telegram webhook set succeeds (`"ok": true`).
4. Untrusted sender is ignored (`reason: untrusted_user` or `untrusted_chat`).
5. Trusted sender with passphrase is accepted.
6. Bot actually responds in Slack/Telegram chat, not only via local curl.

Telemetry endpoints (required for operational visibility):

- `GET /integrations/telemetry/config`
- `GET /integrations/telemetry/stats`

Example:

```bash
curl -s http://localhost:3000/integrations/telemetry/config \
  -H "Authorization: Bearer ${COMPANION_SECRET:-dev-secret}"

curl -s http://localhost:3000/integrations/telemetry/stats \
  -H "Authorization: Bearer ${COMPANION_SECRET:-dev-secret}"
```

Run bundled smoke check:

```bash
bun run webhook:smoke
```

End-to-end smoke test (real usage):

1. Keep server and tunnel running.
2. Send message from a trusted user in a trusted channel/chat:
- Slack: `<passphrase> status`
- Telegram: `<passphrase> status`
3. Confirm:
- request hits webhook route
- message is accepted (not `ignored`)
- reply is posted back by bot token

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

## Common Failure Modes

1. Slack Request URL not verified:
- Cause: server not publicly reachable, invalid TLS URL, wrong path.
- Fix: use HTTPS tunnel URL and exact path `/integrations/slack/events`.

2. Telegram webhook set but no events delivered:
- Cause: webhook URL unreachable from Telegram or wrong secret token.
- Fix: check `getWebhookInfo`, confirm `last_error_message` is empty, verify header secret.

3. Events received but always ignored:
- Cause: sender/channel/chat not in trusted allowlists or missing passphrase.
- Fix: add correct IDs and send messages with configured passphrase prefix.

4. Slack signature failures:
- Cause: wrong signing secret or modified raw body before verification.
- Fix: verify app signing secret and keep request body unchanged for signature check.

