import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { install, uninstall, replaceBlock } from "../src/install.js";
import { capabilities } from "../src/catalog.js";
import { Coordinator } from "../src/coordinator.js";
import { RpcProcess } from "../src/providers/codex.js";
import { acquireDaemonLock } from "../src/daemon-lock.js";
import {
  createSnapshot,
  integrate,
  rollbackIntegration,
  changes,
} from "../src/workspace.js";
import { config, jsonWrite, repoRoot, type Config } from "../src/config.js";
import type { Adapter, RunInput } from "../src/types.js";
test("catalog discovers shared skills, provider agents, and linked resources without repeating symlink loops", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-catalog-"));
  try {
    const dir = path.join(home, ".agents/skills/example");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: Example\ndescription: Verify a fixture\n---\nRead scripts/check.js",
    );
    const agent = path.join(home, ".claude/agents");
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(
      path.join(agent, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code\n---\nReview the task.",
    );
    const codexAgents = path.join(home, ".codex/agents");
    fs.mkdirSync(codexAgents, { recursive: true });
    fs.writeFileSync(
      path.join(codexAgents, "tester.toml"),
      'name = "test-specialist"\ndescription = "Checks edge cases"\ndeveloper_instructions = "Review the tests"\n',
    );
    fs.symlinkSync(path.join(home, ".agents/skills"), path.join(dir, "loop"));
    const all = capabilities(undefined, home);
    assert.equal(all.length, 3);
    assert.equal(all.find((c) => c.kind === "skill")?.provider, "shared");
    assert.ok(all.some((c) => c.kind === "agent" && c.name === "reviewer"));
    assert.equal(
      all.find((c) => c.provider === "codex")?.description,
      "Checks edge cases",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("installer is repeatable, preserves unrelated config and instructions, and uninstalls its own changes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-install-"));
  const previous = process.env.AGENT_TEAM_STATE_DIR;
  process.env.AGENT_TEAM_STATE_DIR = path.join(home, "state");
  try {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(home, "Developer"));
    const codex =
      '# preserve comment\nmodel = "keep-me"\n[mcp_servers.other]\ncommand = "other"\n';
    fs.writeFileSync(path.join(home, ".codex/config.toml"), codex);
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { other: { command: "other" } },
        unrelated: "keep",
      }),
    );
    fs.writeFileSync(
      path.join(home, "Developer/AGENTS.md"),
      "Existing protocol\n",
    );
    fs.writeFileSync(
      path.join(home, "Developer/CLAUDE.md"),
      "Existing Claude protocol\n",
    );
    install(home, repoRoot, true);
    const first = fs.readFileSync(
      path.join(home, ".codex/config.toml"),
      "utf8",
    );
    install(home, repoRoot, true);
    assert.equal(
      fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8"),
      first,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"))
        .unrelated,
      "keep",
    );
    uninstall(home);
    assert.equal(
      fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8"),
      codex,
    );
    assert.equal(
      fs.readFileSync(path.join(home, "Developer/AGENTS.md"), "utf8"),
      "Existing protocol\n",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"))
        .mcpServers.other.command,
      "other",
    );
    assert.throws(
      () => replaceBlock("<!-- agent-team-bridge:start -->", ""),
      /Malformed/,
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_STATE_DIR;
    else process.env.AGENT_TEAM_STATE_DIR = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("MCP stdio handshake exposes both provider controls and catalog without an inference call", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "team-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist/src/mcp.js"), "--origin", "claude"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (x): x is [string, string] => x[1] !== undefined,
        ),
      ),
      AGENT_TEAM_STATE_DIR: state,
    },
  });
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of [
      "team_delegate",
      "team_control",
      "team_catalog",
      "team_sessions",
    ])
      assert.ok(tools.tools.some((t) => t.name === name));
    assert.equal(fs.existsSync(path.join(state, "state.sqlite")), false);
  } finally {
    await client.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
});
test("malformed provider output fails pending RPC rather than hanging", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-rpc-"));
  const script = path.join(root, "fake.mjs");
  fs.writeFileSync(
    script,
    "process.stdin.once('data',()=>{process.stdout.write('not-json\\n')});",
  );
  const rpc = new RpcProcess(process.execPath, [script], root);
  try {
    await assert.rejects(rpc.initialize(), /JSON|Unexpected token/);
  } finally {
    await rpc.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("manager transfer changes ownership and starts a manager session; stale token cannot delegate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-handoff-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "file.txt"), "hello");
  const cfg: Config = {
    ...config(),
    stateDir: path.join(root, "state"),
    socket: path.join(root, "socket"),
    roots: [root],
  };
  let managed: RunInput | undefined;
  const fake: Adapter = {
    models: async () => [
      { id: "opus", name: "Opus", efforts: ["xhigh"] },
      { id: "opus[1m]", name: "Opus", efforts: ["xhigh"] },
    ],
    run: async (input) => {
      managed = input;
      return { text: "Handoff received", model: "opus" };
    },
  };
  const c = new Coordinator(cfg, { claude: fake, codex: fake });
  try {
    const { task, managerToken } = await c.execute(
      "start",
      {
        requestId: randomUUID(),
        project,
        objective: "Transfer fixture",
        acceptance: "Review it",
      },
      { provider: "codex" },
    );
    const result = await c.execute(
      "control",
      {
        requestId: randomUUID(),
        taskId: task.id,
        action: "handoff",
        provider: "claude",
        handoff: "Inspect file.txt",
      },
      { provider: "codex", managerToken },
    );
    await Promise.all(c.running.values());
    assert.equal(result.task.manager, "claude");
    assert.ok(managed?.manager?.token);
    assert.equal(managed?.job.kind, "manager");
    await assert.rejects(
      c.execute(
        "delegate",
        { requestId: randomUUID(), taskId: task.id, prompt: "stale" },
        { provider: "codex", managerToken },
      ),
      /Current manager token/,
    );
  } finally {
    await c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("watchdog produces interrupted state and frees the worker slot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-watchdog-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "x"), "x");
  const cfg: Config = {
    ...config(),
    stateDir: path.join(root, "state"),
    socket: path.join(root, "socket"),
    roots: [root],
    timeoutMs: 30,
  };
  const fake: Adapter = {
    models: async () => [{ id: "fake", name: "Fake", efforts: ["low"] }],
    run: async (input) => {
      await new Promise((_, reject) =>
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("timeout")),
          { once: true },
        ),
      );
      return { text: "" };
    },
  };
  const c = new Coordinator(cfg, { claude: fake, codex: fake });
  try {
    const { task, managerToken } = await c.execute(
      "start",
      {
        requestId: randomUUID(),
        project,
        objective: "Timeout",
        acceptance: "Stop",
      },
      { provider: "codex" },
    );
    const { job } = await c.execute(
      "delegate",
      {
        requestId: randomUUID(),
        taskId: task.id,
        prompt: "wait",
        model: "fake",
        effort: "low",
      },
      { provider: "codex", managerToken },
    );
    await Promise.all(c.running.values());
    assert.equal(c.store.job(job.id).state, "interrupted");
    assert.equal(c.active.size, 0);
  } finally {
    await c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("exclusive daemon lease cannot be stolen and becomes available when its holder closes", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "team-lock-"));
  try {
    const first = acquireDaemonLock(state);
    assert.ok(first);
    assert.equal(acquireDaemonLock(state), undefined);
    first.close();
    const second = acquireDaemonLock(state);
    assert.ok(second);
    second.close();
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});
test("integration reconciles a lost receipt and guarded rollback rejects subsequent edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-journal-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "a"), "old");
  fs.writeFileSync(path.join(project, "b"), "old");
  try {
    const s = createSnapshot(project, path.join(root, "job"));
    for (const n of ["a", "b"])
      fs.writeFileSync(path.join(s.workspace, n), "new");
    const first = integrate(s.baselinePath);
    assert.deepEqual(integrate(s.baselinePath), first);
    fs.writeFileSync(path.join(project, "b"), "user-edit");
    assert.throws(
      () => rollbackIntegration(s.baselinePath),
      /rollback refused/,
    );
    assert.equal(fs.readFileSync(path.join(project, "a"), "utf8"), "new");
    fs.writeFileSync(path.join(project, "b"), "new");
    rollbackIntegration(s.baselinePath);
    assert.equal(fs.readFileSync(path.join(project, "a"), "utf8"), "old");
    assert.deepEqual(integrate(s.baselinePath), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("partial integration remains explicit and can be rolled back without replaying worker edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-partial-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  for (const n of ["a", "b"]) fs.writeFileSync(path.join(project, n), "old");
  try {
    const s = createSnapshot(project, path.join(root, "job"));
    for (const n of ["a", "b"])
      fs.writeFileSync(path.join(s.workspace, n), "new");
    integrate(s.baselinePath);
    const file = path.join(root, "job/integration-backup/journal.json");
    const journal = JSON.parse(fs.readFileSync(file, "utf8"));
    jsonWrite(file, { ...journal, status: "applying" });
    fs.writeFileSync(path.join(project, "b"), "old");
    assert.throws(() => integrate(s.baselinePath), /Uncertain integration/);
    rollbackIntegration(s.baselinePath);
    assert.equal(fs.readFileSync(path.join(project, "a"), "utf8"), "old");
    assert.equal(fs.readFileSync(path.join(project, "b"), "utf8"), "old");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("handoff receipt and lease rotate in one transaction; failed receipt does not orphan ownership", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-lease-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "x"), "x");
  const cfg: Config = {
    ...config(),
    stateDir: path.join(root, "state"),
    socket: path.join(root, "socket"),
    roots: [root],
  };
  const fake: Adapter = {
    models: async () => [{ id: "fake", name: "Fake", efforts: ["low"] }],
    run: async () => ({ text: "done", nativeId: "native" }),
  };
  const c = new Coordinator(cfg, { claude: fake, codex: fake });
  try {
    const s = await c.execute(
      "start",
      {
        requestId: randomUUID(),
        project,
        objective: "Crash handoff",
        acceptance: "Retry returns same lease",
      },
      { provider: "codex" },
    );
    const actor = { provider: "codex" as const, managerToken: s.managerToken };
    const input = {
      requestId: randomUUID(),
      taskId: s.task.id,
      action: "handoff",
      model: "fake",
      effort: "low",
    };
    const remember = c.store.remember.bind(c.store);
    c.store.remember = () => {
      throw new Error("injected crash");
    };
    await assert.rejects(c.execute("control", input, actor), /injected crash/);
    assert.equal(c.store.task(s.task.id).generation, 1);
    assert.equal(c.store.jobs(s.task.id).length, 0);
    c.store.remember = remember;
    const first = await c.execute("control", input, actor);
    const retry = await c.execute("control", input, actor);
    assert.equal(first.managerToken, retry.managerToken);
    assert.equal(first.managerJob.id, retry.managerJob.id);
  } finally {
    await c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("managed session does not consume worker capacity when concurrency is one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-capacity-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "x"), "x");
  const cfg: Config = {
    ...config(),
    stateDir: path.join(root, "state"),
    socket: path.join(root, "socket"),
    roots: [root],
    concurrency: 1,
  };
  let c: Coordinator;
  const fake: Adapter = {
    models: async () => [{ id: "fake", name: "Fake", efforts: ["low"] }],
    run: async (input) => {
      if (input.manager) {
        const { job } = await c.execute(
          "delegate",
          {
            requestId: randomUUID(),
            taskId: input.task.id,
            prompt: "Review",
            model: "fake",
            effort: "low",
          },
          { provider: "claude", managerToken: input.manager.token },
        );
        await c.running.get(job.id);
        assert.equal(c.store.job(job.id).state, "completed");
      }
      return { text: "done", nativeId: randomUUID() };
    },
  };
  c = new Coordinator(cfg, { claude: fake, codex: fake });
  try {
    const s = await c.execute(
      "start",
      {
        requestId: randomUUID(),
        project,
        objective: "Capacity",
        acceptance: "Worker can run under manager",
      },
      { provider: "codex" },
    );
    await c.execute(
      "control",
      {
        requestId: randomUUID(),
        taskId: s.task.id,
        action: "handoff",
        model: "fake",
        effort: "low",
      },
      { provider: "codex", managerToken: s.managerToken },
    );
    await Promise.all(c.running.values());
    assert.equal(c.store.jobs(s.task.id).length, 2);
    assert.ok(c.store.jobs(s.task.id).every((j) => j.state === "completed"));
  } finally {
    await c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("integration can recover when file application succeeds but its database receipt fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-receipt-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "x"), "old");
  const cfg: Config = {
    ...config(),
    stateDir: path.join(root, "state"),
    socket: path.join(root, "socket"),
    roots: [root],
  };
  const fake: Adapter = {
    models: async () => [{ id: "fake", name: "Fake", efforts: ["low"] }],
    run: async (input) => {
      fs.writeFileSync(path.join(input.job.workspace, "x"), "new");
      return { text: "done", nativeId: randomUUID() };
    },
  };
  const c = new Coordinator(cfg, { claude: fake, codex: fake });
  try {
    const s = await c.execute(
      "start",
      {
        requestId: randomUUID(),
        project,
        objective: "Recover receipt",
        acceptance: "No edit replay",
      },
      { provider: "codex" },
    );
    const actor = { provider: "codex" as const, managerToken: s.managerToken };
    const { job } = await c.execute(
      "delegate",
      {
        requestId: randomUUID(),
        taskId: s.task.id,
        prompt: "Edit x",
        mode: "edit",
        model: "fake",
        effort: "low",
      },
      actor,
    );
    await Promise.all(c.running.values());
    const input = {
      requestId: randomUUID(),
      taskId: s.task.id,
      jobId: job.id,
      action: "integrate",
    };
    const save = c.store.saveJob.bind(c.store);
    c.store.saveJob = (j) => {
      if (j.integrated) throw new Error("injected receipt failure");
      save(j);
    };
    await assert.rejects(
      c.execute("control", input, actor),
      /injected receipt failure/,
    );
    assert.equal(c.store.job(job.id).integrated, undefined);
    assert.equal(fs.readFileSync(path.join(project, "x"), "utf8"), "new");
    c.store.saveJob = save;
    const first = await c.execute("control", input, actor);
    assert.ok(c.store.job(job.id).integrated);
    assert.deepEqual(await c.execute("control", input, actor), first);
  } finally {
    await c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("authentication expiry and rate-limit failures stay failed and preserve provider error evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-failures-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "x"), "x");
  const cfg: Config = {
    ...config(),
    stateDir: path.join(root, "state"),
    socket: path.join(root, "socket"),
    roots: [root],
  };
  let failure = "Authentication expired: login required";
  let invocations = 0;
  const fake: Adapter = {
    models: async () => [{ id: "fake", name: "Fake", efforts: ["low"] }],
    run: async () => {
      invocations++;
      throw new Error(failure);
    },
  };
  const c = new Coordinator(cfg, { claude: fake, codex: fake });
  try {
    const s = await c.execute(
      "start",
      {
        requestId: randomUUID(),
        project,
        objective: "Failure handling",
        acceptance: "Preserve failures without retries",
      },
      { provider: "codex" },
    );
    const actor = { provider: "codex" as const, managerToken: s.managerToken };
    for (const error of [
      "Authentication expired: login required",
      "429 rate limit exceeded",
    ]) {
      failure = error;
      const { job } = await c.execute(
        "delegate",
        {
          requestId: randomUUID(),
          taskId: s.task.id,
          prompt: "Review",
          model: "fake",
          effort: "low",
        },
        actor,
      );
      await Promise.all(c.running.values());
      assert.equal(c.store.job(job.id).state, "failed");
      assert.equal(c.store.job(job.id).error, error);
      await assert.rejects(
        c.execute(
          "send",
          {
            requestId: randomUUID(),
            taskId: s.task.id,
            jobId: job.id,
            message: "continue",
          },
          actor,
        ),
        /No provider session/,
      );
    }
    assert.equal(invocations, 2);
  } finally {
    await c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
