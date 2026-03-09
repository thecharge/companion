import type { Config } from "@companion/config";
import type { SessionId } from "@companion/core";
import type { DB } from "@companion/db";
import type { ToolContext, ToolRegistry } from "@companion/tools";

interface DirectToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export function parseDirectToolCalls(raw: string): DirectToolCall[] | null {
  const text = raw.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;

  try {
    const parsed = JSON.parse(text) as unknown;

    if (Array.isArray(parsed)) {
      return parseCallList(parsed);
    }

    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;

    if (Array.isArray(obj.tool_calls)) {
      return parseCallList(obj.tool_calls);
    }

    if (typeof obj.tool === "string" && isArgsRecord(obj.args)) {
      return [{ tool: obj.tool.trim(), args: obj.args }];
    }

    return null;
  } catch {
    return null;
  }
}

function parseCallList(input: unknown[]): DirectToolCall[] | null {
  const calls = input
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const obj = entry as Record<string, unknown>;
      const tool = String(obj.tool ?? "").trim();
      if (!tool || !isArgsRecord(obj.args)) return null;
      return { tool, args: obj.args };
    })
    .filter((entry): entry is DirectToolCall => Boolean(entry));

  return calls.length ? calls : null;
}

function isArgsRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function executeDirectToolCalls(params: {
  sessionId: SessionId;
  userMessage: string;
  workingDir: string;
  runtimeCfg: Config;
  registry: ToolRegistry;
  db: DB;
}): Promise<string | null> {
  const directCalls = parseDirectToolCalls(params.userMessage);
  if (!directCalls) return null;

  const toolContext: ToolContext = {
    session_id: params.sessionId,
    working_dir: params.workingDir,
    db: params.db,
    cfg: params.runtimeCfg,
  };

  const outputs: string[] = [];
  for (let i = 0; i < directCalls.length; i++) {
    const call = directCalls[i];
    if (!call) continue;

    if (!params.registry.get(call.tool)) {
      outputs.push(`[error] unknown tool: ${call.tool}`);
      continue;
    }

    const result = await params.registry.run(
      {
        id: `direct_${Date.now()}_${i}`,
        tool_name: call.tool,
        args: call.args,
      },
      toolContext,
    );

    if (result.error) {
      outputs.push(`[error] ${call.tool}: ${result.error}`);
    } else {
      outputs.push(`[ok] ${call.tool}: ${result.result ?? "done"}`);
    }
  }

  return outputs.join("\n");
}
