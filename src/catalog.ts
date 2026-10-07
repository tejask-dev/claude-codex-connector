import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "smol-toml";
import { hash } from "./config.js";
import type { Provider } from "./types.js";
export interface Capability {
  id: string;
  kind: "skill" | "agent";
  name: string;
  description: string;
  provider: Provider | "shared";
  path: string;
  availability: "local_instructions";
}
export function capabilities(
  project?: string,
  home = os.homedir(),
): Capability[] {
  const roots: {
    path: string;
    provider: Capability["provider"];
    kind?: Capability["kind"];
  }[] = [];
  for (const [dir, provider] of [
    [".agents", "shared"],
    [".codex", "codex"],
    [".claude", "claude"],
  ] as const) {
    for (const kind of ["skills", "agents"] as const)
      roots.push({
        path: path.join(home, dir, kind),
        provider,
        kind: kind === "skills" ? "skill" : "agent",
      });
    if (provider !== "shared") {
      const reg = path.join(home, dir, "plugins/installed_plugins.json");
      if (fs.existsSync(reg)) {
        const entries = JSON.parse(fs.readFileSync(reg, "utf8")).plugins || {};
        for (const versions of Object.values(entries) as any[])
          for (const v of versions)
            if (v.installPath) roots.push({ path: v.installPath, provider });
      } else
        roots.push({ path: path.join(home, dir, "plugins/cache"), provider });
    }
  }
  if (project)
    for (const dir of [".claude", ".codex", ".agents"])
      for (const kind of ["skills", "agents"] as const)
        roots.push({
          path: path.join(project, dir, kind),
          provider: dir === ".agents" ? "shared" : (dir.slice(1) as Provider),
          kind: kind === "skills" ? "skill" : "agent",
        });
  const visited = new Set<string>();
  const entries = new Map<string, Capability>();
  function walk(
    dir: string,
    provider: Capability["provider"],
    fixed?: Capability["kind"],
    depth = 0,
  ) {
    if (depth > 12 || !fs.existsSync(dir)) return;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const f of children) {
      if (["node_modules", ".git", "vendor", ".venv"].includes(f.name))
        continue;
      const full = path.join(dir, f.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, provider, fixed, depth + 1);
        continue;
      }
      const kind =
        f.name === "SKILL.md"
          ? "skill"
          : (fixed === "agent" || full.split(path.sep).includes("agents")) &&
              /\.(md|toml)$/.test(f.name)
            ? "agent"
            : undefined;
      if (!kind || stat.size > 256000) continue;
      const body = fs.readFileSync(full, "utf8");
      let toml: Record<string, unknown> | undefined;
      if (f.name.endsWith(".toml"))
        try {
          toml = parse(body);
        } catch {}
      const realFile = fs.realpathSync(full);
      const id = hash(realFile).slice(0, 24);
      const field = (key: string) =>
        (typeof toml?.[key] === "string" ? (toml[key] as string) : undefined) ||
        body
          .match(new RegExp(`^${key}:\\s*["']?(.+?)["']?$`, "m"))?.[1]
          ?.trim();
      entries.set(id, {
        id,
        kind,
        name:
          field("name") ||
          path
            .basename(kind === "skill" ? path.dirname(full) : full)
            .replace(/\.(md|toml)$/, ""),
        description: (
          field("description") ||
          "Local capability instructions; select explicitly for a delegated assignment."
        ).slice(0, 500),
        provider,
        path: realFile,
        availability: "local_instructions",
      });
    }
  }
  for (const root of roots) walk(root.path, root.provider, root.kind);
  return [...entries.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
}
export function selectedCapabilities(ids: string[], project: string) {
  if (!ids.length) return { items: [] as Capability[], text: "" };
  const all = capabilities(project);
  let chars = 0;
  const items = ids.map((id) => {
    const item = all.find((x) => x.id === id);
    if (!item)
      throw new Error(`Unknown capability ${id}; refresh team_catalog`);
    return item;
  });
  const text = items
    .map((item) => {
      const body = fs.readFileSync(item.path, "utf8");
      chars += body.length;
      if (chars > 48000)
        throw new Error(
          "Selected instructions exceed 48,000 characters; choose a narrower set",
        );
      return `CAPABILITY ${item.kind} ${item.name} (${item.provider}), source ${item.path}\n${body}`;
    })
    .join("\n\n");
  return { items, text };
}
