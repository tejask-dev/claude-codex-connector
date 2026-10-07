import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { parse } from "smol-toml";
export const repoRoot = path.resolve(import.meta.dirname, "../..");
export interface Config {
  stateDir: string;
  socket: string;
  roots: string[];
  concurrency: number;
  timeoutMs: number;
  maxTurns: number;
  codexBin: string;
}
export function findExecutable(
  name: string,
  searchPath = process.env.PATH || "",
  home = os.homedir(),
): string | undefined {
  const directories = [
    ...searchPath.split(path.delimiter).filter(Boolean),
    path.join(home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of directories) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}
export function config(): Config {
  const stateDir = path.resolve(
    process.env.AGENT_TEAM_STATE_DIR ||
      path.join(os.homedir(), ".local/share/claude-codex-connector"),
  );
  let saved: Partial<Config> = {};
  const file = path.join(stateDir, "config.json");
  if (fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    roots: [path.join(os.homedir(), "Developer")],
    concurrency: 2,
    timeoutMs: 1_800_000,
    maxTurns: 3,
    codexBin: findExecutable("codex") || "codex",
    ...saved,
    stateDir,
    socket: path.join(stateDir, "control.sock"),
  };
}
export function privateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.()
  )
    throw new Error(`Unsafe state directory: ${dir}`);
  fs.chmodSync(dir, 0o700);
}
export function jsonWrite(file: string, value: unknown) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(tmp, file);
}
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const within = (root: string, file: string) =>
  file === root || file.startsWith(root + path.sep);
export function projectPath(input: string, cfg: Config) {
  const real = fs.realpathSync(input);
  if (
    !fs.statSync(real).isDirectory() ||
    !cfg.roots.some((r) => within(fs.realpathSync(r), real))
  )
    throw new Error("Project must be inside an allowed root");
  if (within(real, cfg.stateDir) || within(cfg.stateDir, real))
    throw new Error("State directory cannot be a project");
  return real;
}
export function defaults() {
  let claude: Record<string, any> = {},
    codex: Record<string, any> = {};
  try {
    claude = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".claude/settings.json"), "utf8"),
    );
  } catch {}
  try {
    codex = parse(
      fs.readFileSync(path.join(os.homedir(), ".codex/config.toml"), "utf8"),
    );
  } catch {}
  return {
    claude: {
      model: claude.model as string | undefined,
      effort: claude.effortLevel as string | undefined,
    },
    codex: {
      model: codex.model as string | undefined,
      effort: codex.model_reasoning_effort as string | undefined,
    },
  };
}
export function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Explicitly keep OS/login paths, not ambient API credentials or provider redirects.
  for (const name of [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])
    if (process.env[name]) env[name] = process.env[name];
  env.AGENT_TEAM_WORKER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}
