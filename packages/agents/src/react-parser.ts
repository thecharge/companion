import { Logger } from "@companion/core";
import type { ChatMessage } from "@companion/llm";

const log = new Logger("agents");

interface ReactPayload {
  thought?: string;
  action?: string;
  tool?: string;
  result?: string;
  args?: Record<string, unknown>;
}

function asJson(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function looksLikeAdvice(raw: string, cleaned: string): boolean {
  return (
    /\b(use|call|run|try|execute)\s+(the\s+)?(tool|run_shell|command)/i.test(raw) ||
    /you (should|need to|must|can)/i.test(raw) ||
    (!cleaned.startsWith("{") && cleaned.length > 0)
  );
}

function toolCall(tool: string, args: Record<string, unknown>, thought?: string): ChatMessage {
  return {
    role: "assistant",
    content: thought ?? null,
    tool_calls: [
      {
        id: `react_${Date.now()}`,
        type: "function",
        function: { name: tool, arguments: JSON.stringify(args) },
      },
    ],
  };
}

export async function parseReActMessage(
  response: ChatMessage,
  messages: ChatMessage[],
  llm: {
    chat: (params: { messages: ChatMessage[]; json_mode: boolean; signal?: AbortSignal }) => Promise<{
      choices: Array<{ message: ChatMessage }>;
    }>;
  },
  signal?: AbortSignal,
  depth = 0,
): Promise<ChatMessage> {
  const raw = response.content ?? "";
  const cleaned = asJson(raw);

  if (depth === 0 && looksLikeAdvice(raw, cleaned)) {
    log.warn(`Agent output advice instead of JSON - re-prompting (depth ${depth}): ${raw.slice(0, 80)}`);
    try {
      const fix = await llm.chat({
        messages: [
          ...messages,
          { role: "assistant", content: raw },
          {
            role: "user",
            content:
              'Wrong format. You must output JSON, not instructions. Output the JSON tool call NOW:\n{"thought":"running command","tool":"run_shell","args":{"command":"uptime && cat /proc/loadavg"}}',
          },
        ],
        json_mode: true,
        signal,
      });
      return parseReActMessage(fix.choices[0]?.message, messages, llm, signal, depth + 1);
    } catch {
      return { role: "assistant", content: raw };
    }
  }

  let parsed: ReactPayload;
  try {
    parsed = JSON.parse(cleaned) as ReactPayload;
  } catch {
    if (depth >= 1) {
      log.warn("ReAct parse failed after recovery - using raw text");
      return { role: "assistant", content: raw };
    }

    try {
      const fix = await llm.chat({
        messages: [
          ...messages,
          { role: "assistant", content: raw },
          { role: "user", content: `Invalid JSON. Reply with ONLY valid JSON, no markdown:\n${raw.slice(0, 150)}` },
        ],
        json_mode: true,
        signal,
      });
      return parseReActMessage(fix.choices[0]?.message, messages, llm, signal, depth + 1);
    } catch {
      return { role: "assistant", content: raw };
    }
  }

  if (parsed.action === "final_answer" || !parsed.tool) {
    return { role: "assistant", content: parsed.result ?? parsed.thought ?? raw };
  }

  return toolCall(parsed.tool, parsed.args ?? {}, parsed.thought);
}
