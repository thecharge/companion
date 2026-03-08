import type { ToolDefinition } from "./types";

export function createWebFetchTool(): ToolDefinition {
  return {
    schema: {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch the text content of a URL.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" },
          },
          required: ["url"],
        },
      },
    },
    handler: async (args) => {
      const url = String(args["url"] ?? "");
      const cfg = { timeout: 15_000 };
      const res = await fetch(url, {
        signal: AbortSignal.timeout(cfg.timeout),
        headers: {
          "User-Agent": "Companion/1.0 (+https://github.com)",
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        },
      });
      if (!res.ok) return `HTTP ${res.status}: ${url}`;
      const ct = res.headers.get("content-type") ?? "";
      const text = await res.text();
      if (ct.includes("html")) {
        return text
          .replace(/<[^>]+>/g, " ")
          .replace(/\s{2,}/g, " ")
          .slice(0, 8000);
      }
      return text.slice(0, 8000);
    },
  };
}

export function createWeatherLookupTool(): ToolDefinition {
  return {
    schema: {
      type: "function",
      function: {
        name: "weather_lookup",
        description:
          "Lookup current weather for a city using Open-Meteo geocoding + forecast APIs. No API key required.",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name, e.g. Sofia" },
            country: { type: "string", description: "Optional country hint, e.g. Bulgaria" },
          },
          required: ["city"],
        },
      },
    },
    handler: async (args) => {
      const city = String(args["city"] ?? "").trim();
      const country = String(args["country"] ?? "").trim();
      if (!city) return "Error: city is required";

      const query = country ? `${city}, ${country}` : city;
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
      const geoRes = await fetch(geoUrl, {
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "Companion/1.0 (+https://github.com)", Accept: "application/json" },
      });
      if (!geoRes.ok) return `Geocoding failed: HTTP ${geoRes.status}`;

      const geo = (await geoRes.json()) as {
        results?: Array<{ name: string; country?: string; latitude: number; longitude: number; timezone?: string }>;
      };
      const hit = geo.results?.[0];
      if (!hit) return `No location match for ${query}`;

      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;

      const wxRes = await fetch(weatherUrl, {
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "Companion/1.0 (+https://github.com)", Accept: "application/json" },
      });
      if (!wxRes.ok) return `Weather lookup failed: HTTP ${wxRes.status}`;

      const wx = (await wxRes.json()) as {
        current?: {
          time?: string;
          temperature_2m?: number;
          apparent_temperature?: number;
          relative_humidity_2m?: number;
          wind_speed_10m?: number;
          weather_code?: number;
        };
      };
      const current = wx.current;
      if (!current) return `No current weather available for ${hit.name}`;

      return [
        `Weather for ${hit.name}${hit.country ? `, ${hit.country}` : ""}:`,
        `- Time: ${current.time ?? "n/a"}`,
        `- Temperature: ${current.temperature_2m ?? "n/a"} C`,
        `- Feels like: ${current.apparent_temperature ?? "n/a"} C`,
        `- Humidity: ${current.relative_humidity_2m ?? "n/a"}%`,
        `- Wind: ${current.wind_speed_10m ?? "n/a"} km/h`,
        `- Weather code: ${current.weather_code ?? "n/a"}`,
      ].join("\n");
    },
  };
}
