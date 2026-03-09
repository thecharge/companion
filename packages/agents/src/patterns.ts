export const SKILL_INTENT_PATTERNS = [
  /(create|add|build|generate|acquire)\s+(a\s+)?skill\b/i,
  /(teach|learn)\s+(this|that|new)\s+(capability|skill)\b/i,
] as const;

export function hasSkillIntent(message: string): boolean {
  return SKILL_INTENT_PATTERNS.some((pattern) => pattern.test(message));
}
