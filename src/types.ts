export type Provider = "claude" | "codex";
export type JobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "needs_input";
export type Mode = "read" | "edit";
export interface Actor {
  provider: Provider;
  workerToken?: string;
  managerToken?: string;
}
export interface Task {
  id: string;
  project: string;
  objective: string;
  constraints: string;
  acceptance: string;
  manager: Provider;
  managerTokenHash: string;
  generation: number;
  state: "active" | "completed" | "closed";
  createdAt: string;
  updatedAt: string;
  completion?: { summary: string; evidence: string; remaining: string };
}
export interface Job {
  kind?: "worker" | "manager";
  id: string;
  taskId: string;
  provider: Provider;
  mode: Mode;
  role: string;
  prompt: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  turns: number;
  timeoutMs: number;
  model?: string;
  effort?: string;
  effectiveModel?: string;
  nativeId?: string;
  workspace: string;
  baselinePath: string;
  artifacts: string;
  result?: string;
  error?: string;
  usage?: unknown;
  workerTokenHash: string;
  integrated?: boolean;
  inputBytes: number;
  outputBytes: number;
  requestId: string;
  capabilities?: string[];
  capabilityInstructions?: string;
  sourceSession?: { provider: Provider; id: string };
  capabilityReadRoots?: string[];
  transportInputBytes?: number;
}
export interface BridgeEvent {
  seq: number;
  taskId: string;
  jobId?: string;
  type: string;
  data: unknown;
  at: string;
}
export interface Model {
  id: string;
  name: string;
  efforts?: string[];
  default?: boolean;
}
export interface RunInput {
  job: Job;
  task: Task;
  prompt: string;
  signal: AbortSignal;
  emit: (type: string, data: unknown) => void;
  manager?: { token: string; stateDir: string };
}
export interface RunResult {
  text: string;
  nativeId?: string;
  model?: string;
  usage?: unknown;
  needsInput?: string;
}
export interface Adapter {
  run(input: RunInput): Promise<RunResult>;
  models(): Promise<Model[]>;
}
export const terminal = (s: JobState) => !["queued", "running"].includes(s);
export const now = () => new Date().toISOString();
