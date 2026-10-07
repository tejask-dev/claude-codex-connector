import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call } from "../src/client.js";
import { repoRoot } from "../src/config.js";
import type { Provider } from "../src/types.js";
const file = path.join(repoRoot, "docs/capabilities-receipt.json"),
  receipt: any = { startedAt: new Date().toISOString(), cases: [] };
try {
  for (const provider of ["codex", "claude"] as Provider[]) {
    const library = provider === "codex" ? "claude" : "codex",
      project = path.join(
        repoRoot,
        ".test-state",
        `capability-${provider}-${Date.now()}`,
      );
    const agentDir = path.join(project, `.${library}/agents`),
      skillDir = path.join(
        project,
        `.${library}/skills/bridge-fixture-knowledge`,
      );
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(skillDir, "resources"), { recursive: true });
    const profile = `PROFILE_FROM_${library.toUpperCase()}`,
      resource = `RESOURCE_FOR_${provider.toUpperCase()}`;
    fs.writeFileSync(
      path.join(agentDir, "bridge-fixture-reviewer.md"),
      `---\nname: bridge-fixture-reviewer\ndescription: Minimal bridge capability verification profile\n---\nWhen reporting, include ${profile}.\n`,
    );
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: bridge-fixture-knowledge\ndescription: Minimal bridge resource verification skill\n---\nRead ${path.join(skillDir, "resources/note.txt")} and include its exact value in the response.\n`,
    );
    fs.writeFileSync(path.join(skillDir, "resources/note.txt"), resource);
    const actor = { provider: library as Provider, managerToken: "" };
    const catalog = await call(
      "catalog",
      { project, query: "bridge-fixture" },
      actor,
    );
    assert.equal(catalog.entries.length, 2);
    assert.ok(catalog.entries.every((c: any) => c.provider === library));
    const s = await call(
      "start",
      {
        requestId: randomUUID(),
        project,
        objective:
          "Verify cross-provider profile, skill resource, and questions",
        acceptance:
          "Selected instructions applied, resource read, question answered through native continuation",
      },
      actor,
    );
    actor.managerToken = s.managerToken;
    const { job } = await call(
      "delegate",
      {
        requestId: randomUUID(),
        taskId: s.task.id,
        capabilities: catalog.entries.map((c: any) => c.id),
        effort: "low",
        prompt:
          "Follow your selected profile and skill. Read the selected skill resource. Return one line starting NEEDS_INPUT: asking the manager for a chosen number, and include both exact markers you obtained. Do not edit anything.",
      },
      actor,
    );
    async function wait() {
      let cursor = 0;
      for (;;) {
        const r = await call(
          "read",
          { taskId: s.task.id, jobId: job.id, cursor, waitMs: 30000 },
          actor,
        );
        cursor = r.cursor;
        if (!["queued", "running"].includes(r.jobs[0].state)) return r.jobs[0];
      }
    }
    const first = await wait();
    assert.equal(first.state, "needs_input", first.error);
    assert.ok(first.result.includes(profile));
    assert.ok(first.result.includes(resource));
    await call(
      "send",
      {
        requestId: randomUUID(),
        taskId: s.task.id,
        jobId: job.id,
        message:
          "The chosen number is 17. Reply ANSWER_17 and repeat the two exact markers from your earlier response. Do not use tools or ask another question.",
      },
      actor,
    );
    const last = await wait();
    assert.equal(last.state, "completed", last.error);
    assert.equal(last.nativeId, first.nativeId);
    for (const marker of ["ANSWER_17", profile, resource])
      assert.ok(last.result.includes(marker));
    await call(
      "finish",
      {
        requestId: randomUUID(),
        taskId: s.task.id,
        summary: "Cross-provider capabilities and question round-trip passed",
        evidence: `${provider} used ${library} profile and skill resource; same native session ${last.nativeId} retained both markers and accepted the answer.`,
      },
      actor,
    );
    receipt.cases.push({
      provider,
      library,
      taskId: s.task.id,
      nativeId: last.nativeId,
      selected: catalog.entries.map((c: any) => ({
        kind: c.kind,
        name: c.name,
        provider: c.provider,
      })),
      questionState: first.state,
      answeredState: last.state,
      usage: last.usage,
    });
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
    console.log(
      `${provider}: applied ${library} profile and skill resource; native question round-trip passed`,
    );
  }
  receipt.completedAt = new Date().toISOString();
} catch (e) {
  receipt.error = e instanceof Error ? e.message : String(e);
  console.error(receipt.error);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
}
