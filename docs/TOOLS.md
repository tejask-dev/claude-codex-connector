# Tools and recovery

All tools are available through MCP as `team_<operation>`, and through `agent-team <operation> - --origin codex|claude` with a JSON object on stdin. The CLI fills in an omitted `requestId`; MCP callers supply a fresh UUID. Retain that ID when retrying an unknown outcome.

## Normal workflow

1. `start`: `project` (absolute path), `objective`, `acceptance`, optional `constraints`. Retain `task.id` and `managerToken`.
2. `catalog`: search `query`, optionally `project`, `kind` (`skill` or `agent`), and provider. Pages contain 20 compact entries. Use `nextOffset` to continue.
3. `capability`: selected catalog `id`, plus `project` if it was a project-local entry. Read only the relevant instructions.
4. `delegate`: `taskId`, `managerToken`, `prompt`, optional `role`, `mode`, `model`, `effort`, `capabilities`, and `timeoutMs`. The other provider is selected by default. `mode: "read"` is the default; `"edit"` enables isolated implementation and tests. The returned `job.id` is the persistent handle.
5. `read`: `taskId`, `jobId`, `cursor: 0`, `waitMs: 30000`. Pass the returned cursor next time. Summaries are capped at 6,000 characters; full output stays in the returned artifact path.
6. `send`: task authorization, `jobId`, and `message` with only new instructions. Native context is resumed. Two follow-up turns are allowed. Jobs without a native session ID require a fresh delegation.
7. `control`: task authorization, `jobId`, `action: "integrate"`. Review the changed files before integrating, then run the project's checks in the original checkout. Completed integrated workers are frozen.
8. `finish`: task authorization, `summary`, and concrete `evidence`. Successful completion requires peer work and integrated edits. For incomplete work, use `outcome: "closed"` with `remaining`.

`status` accepts a task ID or returns a page of recent tasks plus active jobs. Global pages have 25 tasks and `nextOffset`. `models` takes a provider and returns runtime-supported choices. Availability in the catalog does not prove account entitlement.

## Controls

Use `control` with the task authorization and a new request ID:

| Action | Additional fields | Result |
| --- | --- | --- |
| `cancel` | Optional `jobId` | Interrupt one job or every active job in the task. |
| `set_model` | `jobId`, `model` and/or `effort` | Change the next turn's settings at a turn boundary. |
| `handoff` | Optional `provider`, `model`, `effort`, `handoff` | Rotate the manager lease and launch the other provider as manager. |
| `integrate` | `jobId` | Apply completed edits after source-drift checks. |
| `rollback_integration` | `jobId` | Restore an uncertain, unrecorded integration if affected source paths still match the baseline or recorded worker output. |

After handoff, observe `managerJob` and retain the replacement `managerToken` for human-directed controls. The former token cannot mutate the task. Each task has only one current manager lease.

Workers return `NEEDS_INPUT:` when blocked or needing a decision. Read the question, obtain human authorization if it exceeds the existing grant, and answer through `send`. A peer cannot authorize publication, deployment, account changes, or broader filesystem access.

## Existing sessions

`sessions` takes `provider`, optional `project`/`query`, and the returned `cursor` for the next metadata page. `session_read` takes `provider` and a native session `id`; Claude continuation uses `offset`, Codex uses its returned opaque `cursor`. Codex reads 12 recent persisted items at a time and omits tool/reasoning content; a page may therefore contain no text messages. Continue through the returned cursor if needed.

Set `delegate.sourceSession` to `{ "provider": "codex", "id": "native-uuid" }` to seed a new worker with one bounded page of reference context. This is read-only access to the original session. Ordinary Desktop chats, cloud-only chats, active foreign processes, and unavailable native tools are outside these APIs.

## Recovery

After a coordinator crash, use `status`, inspect the job workspace and result/journal paths, and decide whether to continue a native session. No request that may have edited files is blindly replayed.

If integration returned no receipt, retry the **same request ID** first. A fully applied journal with matching source bytes is reconciled into the receipt without copying again. A partial journal is reported explicitly. Review it, then invoke `rollback_integration` and retry integration under a new request ID. Rollback refuses to overwrite subsequent user edits; resolve those paths manually. The source Git index is never staged or reset by integration.

State is deliberately retained. For a finished task's Git workspace, use `git -C <original-project> worktree remove <job-workspace>` only after saving any needed output; Git will refuse dirty removal unless you explicitly force it. The CLI does not automatically destroy worker workspaces.
