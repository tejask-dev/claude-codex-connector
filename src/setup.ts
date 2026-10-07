import fs from "node:fs";
import path from "node:path";
import { config, findExecutable, jsonWrite, privateDir } from "./config.js";

export function configure(args: string[]) {
  const cfg = config();
  const roots: string[] = [];
  let codexBin: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (!value || !["--root", "--codex"].includes(flag))
      throw new Error(
        "Use configure --root /absolute/project-root [--root /another/root] [--codex /absolute/codex]",
      );
    if (!path.isAbsolute(value))
      throw new Error(`${flag} requires an absolute path`);
    if (flag === "--root") {
      const real = fs.realpathSync(value);
      if (!fs.statSync(real).isDirectory())
        throw new Error("Root must be a directory");
      if (real === path.parse(real).root)
        throw new Error(
          "The filesystem root is too broad; select a project directory",
        );
      roots.push(real);
    } else {
      fs.accessSync(value, fs.constants.X_OK);
      if (!fs.statSync(value).isFile())
        throw new Error("Codex must be an executable file");
      codexBin = value;
    }
  }
  if (!roots.length)
    throw new Error(
      "Supply at least one --root to explicitly scope project access",
    );
  codexBin ||= findExecutable("codex");
  if (!codexBin)
    throw new Error(
      "Codex was not found. Install its official CLI or pass --codex /absolute/path",
    );
  privateDir(cfg.stateDir);
  const file = path.join(cfg.stateDir, "config.json");
  const saved = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  jsonWrite(file, { ...saved, roots: [...new Set(roots)], codexBin });
  return {
    configured: true,
    roots,
    codexBin,
    note: "Configuration applies on coordinator restart. Do not stop a coordinator with other active work.",
  };
}
