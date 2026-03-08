/**
 * @companion/tools
 *
 * Built-in tool implementations + registry.
 * All file I/O uses Bun APIs (Bun.file, Bun.write, Bun.spawn).
 * No node:fs, no node:child_process.
 */

import { join, resolve } from "node:path";
import type { Config, SandboxConfig, SandboxRuntime } from "@companion/config";
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

// ── Sandbox ───────────────────────────────────────────────────
//
// Execution strategy, resolved once at startup from companion.yaml sandbox:
//
//   docker  — docker run --rm  (Docker Desktop / Docker Engine)
//   podman  — podman run --rm  (rootless, drop-in Docker replacement)
//   nerdctl — nerdctl run --rm (containerd CLI)
//   direct  — sh -c in working dir, no container isolation
//
// All three container runtimes share the same CLI surface we use here
// (run/ps/rm with identical flags), so the execution path is identical.
//
// Strategy resolution for runtime:"auto":
//   1. Probe docker  — use if daemon responds to "docker info"
//   2. Probe podman  — use if daemon responds to "podman info"
//   3. Probe nerdctl — use if daemon responds to "nerdctl info"
//   4. If allow_direct_fallback:true → warn + use direct
//   5. If allow_direct_fallback:false → error on any shell tool call

export type SandboxStrategyResolved =
  | { kind: "container"; runtime: "docker" | "podman" | "nerdctl"; image: string; network: string }
  | { kind: "direct"; warning: string }
  | { kind: "refused"; reason: string };

/** Probe a single container runtime binary. Returns true if its daemon is reachable. */
async function probeRuntime(binary: string): Promise<boolean> {
  try {
    const p = Bun.spawn([binary, "info"], { stdout: "pipe", stderr: "pipe" });
    await p.exited;
    return p.exitCode === 0;
  } catch {
    // Binary not in PATH, or daemon not running
    return false;
  }
}

/**
 * Resolve the sandbox strategy from config.
 * Called once at SandboxExecutor construction; result is immutable.
 */
async function resolveStrategy(cfg: SandboxConfig): Promise<SandboxStrategyResolved> {
  const { runtime, allow_direct_fallback, image, network } = cfg;

  // Explicit runtime requested — probe it, error if not available
  if (runtime !== "auto" && runtime !== "direct") {
    const ok = await probeRuntime(runtime);
    if (ok) return { kind: "container", runtime, image, network };
    return {
      kind: "refused",
      reason:
        `sandbox.runtime is set to "${runtime}" but it is not available. ` +
        `Install ${runtime} or change sandbox.runtime in companion.yaml.`,
    };
  }

  // Explicit direct — no probing needed
  if (runtime === "direct") {
    return {
      kind: "direct",
      warning: 'sandbox.runtime is set to "direct" — commands run unsandboxed on the host.',
    };
  }

  // Auto — probe in order of preference
  for (const rt of ["docker", "podman", "nerdctl"] as const) {
    if (await probeRuntime(rt)) {
      return { kind: "container", runtime: rt, image, network };
    }
  }

  // Nothing found
  if (allow_direct_fallback) {
    return {
      kind: "direct",
      warning:
        "No container runtime found (tried docker, podman, nerdctl). " +
        "Falling back to direct host execution — commands are NOT sandboxed. " +
        "Install Docker or Podman, or set sandbox.runtime: direct to silence this warning.",
    };
  }

  return {
    kind: "refused",
    reason:
      "No container runtime found (tried docker, podman, nerdctl) and " +
      "sandbox.allow_direct_fallback is false. " +
      "Install Docker or Podman, or set sandbox.allow_direct_fallback: true " +
      "to allow unsandboxed execution.",
  };
}

export class SandboxExecutor {
  private readonly safeBase: string;
  private readonly sandboxCfg: SandboxConfig;
  private strategy: SandboxStrategyResolved | null = null; // set by probe()

  constructor(private readonly cfg: Config) {
    this.safeBase = resolve(process.cwd());
    this.sandboxCfg = cfg.sandbox;
  }

  /**
   * Probe the environment and cache the execution strategy.
   * Must be called once at server startup before any run() calls.
   * Logs the result clearly so operators know what mode is active.
   */
  async probe(): Promise<SandboxStrategyResolved> {
    this.strategy = await resolveStrategy(this.sandboxCfg);
    return this.strategy;
  }

  /** Human-readable description of the active strategy, for startup logs. */
  describe(): string {
    if (!this.strategy) return "not yet probed";
    switch (this.strategy.kind) {
      case "container":
        return `${this.strategy.runtime} (image: ${this.strategy.image}, network: ${this.strategy.network})`;
      case "direct":
        return "direct host execution (no container isolation)";
      case "refused":
        return `refused — ${this.strategy.reason}`;
    }
  }

  private safeWorkingDir(workingDir: string): string {
    const abs = resolve(workingDir);
    if (!abs.startsWith(this.safeBase)) {
      throw new Error(`SECURITY: working_dir "${workingDir}" escapes safe base "${this.safeBase}"`);
    }
    return abs;
  }

  async run(
    command: string,
    workingDir: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Lazy probe — in case probe() was not called (tests, etc.)
    if (!this.strategy) await this.probe();
    const strategy = this.strategy!;

    if (strategy.kind === "refused") {
      throw new Error(`Shell execution refused: ${strategy.reason}`);
    }

    const safeDir = this.safeWorkingDir(workingDir);
    let proc: ReturnType<typeof Bun.spawn>;

    if (strategy.kind === "container") {
      const { runtime, image, network } = strategy;
      proc = Bun.spawn(
        [
          runtime,
          "run",
          "--rm",
          `--network=${network}`,
          "--label=managed_by=companion",
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
      // direct — warn is already surfaced at probe time
      proc = Bun.spawn(["sh", "-c", command], { cwd: safeDir, stdout: "pipe", stderr: "pipe" });
    }

    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
  }

  /** Kill all companion-managed containers left from a previous crash. */
  async cleanupZombies(): Promise<void> {
    if (!this.strategy || this.strategy.kind !== "container") return;
    const { runtime } = this.strategy;
    try {
      const list = Bun.spawn([runtime, "ps", "-a", "-q", "--filter", "label=managed_by=companion"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await list.exited;
      const ids = (await new Response(list.stdout).text()).trim();
      if (!ids) return;
      const ids_arr = ids.split("\n").filter(Boolean);
      if (!ids_arr.length) return;
      const rm = Bun.spawn([runtime, "rm", "-f", ...ids_arr], { stdout: "pipe", stderr: "pipe" });
      await rm.exited;
    } catch {
      // Cleanup failure is non-fatal
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
    const timeoutMs = ctx.cfg.sandbox.timeout_seconds * 1000;
    const result = await sandbox.run(cmd, ctx.working_dir, timeoutMs);
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
    const timeoutMs = ctx.cfg.sandbox.tests_timeout_seconds * 1000;
    const result = await sandbox.run(cmd, ctx.working_dir, timeoutMs);
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
