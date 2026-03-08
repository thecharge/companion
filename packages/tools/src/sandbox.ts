import { resolve } from "node:path";
import type { Config, SandboxConfig } from "@companion/config";
import { safeWorkingDir } from "./path-safety";
import type { ToolDefinition } from "./types";

export type SandboxStrategyResolved =
  | { kind: "container"; runtime: "docker" | "podman" | "nerdctl"; image: string; network: string }
  | { kind: "direct"; warning: string }
  | { kind: "refused"; reason: string };

async function probeRuntime(binary: string): Promise<boolean> {
  try {
    const p = Bun.spawn([binary, "info"], { stdout: "pipe", stderr: "pipe" });
    await p.exited;
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

async function hasImage(runtime: "docker" | "podman" | "nerdctl", image: string): Promise<boolean> {
  try {
    const proc =
      runtime === "podman"
        ? Bun.spawn([runtime, "image", "exists", image], { stdout: "pipe", stderr: "pipe" })
        : Bun.spawn([runtime, "image", "inspect", image], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function resolveStrategy(cfg: SandboxConfig): Promise<SandboxStrategyResolved> {
  const { runtime, allow_direct_fallback, image, network } = cfg;

  if (runtime !== "auto" && runtime !== "direct") {
    const ok = await probeRuntime(runtime);
    if (ok) {
      const imageReady = await hasImage(runtime, image);
      if (imageReady) return { kind: "container", runtime, image, network };
      if (allow_direct_fallback) {
        return {
          kind: "direct",
          warning: `Container runtime ${runtime} is available but image "${image}" is missing. Falling back to direct host execution. Build image first for full isolation.`,
        };
      }
      return {
        kind: "refused",
        reason:
          `Container runtime ${runtime} is available but image "${image}" is missing. ` +
          `Build it (docker/podman build -t ${image} docker/sandbox) or enable sandbox.allow_direct_fallback.`,
      };
    }
    return {
      kind: "refused",
      reason:
        `sandbox.runtime is set to "${runtime}" but it is not available. ` +
        `Install ${runtime} or change sandbox.runtime in companion.yaml.`,
    };
  }

  if (runtime === "direct") {
    return {
      kind: "direct",
      warning: 'sandbox.runtime is set to "direct" — commands run unsandboxed on the host.',
    };
  }

  for (const rt of ["docker", "podman", "nerdctl"] as const) {
    if (await probeRuntime(rt)) {
      const imageReady = await hasImage(rt, image);
      if (imageReady) return { kind: "container", runtime: rt, image, network };

      if (allow_direct_fallback) {
        return {
          kind: "direct",
          warning: `Found ${rt}, but image "${image}" is missing. Falling back to direct host execution. Build the sandbox image to re-enable container isolation.`,
        };
      }

      return {
        kind: "refused",
        reason:
          `Found ${rt}, but image "${image}" is missing and direct fallback is disabled. ` +
          `Build it (docker/podman build -t ${image} docker/sandbox).`,
      };
    }
  }

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
  private strategy: SandboxStrategyResolved | null = null;

  constructor(private readonly cfg: Config) {
    this.safeBase = resolve(process.cwd());
    this.sandboxCfg = cfg.sandbox;
  }

  async probe(): Promise<SandboxStrategyResolved> {
    this.strategy = await resolveStrategy(this.sandboxCfg);
    return this.strategy;
  }

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

  async run(
    command: string,
    workingDir: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.strategy) await this.probe();
    const strategy = this.strategy;
    if (!strategy) throw new Error("Sandbox strategy unavailable after probe");
    if (strategy.kind === "refused") throw new Error(`Shell execution refused: ${strategy.reason}`);

    const safeDir = safeWorkingDir(workingDir);
    if (!safeDir.startsWith(this.safeBase)) {
      throw new Error(`SECURITY: working_dir "${workingDir}" escapes safe base "${this.safeBase}"`);
    }

    const collect = async (proc: {
      exited: Promise<number>;
      kill: () => void;
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      exitCode: number | null;
    }) => {
      const timer = setTimeout(() => proc.kill(), timeoutMs);
      try {
        await proc.exited;
      } finally {
        clearTimeout(timer);
      }
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
    };

    if (strategy.kind === "container") {
      const { runtime, image, network } = strategy;
      const proc = Bun.spawn(
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
      return collect(proc);
    }

    const proc = Bun.spawn(["sh", "-c", command], { cwd: safeDir, stdout: "pipe", stderr: "pipe" });
    return collect(proc);
  }

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
      const idsArr = ids.split("\n").filter(Boolean);
      if (!idsArr.length) return;
      const rm = Bun.spawn([runtime, "rm", "-f", ...idsArr], { stdout: "pipe", stderr: "pipe" });
      await rm.exited;
    } catch {
      // non-fatal
    }
  }
}

export function createRunShellTool(sandbox: SandboxExecutor): ToolDefinition {
  return {
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
  };
}

export function createRunTestsTool(sandbox: SandboxExecutor): ToolDefinition {
  return {
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
  };
}
