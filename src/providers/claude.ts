import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  query,
  type Options,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import { within, type Config } from "../config.js";
import { logProvider, stopChild, workerPrompt, managerMcp } from "./common.js";
import { claudeEnvironment, assertClaudeApiAuth } from "../auth.js";
import type { Adapter, Mode, Model, RunInput, RunResult } from "../types.js";
export function toolDecision(
  root: string,
  mode: Mode,
  name: string,
  data: any,
  readRoots: string[] = [],
): string | undefined {
  if (name === "Bash")
    return mode === "edit"
      ? undefined
      : "Read-only workers cannot execute shell commands";
  if (name === "AskUserQuestion")
    return "Return NEEDS_INPUT with the question to the manager";
  if (
    name === "Glob" &&
    typeof data?.pattern === "string" &&
    (path.isAbsolute(data.pattern) ||
      data.pattern.includes("..") ||
      /(^|[({,])[~/]/.test(data.pattern))
  )
    return "Glob patterns must be relative and cannot traverse outside their search root";
  if (
    ![
      "Read",
      "Glob",
      "Grep",
      ...(mode === "edit" ? ["Write", "Edit"] : []),
    ].includes(name)
  )
    return `Tool ${name} is not in the delegated grant`;
  const raw = data?.file_path || data?.path || root;
  const full = path.resolve(root, raw);
  const roots = ["Read", "Glob", "Grep"].includes(name)
    ? [root, ...readRoots]
    : [root];
  if (!roots.some((r) => within(r, full)))
    return "Path is outside the delegated workspace";
  let existing = full;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing))
    existing = path.dirname(existing);
  if (!roots.some((r) => within(fs.realpathSync(r), fs.realpathSync(existing))))
    return "Symlink escapes delegated workspace";
  if (full.split(path.sep).includes(".git") && ["Write", "Edit"].includes(name))
    return "Git metadata is outside the edit grant";
  return undefined;
}
export class ClaudeAdapter implements Adapter {
  constructor(private cfg: Config) {}
  base(cwd: string, children: ChildProcess[]): Options {
    return {
      cwd,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      env: claudeEnvironment(this.cfg),
      settings: { syncSkills: false, syncPlugins: false },
      spawnClaudeCodeProcess: (options) => {
        const child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          detached: true,
        });
        children.push(child);
        return child;
      },
    };
  }
  async models(): Promise<Model[]> {
    const children: ChildProcess[] = [];
    let end!: () => void;
    const hold = new Promise<void>((r) => {
      end = r;
    });
    async function* idle(): AsyncGenerator<any> {
      await hold;
    }
    const q = query({
      prompt: idle(),
      options: {
        ...this.base(this.cfg.stateDir, children),
        tools: [],
        permissionMode: "dontAsk",
      },
    });
    try {
      const models = await Promise.race([
        (async () => {
          assertClaudeApiAuth(await q.accountInfo());
          return q.supportedModels();
        })(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error("Claude model discovery timed out")),
            20000,
          );
          t.unref();
        }),
      ]);
      return models.flatMap((m) => [
        { id: m.value, name: m.displayName, efforts: m.supportedEffortLevels },
        ...(m.resolvedModel && m.resolvedModel !== m.value
          ? [
              {
                id: m.resolvedModel,
                name: m.displayName,
                efforts: m.supportedEffortLevels,
              },
            ]
          : []),
      ]);
    } finally {
      end();
      q.close();
      await Promise.all(children.map(stopChild));
    }
  }
  async run(input: RunInput): Promise<RunResult> {
    const children: ChildProcess[] = [];
    let needsInput: string | undefined;
    const preTool: HookCallback = async (event) => {
      if (event.hook_event_name !== "PreToolUse") return {};
      const reason =
        input.manager && event.tool_name.startsWith("mcp__agent_team__team_")
          ? undefined
          : toolDecision(
              input.job.workspace,
              input.job.mode,
              event.tool_name,
              event.tool_input,
              input.job.capabilityReadRoots,
            );
      if (reason) {
        needsInput = reason;
        input.emit("question", { question: reason, tool: event.tool_name });
      }
      input.emit("activity", { tool: event.tool_name });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: reason ? "deny" : "allow",
          ...(reason ? { permissionDecisionReason: reason } : {}),
        },
      };
    };
    let begin!: () => void;
    let authorized = false;
    const ready = new Promise<void>((r) => {
      begin = r;
    });
    const prompt = workerPrompt(input);
    input.emit("input", { bytes: Buffer.byteLength(prompt) });
    async function* messages(): AsyncGenerator<any> {
      await ready;
      if (!authorized) return;
      yield {
        type: "user",
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
        session_id: input.job.nativeId || "",
      };
    }
    const controller = new AbortController();
    const q = query({
      prompt: messages(),
      options: {
        ...this.base(input.job.workspace, children),
        abortController: controller,
        spawnClaudeCodeProcess: (options) => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
            detached: true,
          });
          children.push(child);
          if (child.pid) input.emit("process", { pid: child.pid });
          return child;
        },
        mcpServers: input.manager ? { agent_team: managerMcp(input)! } : {},
        model: input.job.model,
        effort: input.job.effort as Options["effort"],
        resume: input.job.nativeId,
        tools: [
          "Read",
          "Glob",
          "Grep",
          "AskUserQuestion",
          ...(input.job.mode === "edit" ? ["Write", "Edit", "Bash"] : []),
        ],
        permissionMode: "default",
        hooks: { PreToolUse: [{ hooks: [preTool] }] },
        maxTurns: input.job.mode === "edit" ? 50 : 20,
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          network: {
            allowedDomains: [],
            strictAllowlist: true,
            allowAllUnixSockets: false,
          },
          filesystem: {
            allowWrite: input.job.mode === "edit" ? [input.job.workspace] : [],
            denyWrite: [path.join(input.job.workspace, ".git")],
          },
        },
        canUseTool: async (name, data) => {
          needsInput = `Tool requires permission beyond delegated scope: ${name}`;
          input.emit("question", { question: needsInput, input: data });
          return { behavior: "deny", message: needsInput };
        },
      },
    });
    const abort = () => {
      controller.abort();
      q.close();
      void Promise.all(children.map(stopChild));
    };
    input.signal.addEventListener("abort", abort, { once: true });
    let text = "",
      nativeId = input.job.nativeId,
      model: string | undefined;
    try {
      if (input.signal.aborted) throw new Error("Job interrupted");
      assertClaudeApiAuth(await q.accountInfo());
      authorized = true;
      begin();
      for await (const event of q) {
        if (event.type === "system" && event.subtype === "init") {
          nativeId = event.session_id;
          model = event.model;
          input.emit("session", { nativeId, model });
        } else if (event.type === "assistant") {
          // Persist ordinary messages/tool calls, never forward private thinking blocks.
          const content = event.message.content.filter(
            (c) => c.type !== "thinking" && c.type !== "redacted_thinking",
          );
          logProvider(input, { type: event.type, content });
          text =
            content
              .filter((c) => c.type === "text")
              .map((c) => (c.type === "text" ? c.text : ""))
              .join("\n") || text;
        } else if (event.type === "result") {
          logProvider(input, event);
          if (event.subtype !== "success")
            throw new Error(
              `Claude ${event.subtype}: ${event.errors?.join("; ") || "No successful result"}`,
            );
          text = event.result || text;
          return {
            text,
            nativeId: event.session_id,
            model,
            usage: {
              usage: event.usage,
              modelUsage: event.modelUsage,
              reportedCostUsd: event.total_cost_usd,
            },
            needsInput:
              needsInput || (/NEEDS_INPUT:/i.test(text) ? text : undefined),
          };
        }
      }
      throw new Error("Claude stream ended without a successful result");
    } finally {
      input.signal.removeEventListener("abort", abort);
      q.close();
      begin();
      await Promise.all(children.map(stopChild));
    }
  }
}
