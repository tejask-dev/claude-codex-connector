# Contributing

Thanks for helping make local cross-provider collaboration easier to inspect and use.

1. Open an issue for a significant behavior change. Keep the proposal focused.
2. Fork and create a topic branch. Use Node 24 and run `npm ci`.
3. Add regression coverage for meaningful behavior changes, with fake providers for ordinary tests. Keep docs and behavior together.
4. Run `npm run verify`. Do not call paid/live providers in CI or silently modify real client configuration.
5. Review the staged diff and run a secret scanner. Use a GitHub no-reply email if you want to keep your personal email private.
6. Open a PR explaining the problem, behavior change, verification and limitations.

## Useful commands

```sh
npm run build
npm run check
npm test
npm run format
npm run format:check
npm run check:public
npm run pack:desktop
```

`npm run verify` runs typechecking, formatting, tests, public-file checks and manifest packaging. Packages are local artifacts and are ignored by Git.

Live tests (`test:live`, `test:controls`, `test:activation`, `test:capabilities`) are opt-in, consume provider usage, and create local source snapshots and logs. `test:controls` restarts its coordinator. Use a dedicated `AGENT_TEAM_STATE_DIR` and never point disruptive tests at a coordinator serving other projects. See [verification](docs/VERIFICATION.md).

## Review expectations

Preserve bounded sessions, explicit authentication, request deduplication, lease ownership and source-drift protection. Do not add recursive agents, silent API-billing fallback, global hooks, public sockets, or automatic deployment. New platform/provider support needs concrete tests and clear compatibility limits.

Keep generated files, dependencies, private research, credentials, machine-local paths, session IDs and transcripts out of PRs. Report security issues privately. Be respectful and specific in review; maintainers may close abusive or off-topic contributions.
