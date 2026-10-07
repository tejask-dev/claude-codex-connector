import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveClaudeKey,
  claudeEnvironment,
  assertClaudeApiAuth,
} from "../src/auth.js";
import {
  config,
  childEnvironment,
  findExecutable,
  repoRoot,
  projectPath,
} from "../src/config.js";
import { configure } from "../src/setup.js";
import { install, uninstall, replaceBlock } from "../src/install.js";
import { createSnapshot, projectInstructions } from "../src/workspace.js";
import { assertDistribution } from "../src/client.js";
import { toolDecision } from "../src/providers/claude.js";

function fixture(fn: (home: string) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "connector-public-"));
  const previous = process.env.AGENT_TEAM_STATE_DIR;
  process.env.AGENT_TEAM_STATE_DIR = path.join(home, "state");
  try {
    fn(home);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_STATE_DIR;
    else process.env.AGENT_TEAM_STATE_DIR = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("Claude requires explicit credentials, never ambient fallback, and rejects insecure or malformed files without exposing bytes", () =>
  fixture((home) => {
    const cfg = config();
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "fixture-ambient-value";
    try {
      assert.throws(
        () => claudeEnvironment(cfg),
        /explicit API authentication/,
      );
      saveClaudeKey(cfg, "fixture-explicit-value");
      assert.equal(
        claudeEnvironment(cfg).ANTHROPIC_API_KEY,
        "fixture-explicit-value",
      );
      assert.equal(childEnvironment().ANTHROPIC_API_KEY, undefined);
      const file = path.join(cfg.stateDir, "credentials.json");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(cfg.stateDir).mode & 0o777, 0o700);
      fs.chmodSync(file, 0o644);
      assert.throws(() => claudeEnvironment(cfg), /owner-only/);
      fs.chmodSync(file, 0o600);
      fs.writeFileSync(file, "SECRET_MALFORMED_FIXTURE");
      assert.throws(
        () => claudeEnvironment(cfg),
        (err: Error) =>
          /malformed/.test(err.message) &&
          !err.message.includes("SECRET_MALFORMED_FIXTURE"),
      );
      fs.unlinkSync(file);
      const elsewhere = path.join(home, "elsewhere");
      fs.writeFileSync(elsewhere, '{"anthropicApiKey":"fixture-value"}', {
        mode: 0o600,
      });
      fs.symlinkSync(elsewhere, file);
      assert.throws(() => claudeEnvironment(cfg));
      assert.throws(() => saveClaudeKey(cfg, "two words"), /Invalid/);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  }));

test("Claude account guard fails closed for subscription, helper, and missing source", () => {
  assert.doesNotThrow(() =>
    assertClaudeApiAuth({ apiKeySource: "ANTHROPIC_API_KEY" }),
  );
  for (const apiKeySource of [
    undefined,
    "none",
    "oauth",
    "subscription",
    "apiKeyHelper",
  ])
    assert.throws(() => assertClaudeApiAuth({ apiKeySource }), /refusing/);
});

test("configure persists an executable and explicit existing roots, rejecting broad or relative grants", () =>
  fixture((home) => {
    const root = path.join(home, "projects");
    const bin = path.join(home, "bin");
    fs.mkdirSync(root);
    fs.mkdirSync(bin);
    const exe = path.join(bin, "codex");
    fs.writeFileSync(exe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(findExecutable("codex", bin, home), exe);
    assert.equal(
      findExecutable("certainly-missing-binary", ".", home),
      undefined,
    );
    configure(["--root", root, "--codex", exe]);
    assert.deepEqual(config().roots, [fs.realpathSync(root)]);
    assert.equal(config().codexBin, exe);
    assert.throws(
      () => configure(["--root", "/", "--codex", exe]),
      /too broad/,
    );
    assert.throws(() => configure(["--root", "relative"]), /absolute/);
  }));

test("default installation preserves approval policies and leaves automatic routing opt-in", () =>
  fixture((home) => {
    fs.mkdirSync(path.join(home, "Developer"));
    fs.mkdirSync(path.join(home, ".codex"));
    const file = path.join(home, ".codex/config.toml");
    fs.writeFileSync(file, 'approval_policy = "on-request"\n');
    install(home, repoRoot);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.includes('approval_policy = "on-request"'));
    assert.ok(!text.includes("approval_mode"));
    assert.ok(!fs.existsSync(path.join(home, "Developer/AGENTS.md")));
    assert.ok(!fs.existsSync(path.join(home, ".codex/AGENTS.md")));
    uninstall(home, repoRoot);
    assert.equal(
      fs.readFileSync(file, "utf8"),
      'approval_policy = "on-request"\n',
    );
  }));

test("duplicate guidance and foreign daemon distributions fail before reuse", () => {
  const block =
    "<!-- agent-team-bridge:start -->\nx\n<!-- agent-team-bridge:end -->\n";
  assert.throws(() => replaceBlock(block + block, ""), /Duplicate/);
  assert.throws(() => assertDistribution({}), /another bridge/);
  assert.doesNotThrow(() =>
    assertDistribution({ distribution: "claude-codex-connector" }),
  );
});

test("worker instructions stop at the configured root and refuse external symlinks", () =>
  fixture((home) => {
    const root = path.join(home, "projects");
    const project = path.join(root, "example");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(home, "AGENTS.md"), "PRIVATE_PARENT_CANARY");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Allowed root protocol");
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "Project protocol");
    const instructions = projectInstructions(project, [root]);
    assert.ok(instructions.includes("Allowed root protocol"));
    assert.ok(instructions.includes("Project protocol"));
    assert.ok(!instructions.includes("PRIVATE_PARENT_CANARY"));
    assert.ok(!instructions.includes(home));
    const narrowed = projectInstructions(project, [root, project]);
    assert.ok(!narrowed.includes("Allowed root protocol"));
    fs.symlinkSync(
      path.join(home, "AGENTS.md"),
      path.join(project, "AGENTS.md"),
    );
    assert.throws(
      () => projectInstructions(project, [root]),
      /symlink escapes/,
    );
  }));

