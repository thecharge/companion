import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackSignature(secret: string, timestamp: string, signature: string, rawBody: string): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;

  const payload = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", secret).update(payload).digest("hex")}`;

  const enc = new TextEncoder();
  const expectedBuf = enc.encode(expected);
  const receivedBuf = enc.encode(signature);
  if (expectedBuf.length !== receivedBuf.length) return false;

  return timingSafeEqual(expectedBuf, receivedBuf);
}
