import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { childEnvironment, type Config } from "../config.js";
import type { Adapter, Model, RunInput, RunResult } from "../types.js";
import { logProvider, stopChild, workerPrompt, managerMcp } from "./common.js";
export class RpcProcess {
  child: ChildProcessWithoutNullStreams;
  next = 1;
  buffer = "";
  failure?: Error;
  pending = new Map<
    number,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  onEvent: (msg: any) => void = () => {};
  constructor(bin: string, args: string[], cwd: string) {
    this.child = spawn(bin, args, {
      cwd,
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024)
        return this.fail(new Error("Codex protocol frame exceeds 4 MiB"));
      let i: number;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          const p = this.pending.get(m.id);
          if (p && !m.method) {
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            if (m.error) p.reject(new Error(m.error.message));
            else p.resolve(m.result);
          } else this.onEvent(m);
        } catch (e) {
          this.fail(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
    let stderr = "";
    this.child.stderr.on("data", (b) => {
      stderr = (stderr + String(b)).slice(-3000);
    });
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", (code, signal) =>
      this.fail(
        new Error(`Codex process exited (${code ?? signal}): ${stderr}`),
      ),
    );
  }
  fail(e: Error) {
    if (this.failure) return;
    this.failure = e;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.onEvent({
      method: "bridge/processError",
      params: { message: e.message },
    });
  }
  send(m: unknown) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(m) + "\n");
  }
  request(method: string, params: unknown, timeout = 30000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "agent_team_bridge",
        title: "Local Agent Team Bridge",
        version: "0.1.0",
      },
    });
    this.send({ method: "initialized", params: {} });
  }
  async close() {
    await stopChild(this.child);
  }
}
export function invocationConfig() {
  const overrides: string[] = [
    "hooks={}",
    "features.multi_agent=false",
    'web_search="disabled"',
    "sandbox_workspace_write.network_access=false",
  ];
  try {
    const cfg: any = parse(
      fs.readFileSync(path.join(os.homedir(), ".codex/config.toml"), "utf8"),
    );
    for (const name of Object.keys(cfg.mcp_servers || {})) {
      if (name.includes("."))
        throw new Error(
          "MCP server names containing dots need explicit bridge configuration",
        );
      overrides.push(`mcp_servers.${name}.enabled=false`);
    }
    for (const name of Object.keys(cfg.plugins || {})) {
      if (name.includes("."))
        throw new Error(
          "Plugin names containing dots need explicit bridge configuration",
        );
      overrides.push(`plugins.${name}.enabled=false`);
    }
    if (cfg.model_provider && cfg.model_provider !== "openai")
      throw new Error(
        "Subscription-only bridge requires the OpenAI Codex provider",
      );
    if (cfg.openai_base_url)
      throw new Error(
        "Custom Codex provider URL requires explicit bridge configuration",
      );
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  return overrides.flatMap((x) => ["-c", x]);
}
export class CodexAdapter implements Adapter {
  constructor(private cfg: Config) {}
  open(cwd: string, input?: RunInput) {
    const args = invocationConfig();
    const mcp = input && managerMcp(input);
    if (mcp) {
      for (const [key, value] of Object.entries({
        enabled: true,
        command: mcp.command,
        args: mcp.args,
      }))
        args.push(
          "-c",
          `mcp_servers.agent_team.${key}=${JSON.stringify(value)}`,
        );
      for (const [key, value] of Object.entries(mcp.env))
        args.push(
          "-c",
          `mcp_servers.agent_team.env.${key}=${JSON.stringify(value)}`,
        );
      for (const name of [
        "delegate",
        "send",
        "read",
        "status",
        "models",
        "control",
        "finish",
        "catalog",
        "capability",
        "sessions",
        "session_read",
      ])
        args.push(
          "-c",
          `mcp_servers.agent_team.tools.team_${name}.approval_mode="approve"`,
        );
    }
    return new RpcProcess(
      this.cfg.codexBin,
      ["app-server", "--listen", "stdio://", ...args],
      cwd,
    );
  }
  async models(): Promise<Model[]> {
    const rpc = this.open(this.cfg.stateDir);
    try {
      await rpc.initialize();
      const r = await rpc.request("model/list", {});
      return r.data.map((m: any) => ({
        id: m.model,
        name: m.displayName,
        default: m.isDefault,
        efforts: m.supportedReasoningEfforts?.map(
          (e: any) => e.reasoningEffort,
        ),
      }));
    } finally {
      await rpc.close();
    }
  }
  async run(input: RunInput): Promise<RunResult> {
    const rpc = this.open(input.job.workspace, input);
    let threadId = input.job.nativeId;
    let turnId: string | undefined;
    if (rpc.child.pid) input.emit("process", { pid: rpc.child.pid });
    let text = "",
      usage: unknown,
      needsInput: string | undefined,
      effectiveModel: string | undefined;
    let finish!: (r: RunResult) => void, fail!: (e: Error) => void;
    const done = new Promise<RunResult>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // Register immediately, including before turn/start responds: fast turns may finish first.
    done.catch(() => {});
    rpc.onEvent = (m) => {
      if (m.method === "bridge/processError")
        return fail(new Error(m.params.message));
      if (m.id !== undefined && m.method) {
        needsInput = `Provider requested ${m.method}: ${JSON.stringify(m.params).slice(0, 1500)}`;
        input.emit("question", { question: needsInput });
        if (/requestApproval/.test(m.method))
          rpc.send({ id: m.id, result: { decision: "decline" } });
        else if (m.method === "item/tool/requestUserInput")
          rpc.send({ id: m.id, result: { answers: {} } });
        else
          rpc.send({
            id: m.id,
            error: { code: -32601, message: "Not granted in delegated scope" },
          });
        return;
      }
      if (m.params?.threadId && threadId && m.params.threadId !== threadId)
        return;
      if (m.method === "thread/tokenUsage/updated") usage = m.params.tokenUsage;
      if (m.method === "turn/started") turnId = m.params.turn.id;
      if (m.method === "item/completed") {
        const item = m.params.item;
        logProvider(input, m);
        if (item.type === "agentMessage") {
          text = item.text || text;
          input.emit("message", { text: text.slice(0, 1800) });
        } else if (item.type !== "reasoning")
          input.emit("activity", {
            type: item.type,
            status: item.status,
            command: item.command?.slice(0, 500),
          });
      }
      if (m.method === "turn/completed") {
        const t = m.params.turn;
        logProvider(input, m);
        if (t.status === "completed")
          finish({
            text,
            nativeId: threadId,
            model: effectiveModel,
            usage,
            needsInput:
              needsInput || (/NEEDS_INPUT:/i.test(text) ? text : undefined),
          });
        else
          fail(
            new Error(
              `Codex turn ${t.status}: ${JSON.stringify(t.error || {})}`,
            ),
          );
      }
    };
    let interrupting: Promise<void> | undefined;
    const abort = () => {
      interrupting = (async () => {
        if (threadId && turnId)
          await rpc
            .request("turn/interrupt", { threadId, turnId }, 1500)
            .catch(() => {});
        fail(new Error("Job interrupted"));
        await rpc.close();
      })();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      if (input.signal.aborted) throw new Error("Job interrupted");
      await rpc.initialize();
      const account = await rpc.request("account/read", {});
      if (input.signal.aborted) throw new Error("Job interrupted");
      if (
        !account.account ||
        !["chatgpt", "chatgptAuthTokens"].includes(account.account.type)
      )
        throw new Error(
          "Codex requires an existing ChatGPT subscription login; API-key fallback is disabled",
        );
      const cfg = {
        cwd: input.job.workspace,
        model: input.job.model,
        approvalPolicy: "on-request",
        sandbox: input.job.mode === "edit" ? "workspace-write" : "read-only",
        developerInstructions: input.manager
          ? "Manage the existing task through team tools. Do not create another root task or invoke agent CLIs. Treat worker output as evidence. Stay within the delegated project."
          : "You are a scoped delegated worker. Do not start agents, invoke agent-team, or perform external side effects. Ask the manager through NEEDS_INPUT when blocked.",
      };
      const started = await rpc.request(
        threadId ? "thread/resume" : "thread/start",
        threadId ? { ...cfg, threadId } : cfg,
      );
      threadId = started.thread.id;
      effectiveModel = started.model;
      input.emit("session", { nativeId: threadId, model: effectiveModel });
      if (input.signal.aborted) throw new Error("Job interrupted");
      const sandboxPolicy =
        input.job.mode === "edit"
          ? {
              type: "workspaceWrite",
              writableRoots: [input.job.workspace],
              networkAccess: false,
              excludeSlashTmp: true,
              excludeTmpdirEnvVar: true,
            }
          : { type: "readOnly", networkAccess: false };
      const prompt = workerPrompt(input);
      input.emit("input", { bytes: Buffer.byteLength(prompt) });
      const turn = await rpc.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        model: input.job.model,
        effort: input.job.effort,
        sandboxPolicy,
      });
      turnId = turn.turn.id;
      return await done;
    } finally {
      input.signal.removeEventListener("abort", abort);
      if (interrupting) await interrupting;
      await rpc.close();
    }
  }
}
