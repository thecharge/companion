export const WEBHOOK_PATHS = {
  slack: "/integrations/slack/events",
  telegram: "/integrations/telegram/webhook",
} as const;

export const INTEGRATION_LIMITS = {
  maxWebhookBodyBytes: 64 * 1024,
  defaultMaxMessageChars: 2000,
  replayWindowMs: 5 * 60 * 1000,
  rateWindowMs: 60 * 1000,
  defaultEventsPerMinute: 30,
} as const;

export const BLOCKED_MESSAGE_PATTERNS = [
  /\b(ignore\s+previous\s+instructions|developer\s+mode|jailbreak|prompt\s*injection)\b/i,
  /\b(system\s+prompt|reveal\s+your\s+rules|bypass\s+safety)\b/i,
  /(@everyone|@channel)\b/i,
  /([^\s])\1{40,}/,
] as const;
