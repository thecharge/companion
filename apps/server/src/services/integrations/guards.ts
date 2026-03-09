import { BLOCKED_MESSAGE_PATTERNS, INTEGRATION_LIMITS } from "./constants";

export interface GuardResult {
  ok: boolean;
  text?: string;
  reason?: string;
}

export function isJsonContentType(req: Request): boolean {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  return contentType.includes("application/json");
}

export function withinWebhookBodyLimit(rawBody: string): boolean {
  const bytes = new TextEncoder().encode(rawBody).byteLength;
  return bytes <= INTEGRATION_LIMITS.maxWebhookBodyBytes;
}

function sanitizeText(raw: string): string {
  const withoutControl = [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      const isAllowedWhitespace = code === 9 || code === 10 || code === 13 || code === 32;
      const isControl = (code >= 0 && code <= 31) || code === 127;
      return !isControl || isAllowedWhitespace;
    })
    .join("");

  return withoutControl.replace(/\s+/g, " ").trim();
}

export function guardInboundMessage(
  raw: string,
  maxChars: number = INTEGRATION_LIMITS.defaultMaxMessageChars,
): GuardResult {
  const sanitized = sanitizeText(raw);
  if (!sanitized) return { ok: false, reason: "empty content" };
  if (sanitized.length > maxChars) return { ok: false, reason: "content too long" };

  if (BLOCKED_MESSAGE_PATTERNS.some((pattern) => pattern.test(sanitized))) {
    return { ok: false, reason: "blocked pattern" };
  }

  return { ok: true, text: sanitized };
}

export class SlidingWindowLimiter {
  private bucket = new Map<string, number[]>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const arr = this.bucket.get(key) ?? [];
    const kept = arr.filter((ts) => now - ts < this.windowMs);
    if (kept.length >= this.limit) {
      this.bucket.set(key, kept);
      return false;
    }
    kept.push(now);
    this.bucket.set(key, kept);
    return true;
  }
}

export class ReplayGuard {
  private seen = new Map<string, number>();

  constructor(private ttlMs: number) {}

  isReplay(source: string, nonce: string, now = Date.now()): boolean {
    const key = `${source}:${nonce}`;
    const prev = this.seen.get(key);
    if (prev && now - prev < this.ttlMs) return true;

    this.seen.set(key, now);
    for (const [k, ts] of this.seen.entries()) {
      if (now - ts >= this.ttlMs) this.seen.delete(k);
    }
    return false;
  }
}
