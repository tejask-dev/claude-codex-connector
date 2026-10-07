# Verification receipt

Public preview: **0.2.0**. Checked on **2026-10-07**, macOS arm64, Node **24.20.0**, with pinned dependencies. This document deliberately excludes personal paths, task/session identifiers, raw transcripts, and account information.

## Automated checks on the public edition

- `npm run verify`: passed typechecking, formatting, **37 tests**, public-file hygiene, TypeScript build, and Desktop manifest/schema packaging.
- `npm audit --omit=dev --audit-level=high`: no known vulnerabilities reported at verification time.
- Gitleaks **8.30.1**: source scan passed; the downloaded scanner archive was checked against the upstream SHA-256 manifest. A final Git-history/archive scan is required before publication.
- Actual Claude Agent SDK startup with a synthetic credential and isolated home: selected `ANTHROPIC_API_KEY` as expected. **No prompt was submitted and no model inference was tested.** This verifies source selection, not a valid paid API session.

Tests cover dirty Git preservation, binary/executable files, stale source and symlink rejection, lost/partial integration receipts and rollback, deduplicated requests, provider failures, bounded sessions, cancellation/watchdogs, restart recovery, management leases, capability discovery, MCP discovery, Desktop virtual-stream transport, explicit auth, scoped instructions, secret filename exclusions, and installer ownership/approval preservation.

Coordinator/provider-state tests use fake adapters. Desktop tests use a virtual host. They are not substitutes for model-backed, real-Desktop, billing, or security-penetration testing. The generated MCPB is machine-local and is not a release asset.

## Peer review and historical evidence

This release received a real Claude review through the existing private development bridge. Its initial findings drove changes to explicit public authentication, instruction boundaries, optional routing, normal approval policies, and portable configuration. A final review of the corrected source is pending before publication. This is source review, not a public-edition live inference test.

The predecessor was exercised with live local providers and a Desktop MCP flow. Those private receipts are intentionally not published and do not establish fresh compatibility for the public edition's changed authentication path.

## Still requiring live confirmation

- Both delegation directions using the public edition and a contributor's explicitly configured API key.
- Paid API usage and a complete real development/integration cycle on this edition.
- Fresh activation in all three real clients, including automatic substantial-task routing and trivial-task bypass.
- Model changes, restart continuity, management transfer and cancellation against each contributor's installed provider versions.
- Linux/Windows support, universal skill/plugin access, and quantified token savings are **not claimed**.

Live scripts are opt-in and may incur charges. For a contributor-controlled run, configure a dedicated `AGENT_TEAM_STATE_DIR` outside project roots, permit this checkout as a test root, explicitly save a test API key, and run `npm run test:live` before `npm run test:controls` (which consumes its local receipt). The controls script restarts its coordinator. Activation tests additionally require foreground CLI authentication and MCP/guidance registration pointing at that same test state. Use an isolated OS account if you need to avoid changing your everyday client registration. Never run these tests against a coordinator serving unrelated work. Keep generated receipts private.

GitHub Actions runs only account-free automated checks on macOS. Check the workflow linked from the README for the status of a particular commit. No savings percentage or guarantee of flawless operation is asserted.