test("non-Git snapshots omit common secret files while preserving originals and templates", () =>
  fixture((home) => {
    const project = path.join(home, "project");
    fs.mkdirSync(project);
    const secrets = [
      ".env",
      ".env.local",
      "credentials.json",
      "private.pem",
      "id_ed25519",
    ];
    for (const name of [...secrets, ".env.example", "app.ts"])
      fs.writeFileSync(path.join(project, name), "fixture only");
    const snap = createSnapshot(project, path.join(home, "job"));
    for (const name of secrets) {
      assert.ok(fs.existsSync(path.join(project, name)));
      assert.ok(!fs.existsSync(path.join(snap.workspace, name)));
    }
    assert.ok(fs.existsSync(path.join(snap.workspace, ".env.example")));
    assert.ok(fs.existsSync(path.join(snap.workspace, "app.ts")));
  }));

test("uninstall without an ownership receipt cannot remove another installation", () =>
  fixture((home) => {
    fs.mkdirSync(path.join(home, ".codex"));
    const file = path.join(home, ".codex/config.toml");
    const foreign =
      '# agent-team-bridge:start\n[mcp_servers.agent-team]\ncommand = "foreign"\n# agent-team-bridge:end\n';
    fs.writeFileSync(file, foreign);
    assert.equal(uninstall(home, repoRoot).uninstalled, false);
    assert.equal(fs.readFileSync(file, "utf8"), foreign);
    fs.mkdirSync(path.join(home, "Developer"));
    assert.throws(
      () => install(home, repoRoot),
      /unrelated agent-team Codex entry/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), foreign);
  }));

test("unconfigured public state grants no project access", () =>
  fixture((home) => {
    assert.deepEqual(config().roots, []);
    assert.throws(() => projectPath(home, config()), /allowed root/);
  }));

test("uninstall preserves managed blocks subsequently replaced by another checkout", () =>
  fixture((home) => {
    fs.mkdirSync(path.join(home, "Developer"));
    install(home, repoRoot, true);
    const files = [
      path.join(home, ".codex/config.toml"),
      path.join(home, "Developer/AGENTS.md"),
    ];
    const foreign = path.join(home, "other-checkout");
    for (const file of files)
      fs.writeFileSync(
        file,
        fs.readFileSync(file, "utf8").replaceAll(repoRoot, foreign),
      );
    const expected = files.map((file) => fs.readFileSync(file, "utf8"));
    const result = uninstall(home, repoRoot);
    assert.deepEqual(result.skipped, files);
    for (const [i, file] of files.entries())
      assert.equal(fs.readFileSync(file, "utf8"), expected[i]);
  }));

test("read-only Glob denies absolute and traversal patterns without rejecting scoped wildcards", () =>
  fixture((home) => {
    for (const pattern of ["../*", "/tmp/*", "{src,/tmp/*}", "{src,../*}"])
      assert.match(
        toolDecision(home, "read", "Glob", { pattern }) || "",
        /relative/,
      );
    assert.equal(
      toolDecision(home, "read", "Glob", { pattern: "**/*.ts" }),
      undefined,
    );
  }));
