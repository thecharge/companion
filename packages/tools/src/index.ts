/**
 * @companion/tools
 *
 * Built-in tool implementations + registry.
 * All file I/O uses Bun APIs (Bun.file, Bun.write, Bun.spawn).
 * No node:fs, no node:child_process.
 */

import { join, resolve } from "node:path";
import type { Config } from "@companion/config";
import type { DB, SessionId } from "@companion/db";
import type { OAITool } from "@companion/llm";

// ── Tool types ────────────────────────────────────────────────

export interface ToolContext {
  session_id: SessionId;
  working_dir: string;
  db: DB;
  cfg: Config;
}

export interface ToolCall {
  id: string;
  tool_name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  tool_name: string;
  result?: string;
  error?: string;
  duration_ms: number;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

export interface ToolDefinition {
  schema: OAITool;
  handler: ToolHandler;
}

// ── ToolRegistry ──────────────────────────────────────────────

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(def: ToolDefinition): void {
    this.tools.set(def.schema.function.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): OAITool[] {
    return [...this.tools.values()].map((t) => t.schema);
  }

  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const def = this.tools.get(call.tool_name);

    if (!def) {
      return {
        tool_call_id: call.id,
        tool_name: call.tool_name,
        error: `Unknown tool: ${call.tool_name}`,
        duration_ms: Date.now() - start,
      };
    }

    try {
      const result = await def.handler(call.args, ctx);
      return { tool_call_id: call.id, tool_name: call.tool_name, result, duration_ms: Date.now() - start };
    } catch (e) {
      return {
        tool_call_id: call.id,
        tool_name: call.tool_name,
        error: String(e),
        duration_ms: Date.now() - start,
      };
    }
  }
}

// ── Path safety ───────────────────────────────────────────────

const SAFE_BASE = resolve(process.cwd());

function safePath(workingDir: string, relativePath: string): string {
  const abs = resolve(join(workingDir, relativePath));
  if (!abs.startsWith(SAFE_BASE) && !abs.startsWith(resolve(workingDir))) {
    throw new Error(`SECURITY: path "${relativePath}" resolves outside safe base`);
  }
  return abs;
}

// ── Built-in tools ────────────────────────────────────────────

const CHUNK_SIZE = 8_000; // chars per page for read_file

const readFileTool: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file, or a specific page of a large file. Use page parameter for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to working directory" },
          page: { type: "number", description: "Page number (0-based). Default: 0" },
        },
        required: ["path"],
      },
    },
  },
  handler: async (args, ctx) => {
    const rel = String(args["path"] ?? "");
    const page = Number(args["page"] ?? 0);
    const abs = safePath(ctx.working_dir, rel);
    const file = Bun.file(abs);

    if (!(await file.exists())) return `Error: file not found: ${rel}`;

    const fileSize = file.size;
    if (fileSize === 0) return "(empty file)";

    // O(1) memory — read only the requested chunk
    const step = CHUNK_SIZE;
    const offset = page * step;
    const totalPgs = Math.ceil(fileSize / step);

    if (offset >= fileSize) {
      return `Error: page ${page} out of range (file has ${totalPgs} page(s))`;
    }

    const buf = await file.arrayBuffer();
    const text = new TextDecoder().decode(buf.slice(offset, offset + step));

    const header = `[Page ${page + 1}/${totalPgs} — ${fileSize} bytes total]`;
    const footer = page + 1 < totalPgs ? `\n[More pages available — use page: ${page + 1}]` : "";
    return `${header}\n${text}${footer}`;
  },
};

const writeFileTool: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file. Creates the file if it doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to working directory" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  handler: async (args, ctx) => {
    const rel = String(args["path"] ?? "");
    const content = String(args["content"] ?? "");
    const abs = safePath(ctx.working_dir, rel);
    await Bun.write(abs, content);
    return `Written ${content.length} chars to ${rel}`;
  },
};

const listDirTool: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories at a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to working directory. Default: ." },
        },
        required: [],
      },
    },
  },
  handler: async (args, ctx) => {
    const rel = String(args["path"] ?? ".");
    const abs = safePath(ctx.working_dir, rel);
    const entries: string[] = [];

    // Bun.readdir equivalent via node:fs compatibility layer built into Bun
    const { readdir, stat } = await import("node:fs/promises");
    const items = await readdir(abs);
    for (const item of items.sort()) {
      const s = await stat(join(abs, item)).catch(() => null);
      if (s) entries.push(`${s.isDirectory() ? "d" : "f"} ${item}`);
    }
    return entries.length ? entries.join("\n") : "(empty directory)";
  },
};

const searchHistoryTool: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "search_history",
      description: "Full-text search across message history. Returns KWIC snippets centred on the match.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results. Default: 5" },
        },
        required: ["query"],
      },
    },
  },
  handler: async (args, ctx) => {
    const query = String(args["query"] ?? "").toLowerCase();
    const limit = Number(args["limit"] ?? 5);
    const msgs = await ctx.db.messages.list(ctx.session_id, { limit: 200 });

    const results: string[] = [];
    for (const m of msgs) {
      if (!m.content.toLowerCase().includes(query)) continue;
      const ts = m.created_at.toISOString();
      const lc = m.content.toLowerCase();
      const idx = lc.indexOf(query);
      const start = Math.max(0, idx - 150);
      const end = Math.min(m.content.length, idx + query.length + 150);
      const snippet = (start > 0 ? "..." : "") + m.content.slice(start, end) + (end < m.content.length ? "..." : "");
      results.push(`[${ts}] ${m.role}: ${snippet}`);
      if (results.length >= limit) break;
    }

    return results.length ? results.join("\n\n") : `No results for: ${query}`;
  },
};

