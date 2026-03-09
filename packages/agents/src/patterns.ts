export const SKILL_INTENT_PATTERNS = [
  /(create|add|build|generate|acquire)\s+(a\s+)?skill\b/i,
  /(teach|learn)\s+(this|that|new)\s+(capability|skill)\b/i,
] as const;

const FILE_TASK_PATTERNS = [
  /\b(create|edit|modify|update|write|append|rename|delete)\b.*\b(file|files|config|source|code)\b/i,
  /\bmake\b.*\bfile\b/i,
  /\bpatch\b.*\bfile\b/i,
] as const;

const SYSTEM_TASK_PATTERNS = [
  /\b(system\s+load|cpu\s+load|load\s+average|uptime|memory\s+usage|disk\s+usage|top)\b/i,
  /\b(current\s+load|host\s+load)\b/i,
] as const;

const WEATHER_TASK_PATTERNS = [
  /\b(weather|temperature|forecast|rain|wind|humidity)\b/i,
  /\bwhat(?:'s| is)\s+the\s+weather\b/i,
] as const;

export function hasSkillIntent(message: string): boolean {
  return SKILL_INTENT_PATTERNS.some((pattern) => pattern.test(message));
}

export function hasFileTaskIntent(message: string): boolean {
  return FILE_TASK_PATTERNS.some((pattern) => pattern.test(message));
}

export function hasSystemTaskIntent(message: string): boolean {
  return SYSTEM_TASK_PATTERNS.some((pattern) => pattern.test(message));
}

export function hasWeatherTaskIntent(message: string): boolean {
  return WEATHER_TASK_PATTERNS.some((pattern) => pattern.test(message));
}
