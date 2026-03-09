import { join } from "node:path";
import { safePath } from "./path-safety";
import type { ToolDefinition } from "./types";

const CHUNK_SIZE = 8_000;

export function createReadFileTool(): ToolDefinition {
  return {
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

      const offset = page * CHUNK_SIZE;
      const totalPgs = Math.ceil(fileSize / CHUNK_SIZE);
      if (offset >= fileSize) return `Error: page ${page} out of range (file has ${totalPgs} page(s))`;

      const buf = await file.arrayBuffer();
      const text = new TextDecoder().decode(buf.slice(offset, offset + CHUNK_SIZE));
      const header = `[Page ${page + 1}/${totalPgs} — ${fileSize} bytes total]`;
      const footer = page + 1 < totalPgs ? `\n[More pages available — use page: ${page + 1}]` : "";
      return `${header}\n${text}${footer}`;
    },
  };
}

export function createWriteFileTool(): ToolDefinition {
  return {
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
}

export function createListDirTool(): ToolDefinition {
  return {
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
      const { readdir, stat } = await import("node:fs/promises");
      const items = await readdir(abs);
      for (const item of items.sort()) {
        const s = await stat(join(abs, item)).catch(() => null);
        if (s) entries.push(`${s.isDirectory() ? "d" : "f"} ${item}`);
      }
      return entries.length ? entries.join("\n") : "(empty directory)";
    },
  };
}

export function createSearchHistoryTool(): ToolDefinition {
  return {
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
}

export function createSearchCodeTool(): ToolDefinition {
  return {
    schema: {
      type: "function",
      function: {
        name: "search_code",
        description: "Search source files using ripgrep for symbols, snippets, or errors.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Regex or plain text query" },
            path: { type: "string", description: "Directory path relative to working directory. Default: ." },
            limit: { type: "number", description: "Maximum result lines. Default: 50" },
          },
          required: ["query"],
        },
      },
    },
    handler: async (args, ctx) => {
      const query = String(args["query"] ?? "").trim();
      const rel = String(args["path"] ?? ".");
      const limit = Math.max(1, Math.min(500, Number(args["limit"] ?? 50)));
      if (!query) return "Error: query is required";

      const abs = safePath(ctx.working_dir, rel);
      const proc = Bun.spawn(["rg", "-n", "--no-heading", "--hidden", query, abs], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (proc.exitCode !== 0 && proc.exitCode !== 1) {
        return `Error running rg: ${stderr || "unknown error"}`;
      }

      const lines = stdout.split("\n").filter(Boolean).slice(0, limit);
      if (!lines.length) return `No code results for: ${query}`;
      return lines.join("\n");
    },
  };
}

export function createRepoMapTool(): ToolDefinition {
  return {
    schema: {
      type: "function",
      function: {
        name: "repo_map",
        description: "Summarise repository structure with shallow tree for fast orientation.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path relative to working directory. Default: ." },
            depth: { type: "number", description: "Traversal depth (1-5). Default: 2" },
            limit: { type: "number", description: "Maximum displayed entries. Default: 200" },
          },
          required: [],
        },
      },
    },
    handler: async (args, ctx) => {
      const rel = String(args["path"] ?? ".");
      const depth = Math.max(1, Math.min(5, Number(args["depth"] ?? 2)));
      const limit = Math.max(20, Math.min(1000, Number(args["limit"] ?? 200)));
      const abs = safePath(ctx.working_dir, rel);
      const { readdir } = await import("node:fs/promises");
      const output: string[] = [];

      const walk = async (base: string, level: number): Promise<void> => {
        if (output.length >= limit || level > depth) return;
        const entries = await readdir(base, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (output.length >= limit) return;
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          const prefix = "  ".repeat(level - 1);
          output.push(`${prefix}${entry.isDirectory() ? "d" : "f"} ${entry.name}`);
          if (entry.isDirectory()) {
            await walk(join(base, entry.name), level + 1);
          }
        }
      };

      await walk(abs, 1);
      return output.length ? output.join("\n") : "(empty repository view)";
    },
  };
}
