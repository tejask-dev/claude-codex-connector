#!/usr/bin/env node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { call, rpc, assertDistribution } from "./client.js";
import { config } from "./config.js";
import { schemas, type Operation } from "./api.js";
const args = process.argv.slice(2);
if (!args.length || args.includes("--help")) {
  console.log(`agent-team <start|delegate|send|read|control|status|models|finish|catalog|capability|sessions|session_read> [JSON] [--origin codex|claude]
Use '-' instead of JSON to read stdin. Mutations accept requestId for safe retries.
Save the managerToken returned by start; pass it for mutations (or AGENT_TEAM_MANAGER_TOKEN).
agent-team configure --root /absolute/root [--codex /absolute/codex]
agent-team auth claude [--stdin]  Save an explicit API key; billed API usage, no inference.
agent-team doctor      Check installed runtime versions (no inference).
agent-team stop        Gracefully stop coordinator and active workers.
agent-team mcp --origin codex|claude   Start the MCP stdio adapter.`);
  process.exit(0);
}
const op = args.shift()!;
if (op === "mcp") {
  await import("./mcp.js");
} else {
  try {
    const cfg = config();
    const i = args.indexOf("--origin");
    const provider = i >= 0 ? args.splice(i, 2)[1] : "codex";
    if (!["codex", "claude"].includes(provider))
      throw new Error("Invalid origin");
    if (op === "configure") {
      const { configure } = await import("./setup.js");
      console.log(JSON.stringify(configure(args), null, 2));
    } else if (op === "auth") {
      if (args[0] !== "claude" || args.some((a, i) => i > 0 && a !== "--stdin"))
        throw new Error(
          "Use auth claude [--stdin]; never pass a key as an argument",
        );
      const { enterClaudeKey } = await import("./auth.js");
      await enterClaudeKey(cfg, args.includes("--stdin"));
    } else if (op === "stop") {
      const s = await rpc(cfg, "ping", {}, { provider: provider as any });
      assertDistribution(s);
      process.kill(s.pid, "SIGTERM");
      console.log("Shutdown requested; active jobs will be interrupted.");
    } else if (op === "doctor") {
      const { execFileSync } = await import("node:child_process");
      console.log(
        JSON.stringify(
          {
            node: process.version,
            codex: execFileSync(cfg.codexBin, ["--version"], {
              encoding: "utf8",
            }).trim(),
            claudeSdk: JSON.parse(
              fs.readFileSync(
                new URL(
                  "../../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
                  import.meta.url,
                ),
                "utf8",
              ),
            ).version,
            stateDir: cfg.stateDir,
            roots: cfg.roots,
          },
          null,
          2,
        ),
      );
    } else {
      if (!(op in schemas)) throw new Error("Unknown operation; use --help");
      const input = JSON.parse(
        args[0] === "-" ? fs.readFileSync(0, "utf8") : args[0] || "{}",
      );
      if (["start", "delegate", "send", "control", "finish"].includes(op))
        input.requestId ||= randomUUID();
      const result = await call(op as Operation, input, {
        provider: provider as any,
        managerToken: process.env.AGENT_TEAM_MANAGER_TOKEN,
      });
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