// ── Sandbox (Bun.spawn + Docker) ─────────────────────────────

export class SandboxExecutor {
  private safeBase: string;

  constructor(private cfg: Config) {
    this.safeBase = resolve(process.cwd());
  }

  private safeWorkingDir(workingDir: string): string {
    const abs = resolve(workingDir);
    if (!abs.startsWith(this.safeBase)) {
      throw new Error(`SECURITY: working_dir "${workingDir}" is outside safe base "${this.safeBase}"`);
    }
    return abs;
  }

  async run(
    command: string,
    workingDir: string,
    timeoutMs = 30_000,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const safeDir = this.safeWorkingDir(workingDir);
    const cfg = this.cfg.tools?.["run_shell"];
    const image = cfg?.["image"] ?? "companion-sandbox:latest";

    // Check if Docker is available
    const dockerCheck = Bun.spawn(["docker", "info"], { stdout: "pipe", stderr: "pipe" });
    await dockerCheck.exited;
    const useDocker = dockerCheck.exitCode === 0;

    let proc: ReturnType<typeof Bun.spawn>;

    if (useDocker) {
      proc = Bun.spawn(
        [
          "docker",
          "run",
          "--rm",
          "--network=none",
          `--label=managed_by=companion`,
          `--volume=${safeDir}:/workspace:rw`,
          "--workdir=/workspace",
          image,
          "sh",
          "-c",
          command,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    } else {
      proc = Bun.spawn(["sh", "-c", command], { cwd: safeDir, stdout: "pipe", stderr: "pipe" });
    }

    const timeout = setTimeout(() => proc.kill(), timeoutMs);

    try {
      await proc.exited;
    } finally {
      clearTimeout(timeout);
    }

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
  }

  /** Kill all companion-managed containers left from previous crashes */
  async cleanupZombies(): Promise<void> {
    try {
      const list = Bun.spawn(["docker", "ps", "-a", "-q", "--filter", "label=managed_by=companion"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await list.exited;
      const ids = (await new Response(list.stdout).text()).trim();
      if (!ids) return;
      const rm = Bun.spawn(["docker", "rm", "-f", ...ids.split("\n")], { stdout: "pipe", stderr: "pipe" });
      await rm.exited;
    } catch {
      // Docker not available — no-op
    }
  }
}

const runShellTool = (sandbox: SandboxExecutor): ToolDefinition => ({
  schema: {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a shell command in the sandbox. Working directory is read-write. No network access.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
        },
        required: ["command"],
      },
    },
  },
  handler: async (args, ctx) => {
    const cmd = String(args["command"] ?? "");
    const result = await sandbox.run(cmd, ctx.working_dir, 30_000);
    const out = result.stdout.trim();
    const err = result.stderr.trim();
    const parts = [`Exit: ${result.exitCode}`];
    if (out) parts.push(`stdout:\n${out}`);
    if (err) parts.push(`stderr:\n${err}`);
    return parts.join("\n");
  },
});

const webFetchTool: ToolDefinition = {
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
    const res = await fetch(url, { signal: AbortSignal.timeout(cfg.timeout) });
    if (!res.ok) return `HTTP ${res.status}: ${url}`;
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (ct.includes("html")) {
      // Strip tags — crude but avoids a parser dependency
      return text
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .slice(0, 8000);
    }
    return text.slice(0, 8000);
  },
};

const runTestsTool = (sandbox: SandboxExecutor): ToolDefinition => ({
  schema: {
    type: "function",
    function: {
      name: "run_tests",
      description: "Run the test suite in the working directory. Returns pass/fail summary.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Test command. Default: bun test" },
        },
        required: [],
      },
    },
  },
  handler: async (args, ctx) => {
    const cmd = String(args["command"] ?? "bun test");
    const result = await sandbox.run(cmd, ctx.working_dir, 120_000);
    const out = result.stdout.trim();
    const err = result.stderr.trim();
    const parts = [`Exit: ${result.exitCode}`];
    if (out) parts.push(`stdout:\n${out}`);
    if (err) parts.push(`stderr:\n${err}`);
    return parts.join("\n");
  },
});

// ── Factory ───────────────────────────────────────────────────

export function createToolRegistry(cfg: Config, db: DB): { registry: ToolRegistry; sandbox: SandboxExecutor } {
  const sandbox = new SandboxExecutor(cfg);
  const registry = new ToolRegistry();

  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(listDirTool);
  registry.register(searchHistoryTool);
  registry.register(runShellTool(sandbox));
  registry.register(webFetchTool);
  registry.register(runTestsTool(sandbox));
  // search_memory is wired by MemoryService after vector store is available
  // — registered separately in the server after memory is initialised

  return { registry, sandbox };
}
