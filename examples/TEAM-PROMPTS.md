# Copyable prompts

Use a project inside your configured roots. These prompts explicitly invoke teamwork because a server cannot force arbitrary chats to use it.

## Read-only review

> Use the local agent-team bridge for this project. Start one task, delegate a focused read-only correctness review to the other provider, inspect its findings, and finish with actual evidence. Do not modify files or publish anything. Report unavailable tools honestly.

## Implementation and tests

> Use the local agent-team bridge. I will manage this task in the foreground. Delegate one bounded implementation assignment in an isolated workspace, including the relevant current uncommitted changes. Inspect the worker diff, integrate only through drift checks, run the focused tests in the integrated project, and record the peer contribution with team_finish. Do not deploy or push.

## Continue a worker

> Resume the existing bridge job with team_send. Send only the new correction and acceptance criteria. Use its native session and read cursor. Do not create duplicate work or replay the entire transcript.

## Skill selection

> Search team_catalog for the relevant skill or agent profile from either provider, read only the selected entries, and attach their IDs to the assignment. Treat them as instructions; do not assume their external tools are available.

## Management handoff

> At the current turn boundary, transfer this task to the other provider using team_control handoff. Include a compact summary of completed work, remaining acceptance checks and existing job IDs. Rotate ownership and observe the new manager instead of issuing competing assignments.
