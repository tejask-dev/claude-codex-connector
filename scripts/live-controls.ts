import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call, rpc } from "../src/client.js";
import { config, repoRoot } from "../src/config.js";
import type { Provider, Actor } from "../src/types.js";
const cfg = config(),
  file = path.join(repoRoot, "docs/controls-receipt.json");
const receipt: any = { startedAt: new Date().toISOString(), cases: [] };
const project = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/live-receipt.json"), "utf8"),
).cases[0].project;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wait(taskId: string, jobId: string, actor: Actor) {
  let cursor = 0;
  for (;;) {
    const r = await call(
      "read",
      { taskId, jobId, cursor, waitMs: 30000 },
      actor,
    );
    cursor = r.cursor;
    const j = r.jobs[0];
    if (!["running", "queued"].includes(j.state)) return j;
  }
}
function save() {
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
}
try {
  const sessions = [];
  for (const provider of ["claude", "codex"] as Provider[]) {
    const actor: Actor = {
      provider: provider === "claude" ? "codex" : "claude",
    };
    const s = await call(
      "start",
      {
        requestId: randomUUID(),
        project,
        objective: "Verify native session continuity",
        acceptance:
          "Remember a nonce after coordinator restart and model change",
      },
      actor,
    );
    actor.managerToken = s.managerToken;
    const nonce = `TEAM_${provider}_${randomUUID()}`;
    const { job } = await call(
      "delegate",
      {
        requestId: randomUUID(),
        taskId: s.task.id,
        prompt: `Remember ${nonce}. Reply only READY. Do not use tools.`,
        effort: "low",
      },
      actor,
    );
    const initial = await wait(s.task.id, job.id, actor);
    assert.equal(initial.state, "completed", initial.error);
    sessions.push({
      provider,
      actor,
      taskId: s.task.id,
      jobId: job.id,
      nonce,
      initial,
    });
  }
  const { pid } = await rpc(cfg, "ping", {}, { provider: "codex" });
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
      await delay(100);
    } catch {
      break;
    }
  }
  for (const s of sessions) {
    const available = await call("models", { provider: s.provider }, s.actor);
    const choice = available.models.find(
      (m: any) =>
        m.id !== s.initial.effectiveModel &&
        (!m.efforts?.length || m.efforts.includes("low")),
    );
    if (!choice)
      throw new Error(
        "No alternative model supporting this continuity test is available",
      );
    const model = choice.id;
    await call(
      "control",
      {
        requestId: randomUUID(),
        taskId: s.taskId,
        jobId: s.jobId,
        action: "set_model",
        model,
        effort: "low",
      },
      s.actor,
    );
    const message =
      "Return only the exact TEAM_ nonce from my earlier message. Do not use tools.";
    await call(
      "send",
      { requestId: randomUUID(), taskId: s.taskId, jobId: s.jobId, message },
      s.actor,
    );
    const final = await wait(s.taskId, s.jobId, s.actor);
    assert.equal(final.state, "completed", final.error);
    assert.equal(final.nativeId, s.initial.nativeId);
    assert.ok(final.result.includes(s.nonce));
    assert.equal(
      final.transportInputBytes - s.initial.transportInputBytes,
      Buffer.byteLength(message),
    );
    await call(
      "finish",
      {
        requestId: randomUUID(),
        taskId: s.taskId,
        summary: "Native continuity and model change verified",
        evidence: `Same session ${final.nativeId}; nonce matched; only ${Buffer.byteLength(message)} new prompt bytes supplied`,
      },
      s.actor,
    );
    receipt.cases.push({
      type: "continuity",
      provider: s.provider,
      nativeId: final.nativeId,
      beforeModel: s.initial.effectiveModel,
      afterModel: final.effectiveModel,
      followupBytes: Buffer.byteLength(message),
      initialUsage: s.initial.usage,
      finalUsage: final.usage,
    });
    save();
    console.log(
      `${s.provider}: native session survived restart, model changed, no transcript replay`,
    );
  }
  for (const provider of ["claude", "codex"] as Provider[]) {
    const actor: Actor = {
      provider: provider === "claude" ? "codex" : "claude",
    };
    const s = await call(
      "start",
      {
        requestId: randomUUID(),
        project,
        objective: "Review the addition fixture with the other provider",
        acceptance:
          "Obtain one concise peer review of sum.mjs and sum.test.mjs, then finish with the review evidence. No edits needed.",
      },
      actor,
    );
    actor.managerToken = s.managerToken;
    const handoff = await call(
      "control",
      {
        requestId: randomUUID(),
        taskId: s.task.id,
        action: "handoff",
        provider,
        effort: "low",
        handoff:
          "You are testing actual management transfer. Call team_status, delegate one read-only review to the OTHER provider (effort low; prompt: Review sum.mjs and sum.test.mjs, under 500 characters), wait for its result using team_read, then call team_finish. Do not reread source yourself. Use fresh UUID request IDs. The manager token and task ID are injected.",
      },
      actor,
    );
    const manager = await wait(s.task.id, handoff.managerJob.id, actor);
    const status = await call("status", { taskId: s.task.id }, actor);
    assert.equal(manager.state, "completed", manager.error);
    assert.equal(status.task.state, "completed", manager.result);
    assert.ok(
      status.jobs.some(
        (j: any) => j.kind === "worker" && j.state === "completed",
      ),
    );
    receipt.cases.push({
      type: "handoff",
      manager: provider,
      taskId: s.task.id,
      managerNativeId: manager.nativeId,
      jobs: status.jobs.map((j: any) => ({
        provider: j.provider,
        kind: j.kind,
        state: j.state,
        nativeId: j.nativeId,
        usage: j.usage,
      })),
    });
    save();
    console.log(
      `${provider}: actual manager used tools, delegated, read peer result, and finished`,
    );
  }
  for (const provider of ["claude", "codex"] as Provider[]) {
    const actor: Actor = {
      provider: provider === "claude" ? "codex" : "claude",
    };
    const s = await call(
      "start",
      {
        requestId: randomUUID(),
        project,
        objective: "Cancel a live worker",
        acceptance: "Cancellation interrupts and kills the provider process",
      },
      actor,
    );
    actor.managerToken = s.managerToken;
    const { job } = await call(
      "delegate",
      {
        requestId: randomUUID(),
        taskId: s.task.id,
        mode: "edit",
        effort: "low",
        prompt:
          "Run a local shell command that waits 60 seconds, then report done. Do not edit files.",
      },
      actor,
    );
    let live: any;
    for (let i = 0; i < 100; i++) {
      live = (await call("status", { taskId: s.task.id }, actor)).jobs[0];
      if (live.nativeId) break;
      await delay(100);
    }
    await call(
      "control",
      {
        requestId: randomUUID(),
        taskId: s.task.id,
        jobId: job.id,
        action: "cancel",
      },
      actor,
    );
    await delay(2000);
    const final = (await call("status", { taskId: s.task.id }, actor)).jobs[0];
    assert.equal(final.state, "cancelled");
    const processes = JSON.parse(
      fs.readFileSync(path.join(final.artifacts, "processes.json"), "utf8"),
    );
    for (const p of processes) {
      assert.throws(() => process.kill(p.pid, 0));
    }
    await call(
      "finish",
      {
        requestId: randomUUID(),
        taskId: s.task.id,
        outcome: "closed",
        summary: "Cancellation verified",
        evidence: "Provider process exited; job remained cancelled",
        remaining: "Intentional cancellation test",
      },
      actor,
    );
    receipt.cases.push({
      type: "cancel",
      provider,
      state: final.state,
      processesExited: true,
    });
    save();
    console.log(`${provider}: cancellation and process cleanup passed`);
  }
  receipt.completedAt = new Date().toISOString();
} catch (e) {
  receipt.error = e instanceof Error ? e.message : String(e);
  console.error(receipt.error);
  process.exitCode = 1;
} finally {
  save();
}
