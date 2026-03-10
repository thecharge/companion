export class HttpRepository {
  async postJson<T>(
    url: string,
    init: { headers: Record<string, string>; body: unknown; timeoutMs: number; signal?: AbortSignal },
  ): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: init.headers,
      body: JSON.stringify(init.body),
      signal: init.signal ?? AbortSignal.timeout(init.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json() as Promise<T>;
  }

  async postStream(
    url: string,
    init: { headers: Record<string, string>; body: unknown; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(url, {
      method: "POST",
      headers: init.headers,
      body: JSON.stringify(init.body),
      signal: init.signal ?? AbortSignal.timeout(init.timeoutMs),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.body;
  }
}
