# Provider Keys Guide

This guide documents where to obtain provider credentials and how to verify they match Companion runtime expectations.

## Important Copilot Note

GitHub Copilot does not provide a standard static public API key flow like OpenAI/Anthropic/Gemini/xAI.

For Companion:
- Prefer `ollama`, `anthropic`, `openai`, `gemini`, or `grok` aliases for deterministic server-side automation.
- Treat `copilot` as optional/advanced and only use it when you control a compatible auth proxy/token flow.

## Vendor Credential Sources

### Anthropic
- Console: `https://console.anthropic.com/`
- Create an API key from account/project settings.
- Use in config as `ANTHROPIC_API_KEY`.

### OpenAI
- Console: `https://platform.openai.com/api-keys`
- Create a secret key.
- Use in config as `OPENAI_API_KEY`.

### Google Gemini
- AI Studio: `https://aistudio.google.com/app/apikey`
- Create an API key.
- Use in config as `GEMINI_API_KEY`.

### xAI Grok
- Console: `https://console.x.ai/`
- Create an API key.
- Use in config as `GROK_API_KEY`.

## Mapping To `companion.yaml`

```yaml
models:
  smart:
    provider: anthropic
    api_key: ${ANTHROPIC_API_KEY:-}
  openai_fast:
    provider: openai
    api_key: ${OPENAI_API_KEY:-}
  gemini_fast:
    provider: gemini
    api_key: ${GEMINI_API_KEY:-}
  grok_fast:
    provider: grok
    api_key: ${GROK_API_KEY:-}
```

## Proof That Keys Match Runtime

Companion provider proof is implemented in `scripts/provider-proof.ts` and checks these endpoints:
- Anthropic: `GET /v1/models` with `x-api-key`
- OpenAI-compatible (`openai`, `grok`, optional `copilot`): `GET /models` with `Authorization: Bearer <key>`
- Gemini: `GET /models?key=<key>`
- Ollama: `GET /api/tags`

Run:

```bash
bun run proof:providers
```

Strict gate:

```bash
bun run proof:providers -- --strict
```

Interpreting output:
- `pass`: endpoint reachable and auth accepted
- `fail`: endpoint/auth/model check failed
- `skip`: key missing (strict mode treats skip as failure)

Copilot exception:
- If provider is `copilot` and no `api_key` is configured, proof reports a non-failing pass with a note because there is no standard static key flow.
