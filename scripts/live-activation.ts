import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  childEnvironment,
  repoRoot,
  config,
  findExecutable,
} from "../src/config.js";
import { invocationConfig } from "../src/providers/codex.js";
import { call } from "../src/client.js";
import { stopChild } from "../src/providers/common.js";
import type { Provider } from "../src/types.js";
const receiptPath = path.join(repoRoot, "docs/activation-receipt.json");
const receipt: any =
  process.argv.includes("--resume") && fs.existsSync(receiptPath)
    ? JSON.parse(fs.readFileSync(receiptPath, "utf8"))
    : { startedAt: new Date().toISOString(), cases: [] };
delete receipt.error;
async function run(
  provider: Provider,
  project: string,
  prompt: string,
  label: string,
) {
  const env = childEnvironment();
  delete env.AGENT_TEAM_WORKER;
  const root = path.join(repoRoot, ".test-state/activation-logs");
  fs.mkdirSync(root, { recursive: true });
  const output = fs.openSync(
      path.join(root, `${provider}-${label}.jsonl`),
      "w",
      0o600,
    ),
    error = fs.openSync(
      path.join(root, `${provider}-${label}.stderr`),
      "w",
      0o600,
    );
  let args: string[];
  if (provider === "codex")
    args = [
      "exec",
      "--json",
      "-C",
      project,
      "--sandbox",
      "workspace-write",
      ...invocationConfig(),
      "-c",
      "mcp_servers.agent-team.enabled=true",
      "-c",
      'model_reasoning_effort="low"',
      "-",
    ];
  else {
    const settingsFile = path.join(os.homedir(), ".claude/settings.json");
    const settings = fs.existsSync(settingsFile)
      ? JSON.parse(fs.readFileSync(settingsFile, "utf8"))
      : {};
    args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--effort",
      "low",
      "--permission-mode",
      "dontAsk",
      "--no-chrome",
      "--tools",
      "Read,Write,Edit,Bash,Glob,Grep",
      "--allowedTools",
      "Read,Write,Edit,Bash,mcp__agent-team__team_start,mcp__agent-team__team_delegate,mcp__agent-team__team_read,mcp__agent-team__team_status,mcp__agent-team__team_finish,mcp__agent-team__team_control,mcp__agent-team__team_catalog,mcp__agent-team__team_capability",
      "--settings",
      JSON.stringify({
        disableAllHooks: true,
        enabledPlugins: Object.fromEntries(
          Object.keys(settings.enabledPlugins || {}).map((k) => [k, false]),
        ),
      }),
    ];
  }
  const child = spawn(
    provider === "codex"
      ? config().codexBin
      : findExecutable("claude") || "claude",
    args,
    {
      cwd: project,
      env,
      stdio: ["pipe", output, error],
      detached: true,
    },
  );
  fs.closeSync(output);
  fs.closeSync(error);
  child.stdin!.end(prompt);
  const timer = setTimeout(() => {
    void stopChild(child);
  }, 300000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    assert.equal(
      code,
      0,
      `${provider} ${label} failed; inspect activation logs`,
    );
  } finally {
    clearTimeout(timer);
    await stopChild(child);
  }
  return { log: path.join(root, `${provider}-${label}.jsonl`) };
}
try {
  for (const provider of ["claude", "codex"] as Provider[]) {
    if (receipt.cases.some((c: any) => c.provider === provider)) continue;
    const project = path.join(
      repoRoot,
      ".test-state",
      `activation-${provider}-${Date.now()}`,
    );
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, "README.md"),
      "# Math fixture\nImplement the requested numeric utilities here.\n",
    );
    for (const args of [
      ["init", "-q"],
      ["add", "README.md"],
      [
        "-c",
        "user.name=Bridge Fixture",
        "-c",
        "user.email=fixture@localhost",
        "commit",
        "-qm",
        "baseline",
      ],
    ])
      execFileSync("git", ["-C", project, ...args]);
    const trivial = await run(
      provider,
      project,
      "What is 2 + 2? Answer with the number only.",
      "trivial",
    );
    const before = await call("status", {}, { provider });
    assert.ok(
      !before.tasks.some((t: any) => t.project === project),
      "Trivial prompt unexpectedly started teamwork",
    );
    console.log(`${provider}: trivial prompt bypassed teamwork`);
    const implementation = await run(
      provider,
      project,
      "Implement a small dependency-free numeric utility module numbers.mjs with exported sum(values), mean(values), and clamp(value,min,max). Reject empty arrays for mean and inverted bounds for clamp with clear errors. Add node:test coverage for positive, negative, empty, and boundary cases. Document the API in README.md and run node --test. Complete this local development task with verified results. Keep reports concise and use low effort for any focused peer work. Do not push or deploy.",
      "implementation",
    );
    const after = await call("status", {}, { provider });
    const tasks = after.tasks.filter((t: any) => t.project === project);
    assert.ok(tasks.length, "Substantial prompt did not enter teamwork");
    const statuses = await Promise.all(
      tasks.map((t: any) => call("status", { taskId: t.id }, { provider })),
    );
    assert.ok(
      statuses.some(
        (s) =>
          s.task.state === "completed" &&
          s.jobs.some((j: any) => j.state === "completed"),
      ),
      "No completed task with successful peer contribution",
    );
    const tests = execFileSync(
      process.execPath,
      ["--test", "--test-reporter=tap"],
      {
        cwd: project,
        encoding: "utf8",
      },
    );
    assert.match(tests, /# pass [1-9]/);
    receipt.cases.push({
      provider,
      project,
      trivial,
      implementation,
      taskIds: tasks.map((t: any) => t.id),
      tests,
    });
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    console.log(
      `${provider}: fresh installed CLI automatically used teamwork and fixture tests passed`,
    );
  }
  receipt.completedAt = new Date().toISOString();
} catch (e) {
  receipt.error = e instanceof Error ? e.message : String(e);
  console.error(receipt.error);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
}
