# Third-party notices

The connector source is released under [MIT](LICENSE). That license does not replace the licenses or service terms of dependencies, provider runtimes, or model services. Dependencies are fetched by npm and are not vendored into this source release.

| Component | Version pinned for this release | License / terms |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | 0.3.289 | Package directs users to its README/license terms; governed by Anthropic's Commercial Terms, not this project's MIT license. Includes a compatible provider runtime. |
| `@modelcontextprotocol/sdk` | 1.32.0 | MIT |
| `smol-toml` | 1.9.0 | BSD-3-Clause |
| `zod` | 4.6.5 | MIT |

See each installed package and the lockfile for transitive dependency notices. The independently installed Codex CLI and foreground clients remain subject to their own licenses and terms.

`scripts/mcpb-manifest.schema.json` is a vendored MCPB manifest schema from [modelcontextprotocol/mcpb](https://github.com/modelcontextprotocol/mcpb). Its upstream copyright and permission notice are retained verbatim in [scripts/MCPB-LICENSE](scripts/MCPB-LICENSE). The schema has no local machine configuration embedded in it.

Design references, not copied implementation: [OpenAI's Codex Claude Code plugin](https://github.com/openai/codex-plugin-cc), [Frenemy](https://github.com/noblehacks/frenemy), and [Agent Bridge](https://github.com/iamneilroberts/agent-bridge). Product names identify compatible providers and do not imply endorsement.

Official interfaces: [Codex app-server](https://developers.openai.com/codex/app-server/), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), and [MCPB](https://github.com/modelcontextprotocol/mcpb).
