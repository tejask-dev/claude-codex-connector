import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parse } from "smol-toml";
import { config, jsonWrite, privateDir, repoRoot, hash } from "./config.js";
const begin = "<!-- agent-team-bridge:start -->",
  end = "<!-- agent-team-bridge:end -->";
const tomlBegin = "# agent-team-bridge:start",
  tomlEnd = "# agent-team-bridge:end";
export function replaceBlock(
  text: string,
  body: string,
  first = begin,
  last = end,
) {
  if (text.split(first).length > 2 || text.split(last).length > 2)
    throw new Error(
      "Duplicate managed configuration blocks; reconcile them before installation",
    );
  const start = text.indexOf(first),
    stop = text.indexOf(last);
  if (start < 0 !== stop < 0 || (start >= 0 && stop < start))
    throw new Error("Malformed managed configuration block");
  if (start >= 0)
    return (
      text.slice(0, start) +
      body +
      text.slice(stop + last.length).replace(/^\n/, "")
    );
  return text + (text.endsWith("\n") ? "" : "\n") + body;
}
function updateText(file: string, body: string, first = begin, last = end) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const next = replaceBlock(existing, body, first, last);
  if (next === existing) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeCompared(file, next, existing);
}
function present(file: string) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (e: any) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
function writeCompared(file: string, next: string, expected: string) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, next, {
    mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600,
    flag: "wx",
  });
  try {
    if ((fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "") !== expected)
      throw new Error(
        `Configuration changed during installation: ${file}; retry after the other writer stops`,
      );
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function install(
  home = os.homedir(),
  root = repoRoot,
  teamwork = false,
) {
  const cfg = config();
  privateDir(cfg.stateDir);
  const backup = path.join(cfg.stateDir, "install-backups");
  privateDir(backup);
  const roots =
    home === os.homedir() ? cfg.roots : [path.join(home, "Developer")];
  for (const dir of roots) {
    if (
      !path.isAbsolute(dir) ||
      !fs.existsSync(dir) ||
      !fs.statSync(dir).isDirectory()
    )
      throw new Error(
        "Configure existing absolute project roots before installing",
      );
  }
  const receiptFile = path.join(cfg.stateDir, "installation.json");
  const previous = fs.existsSync(receiptFile)
    ? JSON.parse(fs.readFileSync(receiptFile, "utf8"))
    : {};
  if (previous.root && previous.root !== root)
    throw new Error(
      "Another checkout owns this installation; uninstall it first",
    );
  const routingFiles = teamwork
    ? [
        ...roots.flatMap((dir) => [
          path.join(dir, "AGENTS.md"),
          path.join(dir, "CLAUDE.md"),
        ]),
        path.join(home, ".codex/AGENTS.md"),
      ]
    : previous.routingFiles || [];
  const files = [
    ...new Set([
      path.join(home, ".codex/config.toml"),
      path.join(home, ".claude.json"),
      ...routingFiles,
      ...(teamwork ? previous.routingFiles || [] : []),
    ]),
  ];
  // Preflight everything before changing any configuration.
  const codexFile = files[0];
  const existing = fs.existsSync(codexFile)
    ? fs.readFileSync(codexFile, "utf8")
    : "";
  const parsed: any = existing ? parse(existing) : {};
  const entry = path.join(root, "dist/src/mcp.js");
  if (
    parsed.mcp_servers?.["agent-team"] &&
    (!existing.includes(tomlBegin) ||
      !parsed.mcp_servers["agent-team"].args?.includes(entry))
  )
    throw new Error("An unrelated agent-team Codex entry already exists");
  const claudeFile = files[1];
  const claudeText = fs.existsSync(claudeFile)
    ? fs.readFileSync(claudeFile, "utf8")
    : "";
  const claude: any = claudeText ? JSON.parse(claudeText) : {};
  if (
    claude.mcpServers?.["agent-team"] &&
    !claude.mcpServers["agent-team"].args?.includes(entry)
  )
    throw new Error("An unrelated agent-team Claude entry already exists");
  const link = path.join(home, ".local/bin/agent-team");
  if (
    present(link) &&
    (!fs.lstatSync(link).isSymbolicLink() ||
      fs.readlinkSync(link) !== path.join(root, "dist/src/cli.js"))
  )
    throw new Error(
      "agent-team command already exists and is not owned by this install",
    );
  for (const provider of [".claude", ".codex"]) {
    const f = path.join(home, provider, "skills/local-agent-team/SKILL.md");
    if (
      present(f) &&
      (!fs.lstatSync(f).isSymbolicLink() ||
        fs.readlinkSync(f) !== path.join(root, "skills/teamwork/SKILL.md"))
    )
      throw new Error(`Unrelated skill exists: ${f}`);
  }
  for (const file of files.slice(2))
    if (fs.existsSync(file)) replaceBlock(fs.readFileSync(file, "utf8"), "");
  for (const file of files)
    if (fs.existsSync(file)) {
      const dest = path.join(backup, hash(file) + ".original");
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(file, dest);
        fs.chmodSync(dest, 0o600);
      }
    }
  const block = `${tomlBegin}\n[mcp_servers.agent-team]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([entry, "--origin", "codex"])}\ntool_timeout_sec = 60\n[mcp_servers.agent-team.env]\nAGENT_TEAM_STATE_DIR = ${JSON.stringify(cfg.stateDir)}\n${tomlEnd}\n`;
  // Parse candidate before writing; preserve all unrelated TOML text/comments.
  parse(replaceBlock(existing, block, tomlBegin, tomlEnd));
  updateText(codexFile, block, tomlBegin, tomlEnd);
  claude.mcpServers ||= {};
  claude.mcpServers["agent-team"] = {
    type: "stdio",
    command: process.execPath,
    args: [entry, "--origin", "claude"],
    env: { AGENT_TEAM_STATE_DIR: cfg.stateDir },
  };
  writeCompared(claudeFile, JSON.stringify(claude, null, 2) + "\n", claudeText);
  const instruction = `${begin}\n## Local Claude-Codex teamwork\nFor substantial development in ${roots.join(", ")} or their descendants, use the local agent-team MCP tools and the local-agent-team skill before reporting completion. Changes spanning implementation plus tests or API documentation count as substantial, including small fixtures. The foreground agent must start one bridge task and obtain one scoped assignment or review by the other provider; use the installed agent-team CLI if MCP discovery is unavailable. Retain the task ID and record peer evidence with team_finish. Search the shared catalog for relevant skills/profiles; load only selected capabilities. Use isolated edit workers, inspect results, integrate with drift checks, and verify locally before finishing. Trivial questions, status checks, formatting, and single-line edits need no peer call. Delegated workers must not delegate recursively. Existing project-specific protocols and user authorization boundaries still apply. Read and follow applicable project instructions before starting work. Do not claim teamwork when the connector is unavailable; report the limitation. This rule does not apply outside those configured roots.\nSkill: ${path.join(root, "skills/teamwork/SKILL.md")}\n${end}\n`;
  if (teamwork) {
    for (const file of previous.routingFiles || []) {
      if (!routingFiles.includes(file) && fs.existsSync(file))
        updateText(file, "");
    }
    for (const file of routingFiles) updateText(file, instruction);
  }
  for (const provider of [".claude", ".codex"]) {
    const dir = path.join(home, provider, "skills/local-agent-team");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    const source = path.join(root, "skills/teamwork/SKILL.md");
    if (present(file)) {
      if (
        !fs.lstatSync(file).isSymbolicLink() ||
        fs.readlinkSync(file) !== source
      )
        throw new Error(`Unrelated skill exists: ${file}`);
    } else fs.symlinkSync(source, file);
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.chmodSync(path.join(root, "dist/src/cli.js"), 0o755);
  if (!present(link)) fs.symlinkSync(path.join(root, "dist/src/cli.js"), link);
  jsonWrite(path.join(cfg.stateDir, "installation.json"), {
    version: JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ).version,
    root,
    node: process.execPath,
    files,
    routingFiles,
    installedAt: new Date().toISOString(),
  });
  return {
    installed: files,
    command: link,
    desktopBundle: path.join(root, "build/agent-team-bridge.mcpb"),
    note: "Restart/reload Codex and Claude Code to discover tools. Install the MCPB extension in Claude Desktop once.",
  };
}
export function uninstall(home = os.homedir(), root = repoRoot) {
  const receiptFile = path.join(config().stateDir, "installation.json");
  const receipt = fs.existsSync(receiptFile)
    ? JSON.parse(fs.readFileSync(receiptFile, "utf8"))
    : {};
  if (!receipt.root)
    return {
      uninstalled: false,
      preserved:
        "No installation receipt for this state directory; client configuration left untouched.",
    };
  if (receipt.root && receipt.root !== root)
    throw new Error("Another checkout owns this installation");
  for (const [file, first, last] of [
    [path.join(home, ".codex/config.toml"), tomlBegin, tomlEnd],
    ...(receipt.routingFiles || []).map((file: string) => [file, begin, end]),
  ])
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      if (text.includes(first))
        writeCompared(file, replaceBlock(text, "", first, last), text);
    }
  const file = path.join(home, ".claude.json");
  if (fs.existsSync(file)) {
    const original = fs.readFileSync(file, "utf8");
    const data = JSON.parse(original);
    if (
      data.mcpServers?.["agent-team"]?.args?.includes(
        path.join(root, "dist/src/mcp.js"),
      )
    ) {
      delete data.mcpServers["agent-team"];
      writeCompared(file, JSON.stringify(data, null, 2) + "\n", original);
    }
  }
  for (const file of [
    path.join(home, ".local/bin/agent-team"),
    ...[".claude", ".codex"].map((p) =>
      path.join(home, p, "skills/local-agent-team/SKILL.md"),
    ),
  ])
    if (
      present(file) &&
      fs.lstatSync(file).isSymbolicLink() &&
      fs.readlinkSync(file).startsWith(root + path.sep)
    )
      fs.unlinkSync(file);
  if (receipt.root === root) fs.rmSync(receiptFile);
  return {
    uninstalled: true,
    preserved:
      "Task records, snapshots, transcripts, and unrelated configuration. Remove the Desktop extension in its settings.",
  };
}
export async function pack(root = repoRoot) {
  const { default: Ajv } = await import("ajv");
  const bundle = path.join(root, "build/desktop");
  fs.mkdirSync(bundle, { recursive: true });
  const manifest = {
    manifest_version: "0.3",
    name: "agent-team-bridge",
    display_name: "Local Claude–Codex Team",
    version: JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ).version,
    description:
      "Manage local Codex and Claude coding workers, skills, profiles, and supported session history.",
    author: { name: "Local Agent Team Bridge" },
    server: {
      type: "node",
      entry_point: "server.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server.js"],
        env: {
          AGENT_TEAM_NODE: "${user_config.node_path}",
          AGENT_TEAM_ENTRY: "${user_config.bridge_entry}",
          AGENT_TEAM_STATE_DIR: config().stateDir,
        },
      },
    },
    user_config: {
      node_path: {
        type: "file",
        title: "Node.js 24",
        description: "Absolute path to the installed Node.js 24 runtime.",
        required: false,
        default: process.execPath,
      },
      bridge_entry: {
        type: "file",
        title: "Bridge MCP entry",
        description:
          "Keep the bridge repository at this path after installation.",
        required: false,
        default: path.join(root, "dist/src/mcp.js"),
      },
    },
  };
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(root, "scripts/mcpb-manifest.schema.json"),
      "utf8",
    ),
  );
  const validate = new (Ajv as any)({
    strict: false,
    validateFormats: false,
  }).compile(schema);
  if (!validate(manifest)) throw new Error(JSON.stringify(validate.errors));
  jsonWrite(path.join(bundle, "manifest.json"), manifest);
  fs.copyFileSync(
    path.join(root, "scripts/desktop-launcher.cjs"),
    path.join(bundle, "server.js"),
  );
  const output = path.join(root, "build/agent-team-bridge.mcpb");
  fs.rmSync(output, { force: true });
  execFileSync("/usr/bin/zip", ["-q", output, "manifest.json", "server.js"], {
    cwd: bundle,
  });
  return { output, manifestValidated: true };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const action = process.argv[2];
  console.log(
    JSON.stringify(
      action === "install"
        ? install(os.homedir(), repoRoot, process.argv.includes("--teamwork"))
        : action === "uninstall"
          ? uninstall()
          : action === "pack"
            ? await pack()
            : { error: "Use install, uninstall, or pack" },
      null,
      2,
    ),
  );
}
