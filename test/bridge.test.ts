import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Coordinator } from "../src/coordinator.js";
import { createSnapshot, integrate, changes } from "../src/workspace.js";
import { childEnvironment, type Config } from "../src/config.js";
import { toolDecision } from "../src/providers/claude.js";
import type { Adapter, RunInput, RunResult } from "../src/types.js";
class Fake implements Adapter {
  calls: RunInput[] = [];
  models = async () => [
    { id: "fake", name: "Fake", efforts: ["low", "xhigh"] },
  ];
  async run(input: RunInput): Promise<RunResult> {
    this.calls.push(input);
    input.emit("session", {
      nativeId: input.job.nativeId || randomUUID(),
      model: "fake",
    });
    if (input.prompt === "fail") throw new Error("Rate limit reached");
    if (input.prompt === "wait")
      await new Promise<void>((resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    if (input.job.mode === "edit")
      fs.writeFileSync(path.join(input.job.workspace, "answer.txt"), "42\n");
    return {
      text:
        input.prompt === "question"
          ? "NEEDS_INPUT: Which behavior?"
          : "Reviewed. Tests: node --test passed.",
      nativeId: input.job.nativeId,
      model: "fake",
      usage: { input: 40, output: 12 },
      needsInput: input.prompt === "question" ? "Which behavior?" : undefined,
    };
  }
}
function setup(git = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-test-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "answer.txt"), "before\n");
  if (git) {
    for (const args of [
      ["init", "-q"],
      ["add", "answer.txt"],
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@localhost",
        "commit",
        "-qm",
        "fixture",
      ],
    ])
      execFileSync("git", ["-C", project, ...args]);
  }
  const cfg: Config = {
    stateDir: path.join(root, "state"),
    socket: path.join(root, "state/control.sock"),
    roots: [root],
    concurrency: 2,
    maxTurns: 3,
    timeoutMs: 10000,
    codexBin: "unused",
  };
  const fake = new Fake();
  const c = new Coordinator(cfg, { codex: fake, claude: fake });
  const cleanup = async () => {
    await c.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, project, cfg, fake, c, cleanup };
}
const req = () => randomUUID();
async function start(s: ReturnType<typeof setup>) {
  return s.c.execute(
    "start",
    {
      requestId: req(),
      project: s.project,
      objective: "Fix the fixture",
      acceptance: "Tests pass",
    },
    { provider: "codex" },
  );
}
async function idle(c: Coordinator) {
  while (c.running.size) await Promise.allSettled([...c.running.values()]);
}
test("dirty Git snapshot preserves index, deleted files, untracked files, binary and executable modes", async () => {
  const s = setup(true);
  try {
    fs.writeFileSync(path.join(s.project, "answer.txt"), "staged\n");
    execFileSync("git", ["-C", s.project, "add", "answer.txt"]);
    fs.writeFileSync(path.join(s.project, "answer.txt"), "unstaged\n");
    fs.writeFileSync(
      path.join(s.project, "new.bin"),
      Buffer.from([0, 1, 2, 255]),
    );
    fs.chmodSync(path.join(s.project, "new.bin"), 0o755);
    const before = execFileSync("git", [
      "-C",
      s.project,
      "diff",
      "--cached",
      "--binary",
    ]);
    const snap = createSnapshot(s.project, path.join(s.root, "snap"));
    assert.equal(
      fs.readFileSync(path.join(snap.workspace, "answer.txt"), "utf8"),
      "unstaged\n",
    );
    assert.deepEqual(
      fs.readFileSync(path.join(snap.workspace, "new.bin")),
      Buffer.from([0, 1, 2, 255]),
    );
    assert.equal(
      fs.statSync(path.join(snap.workspace, "new.bin")).mode & 0o777,
      0o755,
    );
    assert.deepEqual(
      execFileSync("git", ["-C", s.project, "diff", "--cached", "--binary"]),
      before,
    );
    fs.writeFileSync(path.join(snap.workspace, "answer.txt"), "worker\n");
    integrate(snap.baselinePath);
    assert.equal(
      fs.readFileSync(path.join(s.project, "answer.txt"), "utf8"),
      "worker\n",
    );
    assert.deepEqual(
      execFileSync("git", ["-C", s.project, "diff", "--cached", "--binary"]),
      before,
    );
  } finally {
    await s.cleanup();
  }
});
test("integration rejects stale source atomically and catches symlink escapes", async () => {
  const s = setup();
  try {
    const snap = createSnapshot(s.project, path.join(s.root, "snap"));
    fs.writeFileSync(path.join(snap.workspace, "answer.txt"), "worker");
    fs.writeFileSync(path.join(snap.workspace, "new.txt"), "new");
    fs.writeFileSync(path.join(s.project, "answer.txt"), "user change");
    assert.throws(() => integrate(snap.baselinePath), /Source changed/);
    assert.equal(fs.existsSync(path.join(s.project, "new.txt")), false);
    fs.symlinkSync(s.root, path.join(snap.workspace, "escape"));
    assert.throws(() => changes(snap.baselinePath), /External symlink/);
  } finally {
    await s.cleanup();
  }
});
test("idempotent parallel requests run one worker; session resumes without transcript replay", async () => {
  const s = setup();
  try {
    const { task, managerToken } = await start(s);
    const actor = { provider: "codex" as const, managerToken };
    const input = {
      requestId: req(),
      taskId: task.id,
      model: "fake",
      effort: "low",
      prompt: "Inspect answer.txt",
    };
    const [a, b] = await Promise.all([
      s.c.execute("delegate", input, actor),
      s.c.execute("delegate", input, actor),
    ]);
    assert.equal(a.job.id, b.job.id);
    await idle(s.c);
    assert.equal(s.fake.calls.length, 1);
    await s.c.execute(
      "send",
      {
        requestId: req(),
        taskId: task.id,
        jobId: a.job.id,
        message: "Now check the edge case",
      },
      actor,
    );
    await idle(s.c);
    assert.equal(s.fake.calls[1].prompt, "Now check the edge case");
    assert.ok(s.fake.calls[1].job.nativeId);
    await assert.rejects(
      s.c.execute("delegate", { ...input, prompt: "different" }, actor),
      /Request ID/,
    );
    await s.c.execute(
      "finish",
      {
        requestId: req(),
        taskId: task.id,
        summary: "Done",
        evidence: "node --test passed",
      },
      actor,
    );
  } finally {
    await s.cleanup();
  }
});
test("completion requires peer work and integrated edits; correction cycles are bounded", async () => {
  const s = setup();
  try {
    const { task, managerToken } = await start(s);
    const actor = { provider: "codex" as const, managerToken };
    const finish = () =>
      s.c.execute(
        "finish",
        {
          requestId: req(),
          taskId: task.id,
          summary: "Done",
          evidence: "tests pass",
        },
        actor,
      );
    await assert.rejects(finish(), /peer contribution/);
    const { job } = await s.c.execute(
      "delegate",
      {
        requestId: req(),
        taskId: task.id,
        prompt: "fix",
        mode: "edit",
        model: "fake",
        effort: "low",
      },
      actor,
    );
    await idle(s.c);
    await assert.rejects(finish(), /unintegrated/);
    for (let i = 0; i < 2; i++) {
      await s.c.execute(
        "send",
        { requestId: req(), taskId: task.id, jobId: job.id, message: "verify" },
        actor,
      );
      await idle(s.c);
    }
    await assert.rejects(
      s.c.execute(
        "send",
        { requestId: req(), taskId: task.id, jobId: job.id, message: "again" },
        actor,
      ),
      /correction cycles/,
    );
    await s.c.execute(
      "control",
      { requestId: req(), taskId: task.id, jobId: job.id, action: "integrate" },
      actor,
    );
    await finish();
    assert.equal(
      fs.readFileSync(path.join(s.project, "answer.txt"), "utf8"),
      "42\n",
    );
  } finally {
    await s.cleanup();
  }
});
test("two running workers maximum; cancel interrupts and releases queue capacity", async () => {
  const s = setup();
  try {
    const { task, managerToken } = await start(s);
    const actor = { provider: "codex" as const, managerToken };
    const jobs = [];
    for (let i = 0; i < 3; i++)
      jobs.push(
        (
          await s.c.execute(
            "delegate",
            {
              requestId: req(),
              taskId: task.id,
              prompt: "wait",
              model: "fake",
              effort: "low",
            },
            actor,
          )
        ).job,
      );
    assert.equal(s.c.active.size, 2);
    assert.equal(s.c.store.job(jobs[2].id).state, "queued");
    await s.c.execute(
      "control",
      {
        requestId: req(),
        taskId: task.id,
        jobId: jobs[0].id,
        action: "cancel",
      },
      actor,
    );
    await s.c.running.get(jobs[0].id);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.c.store.job(jobs[2].id).state, "running");
    await s.c.execute(
      "control",
      { requestId: req(), taskId: task.id, action: "cancel" },
      actor,
    );
    await idle(s.c);
    assert.equal(s.c.active.size, 0);
  } finally {
    await s.cleanup();
  }
});
test("failed and blocked providers remain distinct; workers cannot delegate and models are validated", async () => {
  const s = setup();
  try {
    const { task, managerToken } = await start(s);
    const actor = { provider: "codex" as const, managerToken };
    await assert.rejects(
      s.c.execute(
        "delegate",
        {
          requestId: req(),
          taskId: task.id,
          prompt: "x",
          model: "nonexistent",
        },
        actor,
      ),
      /Unsupported/,
    );
    await assert.rejects(
      s.c.execute(
        "start",
        {
          requestId: req(),
          project: s.project,
          objective: "nested",
          acceptance: "none",
        },
        { provider: "claude", workerToken: "fake" },
      ),
      /Workers/,
    );
    for (const [prompt, state] of [
      ["fail", "failed"],
      ["question", "needs_input"],
    ]) {
      const { job } = await s.c.execute(
        "delegate",
        {
          requestId: req(),
          taskId: task.id,
          prompt,
          model: "fake",
          effort: "low",
        },
        actor,
      );
      await idle(s.c);
      assert.equal(s.c.store.job(job.id).state, state);
    }
  } finally {
    await s.cleanup();
  }
});
test("restart marks pending jobs interrupted and does not replay inference", async () => {
  const s = setup();
  try {
    const { task, managerToken } = await start(s);
    const actor = { provider: "codex" as const, managerToken };
    const { job } = await s.c.execute(
      "delegate",
      {
        requestId: req(),
        taskId: task.id,
        prompt: "review",
        model: "fake",
        effort: "low",
      },
      actor,
    );
    await idle(s.c);
    const saved = s.c.store.job(job.id);
    saved.state = "running";
    s.c.store.saveJob(saved);
    await s.c.close();
    const next = new Coordinator(s.cfg, { claude: s.fake, codex: s.fake });
    assert.equal(next.store.job(job.id).state, "interrupted");
    assert.equal(s.fake.calls.length, 1);
    await next.close();
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
test("tool permissions enforce scope independently of prompts and omit ambient API keys", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-permissions-"));
  const skill = fs.mkdtempSync(path.join(os.tmpdir(), "team-skill-"));
  try {
    assert.match(
      toolDecision(root, "read", "Write", { file_path: path.join(root, "x") })!,
      /not in/,
    );
    assert.match(
      toolDecision(root, "edit", "Edit", { file_path: "/etc/passwd" })!,
      /outside/,
    );
    assert.equal(
      toolDecision(root, "edit", "Write", { file_path: path.join(root, "x") }),
      undefined,
    );
    fs.writeFileSync(path.join(skill, "resource.txt"), "resource");
    assert.equal(
      toolDecision(
        root,
        "read",
        "Read",
        { file_path: path.join(skill, "resource.txt") },
        [skill],
      ),
      undefined,
    );
    assert.match(
      toolDecision(
        root,
        "edit",
        "Write",
        { file_path: path.join(skill, "resource.txt") },
        [skill],
      )!,
      /outside/,
    );
    process.env.ANTHROPIC_API_KEY = "test-only";
    process.env.OPENAI_API_KEY = "test-only";
    process.env.ANTHROPIC_BASE_URL = "https://example.invalid";
    assert.equal(childEnvironment().ANTHROPIC_API_KEY, undefined);
    assert.equal(childEnvironment().OPENAI_API_KEY, undefined);
    assert.equal(childEnvironment().ANTHROPIC_BASE_URL, undefined);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(skill, { recursive: true, force: true });
  }
});
