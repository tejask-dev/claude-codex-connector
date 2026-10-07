# Security and privacy

This is an early-preview tool that launches coding agents with access to selected local projects. Review changes before integration. Use disposable projects first and grant the narrowest practical roots.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/tejask-dev/claude-codex-connector/security/advisories/new). Do not put credentials, transcripts, personal paths, proprietary source, or exploit details affecting an unpatched deployment in a public issue. If private reporting is unavailable, open an issue requesting a private contact without sensitive details. No response-time SLA is promised.

## What stays local and what leaves

The coordinator stores tasks, prompts, source snapshots, provider output, usage, and configuration under an owner-only local state directory. It does not upload these to this GitHub project and has no telemetry. The providers receive prompts, selected context, and tool results through their normal model services. Local coordination does not mean offline inference.

The socket and state directory are restricted to the current OS user. Manager tokens coordinate ownership; they are not a defense against malware already running as that user. Native provider sandboxes and tool gates reduce accidental edits. The shell, provider credential stores, and same-user environment are not a hardened multi-tenant security boundary. Run untrusted projects inside a separate OS account or dedicated sandbox.

## Secrets

The explicit Claude API credential is stored outside the project with file mode 600. It is passed to the Claude runtime, including potentially its child shell commands in edit mode; it is never passed to Codex workers. A malicious project could induce a worker to print or copy it. Use a dedicated limited-budget API key and a separate sandbox/account for untrusted projects. Ambient provider API keys and redirect variables are omitted from worker environments. The bridge does not extract browser credentials or offer Claude subscription OAuth. Provider output can still contain sensitive data if an agent reads or prints it; logs are not guaranteed to be secret-free.

Git snapshots include tracked files, even if a later ignore rule matches them, plus untracked files not excluded by Git ignore rules. An unignored `.env` is therefore included. Non-Git snapshots omit common secret filenames (`.env` except templates, `credentials.json`, SSH private-key names, and PEM/key/P12/PFX files) but do not interpret `.gitignore`. Neither snapshots nor provider logs are a secret scanner. Remove secrets from project files before delegating and select narrow project roots. Do not select your whole home directory.

Keep `.env`, credentials, local receipts, session exports, generated Desktop bundles, build outputs and source maps out of public commits. `npm run check:public` is a conservative hygiene check, not proof that arbitrary content is safe. Review filenames, diffs, archives, commit authors and history before publishing.

## Recovery and permissions

Workers cannot recursively delegate through the bridge. Requests beyond their native/tool grant are denied and surfaced to the manager. A worker report is not human authorization. Publishing, deployment, account changes and spending changes require the user's authorization.

Only integrate after review and with no concurrent edits to the same source paths. On interruption, inspect journal/workspace records; use the documented retry or rollback flow. Do not repeatedly start new editing jobs to guess whether an uncertain request succeeded.

The installer preserves unrelated configuration and hooks, uses marked blocks, and backs up configuration locally. Automatic routing is opt-in; it does not bypass native approval prompts. Uninstall retains sensitive task records and credentials until you explicitly remove them.
