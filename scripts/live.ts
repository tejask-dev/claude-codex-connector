import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { call } from "../src/client.js";
import { repoRoot } from "../src/config.js";
import type { Provider } from "../src/types.js";
const receipt: any = { startedAt: new Date().toISOString(), cases: [] };
const receiptPath = path.join(repoRoot, "docs/live-receipt.json");
async function wait(taskId: string, jobId: string, origin: Provider) {
  let cursor = 0;
  for (;;) {
    const r = await call(
      "read",
      { taskId, jobId, cursor, waitMs: 30000 },
      { provider: origin },
    );
    cursor = r.cursor;
    const job = r.jobs[0];
    if (!["queued", "running"].includes(job.state)) return job;
  }
}
async function run(provider: Provider) {
  const origin: Provider = provider === "claude" ? "codex" : "claude";
  const project = path.join(
    repoRoot,
    ".test-state",
    `live-${provider}-${Date.now()}`,
  );
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, "sum.mjs"),
    "export const sum = (a,b) => a-b;\n",
  );
  fs.writeFileSync(
    path.join(project, "sum.test.mjs"),
    "import test from 'node:test';import assert from 'node:assert/strict';import {sum} from './sum.mjs';test('sum',()=>assert.equal(sum(2,3),5));\n",
  );
  for (const args of [
    ["init", "-q"],
    ["add", "sum.mjs", "sum.test.mjs"],
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
  const { task, managerToken } = await call(
    "start",
    {
      requestId: randomUUID(),
      project,
      objective: "Fix addition and cover a negative input",
      acceptance:
        "node --test passes and original checkout is preserved until integration",
    },
    { provider: origin },
  );
  const actor = { provider: origin, managerToken };
  const { job } = await call(
    "delegate",
    {
      requestId: randomUUID(),
      taskId: task.id,
      mode: "edit",
      role: "implementation",
      prompt:
        "Fix sum.mjs to add rather than subtract. Add one test covering negative numbers. Run node --test in this workspace. Keep the response concise with actual test results.",
      timeoutMs: 180000,
    },
    actor,
  );
  const result = await wait(task.id, job.id, origin);
  if (result.state !== "completed")
    throw new Error(`${provider} failed: ${result.state}: ${result.error}`);
  if (!fs.readFileSync(path.join(project, "sum.mjs"), "utf8").includes("a-b"))
    throw new Error("Worker changed source before integration");
  await call(
    "control",
    {
      requestId: randomUUID(),
      taskId: task.id,
      jobId: job.id,
      action: "integrate",
    },
    actor,
  );
  const tests = execFileSync(process.execPath, ["--test"], {
    cwd: project,
    encoding: "utf8",
  });
  await call(
    "finish",
    {
      requestId: randomUUID(),
      taskId: task.id,
      summary: "Addition repaired with negative-input coverage",
      evidence: tests,
    },
    actor,
  );
  // Reverse provider reviews the integrated implementation in its own snapshot.
  const reviewTask = await call(
    "start",
    {
      requestId: randomUUID(),
      project,
      objective: "Independently review the addition fix",
      acceptance:
        "Review sum.mjs and its tests and report concrete defects or no findings",
    },
    { provider },
  );
  const review = await call(
    "delegate",
    {
      requestId: randomUUID(),
      taskId: reviewTask.task.id,
      managerToken: reviewTask.managerToken,
      mode: "read",
      role: "review",
      prompt:
        "Read sum.mjs and sum.test.mjs. Review correctness and coverage. Report defects or no findings, under 800 characters.",
      timeoutMs: 180000,
    },
    { provider },
  );
  const reviewed = await wait(reviewTask.task.id, review.job.id, provider);
  if (reviewed.state !== "completed")
    throw new Error(`Review failed: ${reviewed.error}`);
  await call(
    "finish",
    {
      requestId: randomUUID(),
      taskId: reviewTask.task.id,
      managerToken: reviewTask.managerToken,
      summary: "Independent review complete",
      evidence: reviewed.result,
    },
    { provider },
  );
  receipt.cases.push({
    provider,
    origin,
    project,
    taskId: task.id,
    jobId: job.id,
    state: result.state,
    nativeId: result.nativeId,
    effectiveModel: result.effectiveModel,
    usage: result.usage,
    tests,
    review: {
      provider: origin,
      result: reviewed.result,
      nativeId: reviewed.nativeId,
      usage: reviewed.usage,
    },
  });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(
    `${provider}: implementation, source preservation, integration, tests, and ${origin} review passed`,
  );
}
try {
  await run("claude");
  await run("codex");
  receipt.completedAt = new Date().toISOString();
} catch (e) {
  receipt.error = e instanceof Error ? e.message : String(e);
  console.error(receipt.error);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
}
