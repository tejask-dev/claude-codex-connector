# Architecture

The stdio MCP adapter and CLI share JSON operations over an owner-only Unix socket. A detached Node coordinator owns SQLite state and scheduling. Closing a client connection does not cancel its jobs. An exclusive SQLite lease prevents two coordinators owning the same state directory.

## Modules

| Module | Responsibility |
| --- | --- |
| `api.ts`, `types.ts` | Validated public operations and task/job/event contracts |
| `mcp.ts`, `cli.ts`, `client.ts` | MCP, terminal interface, framed local RPC and on-demand startup |
| `daemon.ts`, `daemon-lock.ts`, `store.ts` | Socket ownership, durable records and recovery |
| `coordinator.ts` | Manager leases, request deduplication, capacity, model controls and task completion |
| `workspace.ts` | Dirty-state snapshots, manifests, drift detection, integration journal and rollback |
| `providers/codex.ts` | Official app-server JSON-RPC, streaming, native sessions and interruption |
| `providers/claude.ts` | Official Agent SDK, native sessions and scoped permission hooks |
| `providers/common.ts`, `processes.ts` | Worker instructions, process ownership, logs and cleanup |
| `catalog.ts`, `sessions.ts` | Selected local skill/profile and supported history discovery |
| `config.ts`, `setup.ts`, `auth.ts` | Local roots/runtime configuration and explicit Claude API credentials |
| `install.ts` | Reversible registration and machine-local Desktop packaging |

## Task lifecycle

A foreground manager owns a lease token. Each worker has one native provider session and never receives manager authority. Repeated mutation IDs return the original receipt; only one turn may run in a session. A management handoff rotates ownership transactionally and launches a managed session with a compact task handoff. The previous lease cannot mutate the task.

The scheduler bounds work and enforces watchdogs. Cancellation interrupts the provider and terminates recorded process groups. Recovery marks uncertain jobs interrupted and does not replay inference. Caller disconnects are separate from explicit cancellation.

## Workspace integrity

Git projects use detached worktrees with captured tracked and nonignored untracked changes. The source index is untouched. Non-Git projects use directory snapshots; they omit common credential filenames and dependency directories but do not interpret `.gitignore`. Filename exclusions are not a secret detector. Never delegate a non-Git directory containing credentials. Ancestor instruction loading stops at the most specific configured root and uses relative labels; private home/system instructions above that grant are not injected. Both modes reject unsafe external symlinks and unsupported file types. Large files/snapshots and submodules require a prepared, narrower workspace.

Integration compares affected source bytes against the input snapshot and journals replacements with backups. A lost receipt can be reconciled if every output byte matches the completed journal. Partial integration remains explicit; guarded rollback refuses to overwrite later user edits. This is not atomic against unrelated external editors.

## Provider and local boundaries

Codex uses app-server through the user's official CLI authentication. The public Claude adapter uses an explicitly configured API key. Credentials are not part of task prompts, source snapshots, or MCP registration. Local SDK/CLI processes necessarily use their authentication material; same-user hostile code is outside the isolation model.

Local state persists prompts, tool output, results, usage and source snapshots. The coordinator has no public listener or remote control endpoint. Model providers still receive the context supplied to their agents. Historical session lookup uses supported local interfaces; arbitrary Desktop/cloud conversations are not available.
