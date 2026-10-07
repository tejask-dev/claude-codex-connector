import { z } from "zod";
const id = z.string().uuid();
const token = z.string().min(32).max(128);
const provider = z.enum(["claude", "codex"]);
const auth = { taskId: id, managerToken: token.optional() };
const request = { requestId: id };
export const schemas = {
  start: z
    .object({
      ...request,
      project: z.string().min(1).max(4096),
      objective: z.string().min(1).max(12000),
      constraints: z.string().max(12000).default(""),
      acceptance: z.string().min(1).max(12000),
    })
    .strict(),
  delegate: z
    .object({
      ...request,
      ...auth,
      provider: provider.optional(),
      mode: z.enum(["read", "edit"]).default("read"),
      role: z
        .enum(["research", "implementation", "testing", "review"])
        .default("review"),
      prompt: z.string().min(1).max(48000),
      model: z.string().max(200).optional(),
      effort: z.string().max(30).optional(),
      timeoutMs: z.number().int().min(1000).max(7200000).optional(),
      capabilities: z
        .array(z.string().regex(/^[a-f0-9]{24}$/))
        .max(8)
        .default([]),
      sourceSession: z
        .object({
          provider,
          id,
          offset: z.number().int().min(0).default(0),
          cursor: z.string().max(1000).optional(),
        })
        .optional(),
    })
    .strict(),
  send: z
    .object({
      ...request,
      ...auth,
      jobId: id,
      message: z.string().min(1).max(48000),
    })
    .strict(),
  read: z
    .object({
      taskId: id,
      jobId: id.optional(),
      cursor: z.number().int().min(0).default(0),
      waitMs: z.number().int().min(0).max(30000).default(0),
    })
    .strict(),
  control: z
    .object({
      ...request,
      ...auth,
      action: z.enum([
        "cancel",
        "set_model",
        "handoff",
        "integrate",
        "rollback_integration",
      ]),
      jobId: id.optional(),
      provider: provider.optional(),
      model: z.string().max(200).optional(),
      effort: z.string().max(30).optional(),
      handoff: z.string().max(16000).optional(),
    })
    .strict(),
  status: z
    .object({
      taskId: id.optional(),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  models: z.object({ provider }).strict(),
  finish: z
    .object({
      ...request,
      ...auth,
      summary: z.string().min(1).max(12000),
      evidence: z.string().min(1).max(16000),
      remaining: z.string().max(12000).default(""),
      outcome: z.enum(["completed", "closed"]).default("completed"),
    })
    .strict(),
  question: z
    .object({ jobId: id, question: z.string().min(1).max(8000) })
    .strict(),
  catalog: z
    .object({
      project: z.string().optional(),
      query: z.string().max(200).default(""),
      kind: z.enum(["skill", "agent"]).optional(),
      provider: provider.optional(),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  capability: z
    .object({
      project: z.string().optional(),
      id: z.string().regex(/^[a-f0-9]{24}$/),
    })
    .strict(),
  sessions: z
    .object({
      provider,
      project: z.string().optional(),
      query: z.string().max(200).optional(),
      cursor: z.string().max(1000).optional(),
    })
    .strict(),
  session_read: z
    .object({
      provider,
      id,
      offset: z.number().int().min(0).default(0),
      cursor: z.string().max(1000).optional(),
    })
    .strict(),
};
export type Operation = keyof typeof schemas;
export const descriptions: Record<Operation, string> = {
  start:
    "Begin a local teamwork task for substantial development. The foreground agent is manager. Retain the returned managerToken. Trivial tasks do not need teamwork.",
  delegate:
    "Delegate a scoped peer assignment. Returns a persistent job handle immediately. Reuse requestId on uncertain retries. Workers cannot delegate. Edit jobs use an isolated workspace.",
  send: "Continue a completed or blocked peer session with only new instructions. Limited to two correction turns. Never replay the full transcript.",
  read: "Read compact progress/results after a cursor; optionally wait up to 30 seconds. Full output and workspace artifacts are returned as local paths.",
  control:
    "Cancel, change model/effort between turns, integrate a completed edit with stale-source checks, roll back an uncertain integration using guarded backups, or transfer management to a managed session of the other provider.",
  status:
    "Show local teamwork tasks, jobs, effective models, usage, and artifacts.",
  models:
    "Discover supported model and effort choices through the installed provider runtime without an inference turn. Catalog availability is not entitlement proof.",
  finish:
    "Record completion and verification evidence. Completion requires a successful peer contribution and no unfinished workers; close records incomplete work honestly.",
  question:
    "A delegated worker asks its manager a scoped question. Does not create another agent or new task.",
  catalog:
    "Search installed local skill and agent-profile instructions from both providers. Returns compact metadata, not full prompts. Catalog presence does not guarantee required plugins or external tools are available.",
  capability:
    "Read one selected skill or agent profile. Either provider may use portable instructions; provider-specific tools are not automatically granted.",
  sessions:
    "List supported local Codex or Claude Code sessions. Does not take over active sessions or promise access to cloud/Desktop chat histories.",
  session_read:
    "Read a bounded page of a selected local session as reference material. Use delegate.sourceSession for a scoped context handoff into a separate worker; original sessions are not resumed or mutated.",
};
