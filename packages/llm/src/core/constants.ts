/**
 * @companion/llm
 *
 * Unified LLM client over the OpenAI wire format.
 * Supports: Anthropic, OpenAI, Ollama, Gemini, GitHub Copilot, Grok (xAI).
 *
 * All network calls use Bun's built-in fetch — no node-fetch, no axios.
 */
export const MAX_MESSAGE_CONTENT_LENGTH = 256_000;

export const INJECTION_PATTERNS = [/system:/i, /assistant:/i, /user:/i];

// @TODO: explore for additional patterns like:
// Matches zero-width characters
// biome-ignore lint/suspicious/noMisleadingCharacterClass: <explanation>
export const ZERO_WIDTH_PATTERNS = /[\u200B-\u200D\uFEFF]/g;

export const EMOJI_PATTERN = /[\p{Emoji}\u200D]+/gu;
