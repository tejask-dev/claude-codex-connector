import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { Store } from "./store.js";
import {
  defaults,
  hash,
  jsonWrite,
  privateDir,
  projectPath,
  type Config,
} from "./config.js";
import {
  createSnapshot,
  changes,
  integrate,
  rollbackIntegration,
} from "./workspace.js";
import {
  now,
  terminal,
  type Actor,
  type Adapter,
  type Job,
  type Model,
  type Provider,
  type Task,
} from "./types.js";
import { schemas, type Operation } from "./api.js";
import { capabilities, selectedCapabilities } from "./catalog.js";
import { sessionList, sessionRead } from "./sessions.js";
import { recordProcess, recoverProcesses } from "./processes.js";
const secret = () => randomBytes(32).toString("hex");
export function publicJob(j: Job) {
  const { workerTokenHash, prompt, capabilityInstructions, ...safe } = j;
  return {
    ...safe,
    result: j.result?.slice(0, 6000),
    fullResultPath: path.join(j.artifacts, "result.txt"),
  };
}
export function publicTask(t: Task) {
  const { managerTokenHash, ...safe } = t;
  return safe;
}
export class Coordinator {
  store: Store;
  active = new Map<string, AbortController>();
  running = new Map<string, Promise<void>>();
  events = new EventEmitter();
  closing = false;
  modelCache = new Map<Provider, { at: number; models: Model[] }>();
  mutationTail: Promise<unknown> = Promise.resolve();
  constructor(
    public cfg: Config,
    public adapters: Record<Provider, Adapter>,
  ) {
    this.store = new Store(cfg.stateDir);
    // Recovery never replays potentially side-effecting work.
    for (const job of this.store.jobs())
      if (!terminal(job.state)) {
        recoverProcesses(job.artifacts);
        job.state = "interrupted";
        job.error =
          "Coordinator restarted; work was not replayed. Inspect the workspace before continuing.";
        this.store.saveJob(job);
        this.emit(job, "interrupted", { reason: job.error });
      }
  }
  emit(job: Job, type: string, data: unknown) {
    this.store.event(job.taskId, job.id, type, data);
    this.events.emit(job.taskId);
  }
  owner(task: Task, actor: Actor) {
    if (
      actor.workerToken ||
      !actor.managerToken ||
      hash(actor.managerToken) !== task.managerTokenHash
    )
      throw new Error(
        "Current manager token required; worker delegation and stale ownership are rejected",
      );
    if (task.state !== "active") throw new Error("Task is no longer active");
  }
  async models(provider: Provider) {
    const cache = this.modelCache.get(provider);
    if (cache && Date.now() - cache.at < 300000) return cache.models;
    const models = await this.adapters[provider].models();
    this.modelCache.set(provider, { at: Date.now(), models });
    return models;
  }
  async validateModel(provider: Provider, model?: string, effort?: string) {
    if (!model && !effort) return;
    const list = await this.models(provider);
    const chosen =
      list.find((m) => m.id === model) ||
      (provider === "claude" && model?.endsWith("[1m]")
        ? list.find((m) => m.id === model.slice(0, -4))
        : undefined) ||
      (!model ? list.find((m) => m.default) : undefined);
    if (model && !chosen)
      throw new Error(
        `Unsupported ${provider} model: ${model}. Use team_models.`,
      );
    if (effort && (!chosen?.efforts || !chosen.efforts.includes(effort)))
      throw new Error(`Unsupported effort ${effort} for ${model || provider}`);
  }
  execute(op: Operation, raw: unknown, supplied: Actor): Promise<any> {
    if (
      [
        "read",
        "status",
        "models",
        "question",
        "catalog",
        "capability",
        "sessions",
        "session_read",
      ].includes(op)
    )
      return this.executeInternal(op, raw, supplied);
    const next = this.mutationTail.then(() =>
      this.executeInternal(op, raw, supplied),
    );
    this.mutationTail = next.catch(() => {});
    return next;
  }
  private async executeInternal(
    op: Operation,
    raw: unknown,
    supplied: Actor,
  ): Promise<any> {
    if (!(op in schemas)) throw new Error("Unknown operation");
    const input: any = schemas[op].parse(raw);
    const actor = {
      ...supplied,
      managerToken: supplied.managerToken || input.managerToken,
    };
    if (this.closing) throw new Error("Coordinator shutting down");
    if (actor.workerToken && op !== "question")
      throw new Error(
        "Workers may only ask a scoped question; recursive orchestration is prohibited",
      );
    if (op === "catalog" || op === "capability") {
      const project = input.project
        ? projectPath(input.project, this.cfg)
        : undefined;
      const all = capabilities(project);
      if (op === "capability") {
        const item = all.find((c) => c.id === input.id);
        if (!item) throw new Error("Capability not found");
        const body = fs.readFileSync(item.path, "utf8");
        return {
          ...item,
          instructions: body.slice(0, 48000),
          truncated: body.length > 48000,
          portability:
            "Instructions may be reused across providers. Tool/plugin availability and original scope still apply.",
        };
      }
      const filtered = all.filter(
        (c) =>
          (!input.kind || c.kind === input.kind) &&
          (!input.provider ||
            c.provider === input.provider ||
            c.provider === "shared") &&
          `${c.name} ${c.description} ${c.path}`
            .toLowerCase()
            .includes(input.query.toLowerCase()),
      );
      return {
        total: filtered.length,
        entries: filtered.slice(input.offset, input.offset + 20),
        nextOffset:
          filtered.length > input.offset + 20 ? input.offset + 20 : null,
      };
    }
    if (op === "sessions")
      return sessionList(
        this.cfg,
        input.provider,
        input.cursor,
        input.query,
        input.project ? projectPath(input.project, this.cfg) : undefined,
      );
    if (op === "session_read")
      return sessionRead(
        this.cfg,
        input.provider,
        input.id,
        input.offset,
        input.cursor,
      );
    if (op === "question") {
      const j = this.store.job(input.jobId);
      if (!actor.workerToken || hash(actor.workerToken) !== j.workerTokenHash)
        throw new Error("Worker token required");
      this.emit(j, "question", { question: input.question });
      return { recorded: true };
    }
    if (op === "models")
      return {
        provider: input.provider,
        models: await this.models(input.provider),
      };
    if (op === "status") {
      if (input.taskId)
        return {
          task: publicTask(this.store.task(input.taskId)),
          jobs: this.store.jobs(input.taskId).map(publicJob),
        };
      const all = this.store.tasks();
      return {
        tasks: all.slice(input.offset, input.offset + 25).map(publicTask),
        nextOffset: all.length > input.offset + 25 ? input.offset + 25 : null,
        total: all.length,
        activeJobs: this.store
          .jobs()
          .filter((j) => !terminal(j.state))
          .map(publicJob),
      };
    }
    if (op === "read") {
      this.store.task(input.taskId);
      if (input.jobId && this.store.job(input.jobId).taskId !== input.taskId)
        throw new Error("Job belongs to another task");
      let list = this.store.events(input.taskId, input.cursor, input.jobId);
      const pending = this.store
        .jobs(input.taskId)
        .some(
          (j) => (!input.jobId || j.id === input.jobId) && !terminal(j.state),
        );
      if (!list.length && pending && input.waitMs) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.events.off(input.taskId, done);
            resolve();
          };
          const timer = setTimeout(done, input.waitMs);
          this.events.once(input.taskId, done);
        });
        list = this.store.events(input.taskId, input.cursor, input.jobId);
      }
      return {
        events: list,
        cursor: list.at(-1)?.seq ?? input.cursor,
        jobs: this.store
          .jobs(input.taskId)
          .filter((j) => !input.jobId || j.id === input.jobId)
          .map(publicJob),
        task: publicTask(this.store.task(input.taskId)),
      };
    }
    // An idempotency receipt must only be retrievable by its original owner.
    const fingerprint = hash(JSON.stringify({ op, input, actor }));
    const old = this.store.previous(input.requestId, fingerprint);
    if (old) return old;
    if (op === "start") {
      if (process.env.AGENT_TEAM_WORKER === "1")
        throw new Error("Worker process cannot create tasks");
      const managerToken = secret();
      const t: Task = {
        id: randomUUID(),
        project: projectPath(input.project, this.cfg),
        objective: input.objective,
        constraints: input.constraints,
        acceptance: input.acceptance,
        manager: actor.provider,
        managerTokenHash: hash(managerToken),
        generation: 1,
        state: "active",
        createdAt: now(),
        updatedAt: now(),
      };
      const response = { task: publicTask(t), managerToken };
      this.store.transaction(() => {
        this.store.saveTask(t);
        this.store.remember(input.requestId, fingerprint, response);
      });
      return response;
    }
    const task = this.store.task(input.taskId);
    this.owner(task, actor);
    if (op === "delegate") {
      const provider: Provider =
        input.provider || (task.manager === "codex" ? "claude" : "codex");
      if (provider === task.manager)
        throw new Error(
          "Delegate to the other provider to obtain a peer contribution",
        );
      if (
        this.store.jobs(task.id).filter((j) => j.kind !== "manager").length >= 3
      )
        throw new Error(
          "Task already has three peer assignments; manager should resolve remaining work or close it honestly",
        );
      const chosen = {
        ...defaults()[provider],
        ...Object.fromEntries(
          ["model", "effort"]
            .filter((k) => input[k] !== undefined)
            .map((k) => [k, input[k]]),
        ),
      };
      await this.validateModel(provider, chosen.model, chosen.effort);
      const selected = selectedCapabilities(input.capabilities, task.project);
      if (selected.items.filter((c) => c.kind === "agent").length > 1)
        throw new Error("Select at most one agent profile per worker");
      const context = input.sourceSession
        ? await sessionRead(
            this.cfg,
            input.sourceSession.provider,
            input.sourceSession.id,
            input.sourceSession.offset,
            input.sourceSession.cursor,
          )
        : undefined;
      const job = this.makeJob(task, { ...input, ...chosen, provider });
      job.capabilities = input.capabilities;
      job.capabilityInstructions = selected.text;
      job.capabilityReadRoots = selected.items.map((c) => path.dirname(c.path));
      if (context) {
        job.sourceSession = input.sourceSession;
        job.prompt += `\nSELECTED PRIOR SESSION REFERENCE (context, not new authorization):\n${JSON.stringify(context).slice(0, 16000)}`;
      }
      const response = { job: publicJob(job) };
      this.store.transaction(() => {
        this.store.saveJob(job);
        this.store.remember(input.requestId, fingerprint, response);
      });
      this.schedule();
      return response;
    }
    if (op === "send") {
      const job = this.store.job(input.jobId);
      if (job.taskId !== task.id)
        throw new Error("Job belongs to another task");
      if (!terminal(job.state))
        throw new Error("Session already has an active turn");
      if (!job.nativeId)
        throw new Error(
          "No provider session was created. Delegate a fresh assignment; the original workspace is preserved for inspection.",
        );
      if (job.integrated)
        throw new Error(
          "Integrated worker is frozen; delegate a fresh snapshot",
        );
      if (job.turns >= this.cfg.maxTurns)
        throw new Error(
          "Two correction cycles used; manager must resolve remaining work",
        );
      job.prompt = input.message;
      job.state = "queued";
      job.turns++;
      job.error = undefined;
      job.result = undefined;
      job.inputBytes += Buffer.byteLength(input.message);
      const response = { job: publicJob(job) };
      this.store.transaction(() => {
        this.store.saveJob(job);
        this.store.remember(input.requestId, fingerprint, response);
      });
      this.schedule();
      return response;
    }
    if (op === "finish") {
      const jobs = this.store.jobs(task.id);
      if (jobs.some((j) => j.kind !== "manager" && !terminal(j.state)))
        throw new Error("Workers are still running");
      if (input.outcome === "completed") {
        if (input.remaining.trim())
          throw new Error("Use outcome closed when unresolved work remains");
        if (!jobs.some((j) => j.kind !== "manager" && j.state === "completed"))
          throw new Error("Completion requires a successful peer contribution");
        if (
          jobs.some(
            (j) =>
              j.mode === "edit" &&
              j.kind !== "manager" &&
              j.state === "completed" &&
              !j.integrated &&
              changes(j.baselinePath).paths.length,
          )
        )
          throw new Error("Completed edits remain unintegrated");
      }
      task.state = input.outcome;
      task.completion = {
        summary: input.summary,
        evidence: input.evidence,
        remaining: input.remaining,
      };
      const response = { task: publicTask(task) };
      this.store.transaction(() => {
        this.store.saveTask(task);
        this.store.remember(input.requestId, fingerprint, response);
      });
      return response;
    }
    if (op === "control") {
      let job = input.jobId ? this.store.job(input.jobId) : undefined;
      if (job && job.taskId !== task.id)
        throw new Error("Job belongs to another task");
      let response: any;
      if (input.action === "cancel") {
        const targets = job
          ? [job]
          : this.store.jobs(task.id).filter((j) => !terminal(j.state));
        response = { cancelled: targets.map((j) => j.id) };
        this.store.transaction(() => {
          for (const j of targets)
            if (!terminal(j.state)) {
              j.state = "cancelled";
              j.error = "Cancelled by manager";
              this.store.saveJob(j);
              this.emit(j, "cancelled", {});
            }
          this.store.remember(input.requestId, fingerprint, response);
        });
        for (const j of targets) this.active.get(j.id)?.abort();
      } else if (input.action === "set_model") {
        if (!job || !terminal(job.state))
          throw new Error("Select a job at a turn boundary");
        const model = input.model ?? job.model,
          effort = input.effort ?? job.effort;
        await this.validateModel(job.provider, model, effort);
        job.model = model;
        job.effort = effort;
        response = { job: publicJob(job) };
        this.store.transaction(() => {
          this.store.saveJob(job!);
          this.store.remember(input.requestId, fingerprint, response);
        });
      } else if (input.action === "integrate") {
        if (!job || job.mode !== "edit" || job.state !== "completed")
          throw new Error("Only completed edit jobs may be integrated");
        if (job.integrated) throw new Error("Job already integrated");
        const result = integrate(job.baselinePath);
        job.integrated = true;
        response = { changes: result };
        this.store.transaction(() => {
          this.store.saveJob(job!);
          this.emit(job!, "integrated", response);
          this.store.remember(input.requestId, fingerprint, response);
        });
      } else if (input.action === "rollback_integration") {
        if (!job || job.mode !== "edit" || job.integrated)
          throw new Error(
            "Select an edit job with uncertain, unrecorded integration",
          );
        response = rollbackIntegration(job.baselinePath);
        this.store.transaction(() => {
          this.emit(job!, "integration_rolled_back", response);
          this.store.remember(input.requestId, fingerprint, response);
        });
      } else {
        if (this.store.jobs(task.id).some((j) => !terminal(j.state)))
          throw new Error(
            "Handoff requires a turn boundary with no active jobs",
          );
        const next: Provider =
          input.provider || (task.manager === "codex" ? "claude" : "codex");
        if (next === task.manager)
          throw new Error("Manager is already that provider");
        const managerToken = secret();
        task.manager = next;
        task.managerTokenHash = hash(managerToken);
        task.generation++;
        const chosen = {
          ...defaults()[next],
          ...Object.fromEntries(
            ["model", "effort"]
              .filter((k) => input[k] !== undefined)
              .map((k) => [k, input[k]]),
          ),
        };
        await this.validateModel(next, chosen.model, chosen.effort);
        const capsule = `Management handoff. ${input.handoff || ""}\nPrior jobs: ${JSON.stringify(this.store.jobs(task.id).map((j) => ({ id: j.id, provider: j.provider, state: j.state, result: j.result?.slice(0, 3000), workspace: j.workspace, integrated: j.integrated })))}`;
        job = this.makeJob(task, {
          provider: next,
          mode: "read",
          role: "manager",
          prompt: capsule,
          ...chosen,
        });
        job.kind = "manager";
        fs.writeFileSync(
          path.join(job.artifacts, "manager-token"),
          managerToken,
          { mode: 0o600 },
        );
        // New lease goes to the managed manager. Foreground retains this handle for observation.
        response = {
          task: publicTask(task),
          managerJob: publicJob(job),
          managerToken,
          handoff: capsule,
        };
        this.store.transaction(() => {
          this.store.saveTask(task);
          this.store.saveJob(job!);
          this.store.remember(input.requestId, fingerprint, response);
        });
        this.schedule();
      }
      return response;
    }
    throw new Error("Unknown operation");
  }
  makeJob(task: Task, input: any): Job {
    const id = randomUUID();
    const artifacts = path.join(this.cfg.stateDir, "jobs", id);
    privateDir(artifacts);
    const snapshot = createSnapshot(task.project, artifacts);
    return {
      id,
      kind: "worker",
      taskId: task.id,
      provider: input.provider,
      mode: input.mode,
      role: input.role,
      prompt: input.prompt,
      model: input.model,
      effort: input.effort,
      state: "queued",
      createdAt: now(),
      updatedAt: now(),
      turns: 1,
      timeoutMs: input.timeoutMs || this.cfg.timeoutMs,
      ...snapshot,
      artifacts,
      workerTokenHash: hash(secret()),
      inputBytes: Buffer.byteLength(input.prompt),
      outputBytes: 0,
      requestId: input.requestId || randomUUID(),
    };
  }
  schedule() {
    if (this.closing) return;
    for (const job of this.store.jobs()) {
      if (job.state !== "queued" || this.active.has(job.id)) continue;
      const runningJobs = this.store
        .jobs()
        .filter((j) => this.active.has(j.id));
      if (
        job.kind === "manager"
          ? runningJobs.filter((j) => j.kind === "manager").length >= 2
          : runningJobs.filter((j) => j.kind !== "manager").length >=
            this.cfg.concurrency
      )
        continue;
      const controller = new AbortController();
      this.active.set(job.id, controller);
      const promise = this.run(job, controller).finally(() => {
        this.active.delete(job.id);
        this.running.delete(job.id);
        this.schedule();
      });
      this.running.set(job.id, promise);
    }
  }
  async run(job: Job, controller: AbortController) {
    job.state = "running";
    this.store.saveJob(job);
    this.emit(job, "running", { turn: job.turns });
    const timer = setTimeout(
      () => controller.abort(new Error("Job watchdog expired")),
      job.timeoutMs,
    );
    try {
      const task = this.store.task(job.taskId);
      const manager =
        job.kind === "manager"
          ? {
              token: fs.readFileSync(
                path.join(job.artifacts, "manager-token"),
                "utf8",
              ),
              stateDir: this.cfg.stateDir,
            }
          : undefined;
      const result = await this.adapters[job.provider].run({
        job,
        task,
        prompt: job.prompt,
        signal: controller.signal,
        manager,
        emit: (type, data: any) => {
          if (type === "process") {
            recordProcess(job.artifacts, data.pid);
            return;
          }
          if (type === "input") {
            job.transportInputBytes =
              (job.transportInputBytes || 0) + data.bytes;
            this.store.saveJob(job);
            return;
          }
          if (type === "session") {
            job.nativeId = data.nativeId;
            job.effectiveModel = data.model;
            const live = this.store.job(job.id);
            if (live.state === "running") this.store.saveJob(job);
          }
          this.emit(job, type, data);
        },
      });
      const live = this.store.job(job.id);
      if (live.state === "cancelled") return;
      if (controller.signal.aborted) throw new Error("Job watchdog expired");
      job.result = result.text;
      job.nativeId = result.nativeId || job.nativeId;
      job.effectiveModel = result.model || job.effectiveModel;
      job.usage = result.usage;
      job.outputBytes += Buffer.byteLength(result.text);
      job.state = result.needsInput ? "needs_input" : "completed";
      job.error = result.needsInput;
      fs.writeFileSync(path.join(job.artifacts, "result.txt"), result.text, {
        mode: 0o600,
      });
      jsonWrite(
        path.join(job.artifacts, "changes.json"),
        changes(job.baselinePath).changes,
      );
      if (job.mode === "read" && changes(job.baselinePath).paths.length) {
        job.state = "failed";
        job.error = "Read-only worker modified its snapshot";
      }
      this.store.saveJob(job);
      this.emit(job, job.state, {
        resultPath: path.join(job.artifacts, "result.txt"),
      });
    } catch (e) {
      if (this.store.job(job.id).state === "cancelled") return;
      job.state = controller.signal.aborted ? "interrupted" : "failed";
      job.error = e instanceof Error ? e.message : String(e);
      this.store.saveJob(job);
      this.emit(job, job.state, { error: job.error });
    } finally {
      clearTimeout(timer);
    }
  }
  async close() {
    this.closing = true;
    for (const c of this.active.values()) c.abort();
    await Promise.allSettled(this.running.values());
    this.store.close();
  }
}
