/**
 * @companion/llm
 *
 * Unified LLM client over the OpenAI wire format.
 * Supports: Anthropic, OpenAI, Ollama, Gemini, GitHub Copilot, Grok (xAI).
 *
 * All network calls use Bun's built-in fetch — no node-fetch, no axios.
 */
import { INJECTION_PATTERNS, MAX_MESSAGE_CONTENT_LENGTH } from "./constants";
import { type LLMMessage, LLMMessagesRole } from "./types";

export const ErrorFactory = {
  MissingContent: () => "Content is required to generate an LLM message.",
  InvalidContentType: (type: string) => `Invalid content type: ${type}. Content must be a string.`,
  InvalidRole: (role: string) => `Invalid role: ${role}. Valid roles are: ${Object.values(LLMMessagesRole).join(", ")}`,
  MaxContentLengthExceeded: () => `Content exceeds maximum length of ${MAX_MESSAGE_CONTENT_LENGTH} characters.`,
  DetectedPromptInjection: () => "Content contains potential prompt injection patterns.",
} as const;

export const generateLMMMessage = async (
  content: string,
  role: LLMMessagesRole = LLMMessagesRole.User,
): Promise<LLMMessage> => {
  return new Promise((resolve, reject) => {
    try {
      // Basic validation to ensure content is provided and of the correct type, and that the role is valid.
      if (!content || !content.length) {
        throw new Error(ErrorFactory.MissingContent());
      }

      // Validate role and content type
      if (!Object.values(LLMMessagesRole).includes(role)) {
        throw new Error(ErrorFactory.InvalidRole(role));
      }

      // Ensure content is a string
      if (typeof content !== "string" || !content) {
        throw new Error(ErrorFactory.InvalidContentType(typeof content));
      }

      // Ensure overflow content is truncated to 1000 characters
      if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
        throw new Error(ErrorFactory.MaxContentLengthExceeded());
      }

      // check for prompt injection attack patterns (e.g., presence of system role indicators in user content)
      if (INJECTION_PATTERNS.some((pattern) => pattern.test(content))) {
        throw new Error(ErrorFactory.DetectedPromptInjection());
      }

      resolve({
        role,
        content,
      });
    } catch (error) {
      reject(error);
    }
  });
};
