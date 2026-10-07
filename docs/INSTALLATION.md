# Installation and troubleshooting

## Supported environment

The supported target is macOS with Node 24, npm, Git, and official Codex CLI/app-server. Linux and Windows are not supported releases. Provider contracts evolve; report exact versions and redacted errors. Dependencies are pinned in `package-lock.json`; npm installs them under their own licenses.

Use official [Codex installation instructions](https://developers.openai.com/codex/cli/) and [Claude Code setup](https://code.claude.com/docs/en/setup) when you need that foreground client. Complete authentication in the provider's own client. Never paste account credentials into an agent prompt.

## Configure before installing

Run these from the cloned repository after `npm ci && npm run build`:

```sh
node dist/src/cli.js configure --root "$HOME/Developer"
node dist/src/cli.js auth claude
npm run install:local
```

Roots must already exist. Repeat `--root` for multiple roots. Use an absolute `--codex` path when discovery cannot find it. Configure stores roots and the executable path in the private state directory's `config.json`. The CLI auth prompt stores the explicit Anthropic API key in `credentials.json` with mode 600 inside a mode-700 directory. For password managers, `agent-team auth claude --stdin` accepts a pipe; it never accepts a key as a command argument. No inference is performed during setup.

Ambient API-key variables are not forwarded automatically. The public Claude adapter requires its explicit local credential file; missing credentials fail clearly, without subscription login fallback. API usage is billed by Anthropic. Deleting `credentials.json` revokes local access to the saved key; revoke the key with its provider if it was exposed.

`AGENT_TEAM_STATE_DIR` can select a separate private state directory. Use the same value when configuring, authenticating, installing, and operating the bridge. Each directory identifies a separate coordinator. Keep credentials and state outside every project root. Changing root/runtime configuration requires a coordinator restart; first ensure it has no unrelated active jobs. `agent-team stop` interrupts all jobs in that coordinator.

## What installation changes

The installer adds its own MCP entry to `~/.codex/config.toml` and `~/.claude.json`, a CLI symlink at `~/.local/bin/agent-team`, and a `local-agent-team` skill link for both clients. It retains original configuration backups in the private state directory. Normal installation preserves client approval policies and does not install hooks.

Automatic instruction routing is opt-in with `npm run install:local -- --teamwork`. Only then are marked blocks added to configured root instruction files and Codex global instructions. Existing project protocols remain authoritative. Duplicate/malformed managed blocks are rejected for manual reconciliation. Backups may contain secrets belonging to other MCP servers, and receipts contain personal paths. They are retained in the private state directory; never share them. Custom `CODEX_HOME` and `CLAUDE_CONFIG_DIR` layouts are not supported by this installer; it targets the standard home-directory locations.

Keep the checkout at its installed location. Updating dependencies or moving Node may require rebuilding, reinstalling registrations, and repacking the Desktop extension. Restart foreground clients to refresh tool discovery.

## Desktop extension

`npm run pack:desktop` creates `build/agent-team-bridge.mcpb` using the current machine's absolute paths. Install it in Claude Desktop's extension settings. The Node path must point to Node 24; the entry must point to this checkout's `dist/src/mcp.js`. The launcher supports Electron's virtual streams and forwards transport errors/shutdown correctly.

The extension is a local launcher, not a self-contained app. It needs this checkout and dependencies. Do not commit or distribute its generated bundle: it contains local paths and will not work on another computer. Normal agent communication does not use the UI.

## Common problems

| Symptom | Check |
| --- | --- |
| Tools missing | Reload the foreground client; inspect its MCP registration; run `agent-team doctor`. |
| Node SQLite errors | Confirm the configured executable is Node 24. |
| Codex not found | Run configure with the official CLI's absolute path. |
| Claude explicit-auth error | Run `agent-team auth claude`; never solve it by copying another account's token. |
| Project outside allowed roots | Select its actual parent with configure; account for symlinks; restart an idle coordinator. |
| Another checkout owns installation | Uninstall that checkout first. Do not overwrite unrelated MCP entries or symlinks. |
| Worker cannot run a test | Read-only Claude workers have no shell. Editing workers need dependencies prepared in their snapshot and appropriate native sandbox support. |
| Job interrupted | Inspect its workspace and local events before continuing. Never blindly replay edits. |
| Integration rejected | Source changed after snapshot. Inspect the diff and resolve explicitly; see the tool recovery guide. |
| Desktop disconnects | Verify both paths, regenerate/install the bundle, and inspect local Desktop MCP logs. Redact logs before sharing. |

## Upgrade and uninstall

Review the changelog, finish active work, then update your checkout, run `npm ci && npm run verify`, and rerun the installer. Repack/reinstall Desktop when its launcher changes. Do not hot-swap a running coordinator in the middle of editing jobs.

```sh
npm run uninstall:local
```

Uninstall removes only this installation's managed entries, guidance, and symlinks. It preserves unrelated settings and task records. Remove the Desktop extension through its settings. Stop an idle coordinator before deleting its state. Saved API keys and retained source snapshots remain until you explicitly remove them; inspect that directory before deletion.
