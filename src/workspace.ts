import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config, hash, jsonWrite, privateDir, within } from "./config.js";
export interface Entry {
  hash: string;
  mode: number;
  type: "file" | "link";
  link?: string;
}
export interface Snapshot {
  project: string;
  workspace: string;
  git: boolean;
  files: Record<string, Entry>;
}
const excluded = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".DS_Store",
]);
function git(root: string, args: string[]) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-C", root, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    },
  );
}
export function gitRoot(root: string): string | undefined {
  try {
    return fs.realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim());
  } catch {
    return undefined;
  }
}
function names(root: string, useGit: boolean): string[] {
  if (useGit) {
    if (
      git(root, ["ls-files", "--stage"])
        .split("\n")
        .some((l) => l.startsWith("160000 "))
    )
      throw new Error(
        "Submodules need an explicit prepared workspace; automatic snapshots are unsupported",
      );
    return [
      ...new Set(
        git(root, [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        ])
          .split("\0")
          .filter(Boolean),
      ),
    ];
  }
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      if (excluded.has(f.name) || sensitiveFilename(f.name)) continue;
      const rel = path.join(dir, f.name);
      if (f.isDirectory()) walk(rel);
      else result.push(rel);
      if (result.length > 10000)
        throw new Error(
          "Snapshot exceeds 10,000 files; select a narrower project",
        );
    }
  };
  walk("");
  return result;
}
export function safePath(root: string, rel: string) {
  const full = path.resolve(root, rel);
  if (
    !within(root, full) ||
    full === root ||
    rel.split(path.sep).includes(".git")
  )
    throw new Error(`Unsafe file path: ${rel}`);
  let parent = path.dirname(full);
  while (parent !== root) {
    if (fs.existsSync(parent) && !within(root, fs.realpathSync(parent)))
      throw new Error(`Symlink escapes workspace: ${rel}`);
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink())
      throw new Error(`Symlink parent cannot be integrated: ${rel}`);
    parent = path.dirname(parent);
  }
  return full;
}
function entry(root: string, rel: string): Entry | undefined {
  const full = safePath(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch (e: any) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(full);
    if (
      path.isAbsolute(link) ||
      !within(root, path.resolve(path.dirname(full), link))
    )
      throw new Error(`External symlink requires explicit handling: ${rel}`);
    // Reject indirect escapes and broken links too.
    if (!within(root, fs.realpathSync(full)))
      throw new Error(`External symlink: ${rel}`);
    return { type: "link", link, mode: 0o777, hash: hash(link) };
  }
  if (!stat.isFile()) throw new Error(`Unsupported file type: ${rel}`);
  if (stat.size > 32 * 1024 * 1024)
    throw new Error(`File exceeds snapshot limit (32 MiB): ${rel}`);
  return {
    type: "file",
    mode: stat.mode & 0o777,
    hash: hash(fs.readFileSync(full)),
  };
}
export function manifest(root: string, useGit = gitRoot(root) === root) {
  const result: Record<string, Entry> = {};
  let total = 0;
  const list = names(root, useGit);
  if (list.length > 10000) throw new Error("Snapshot exceeds 10,000 files");
  for (const rel of list) {
    const e = entry(root, rel);
    if (!e) continue;
    total += fs.lstatSync(path.join(root, rel)).size;
    if (total > 512 * 1024 * 1024) throw new Error("Snapshot exceeds 512 MiB");
    result[rel] = e;
  }
  return result;
}
const equal = (a?: Entry, b?: Entry) => JSON.stringify(a) === JSON.stringify(b);
function copyEntry(from: string, to: string, rel: string, e: Entry) {
  const dest = safePath(to, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (
    fs.existsSync(dest) ||
    (() => {
      try {
        return fs.lstatSync(dest).isSymbolicLink();
      } catch {
        return false;
      }
    })()
  ) {
    if (fs.lstatSync(dest).isDirectory())
      throw new Error(`Directory/file conflict: ${rel}`);
    fs.unlinkSync(dest);
  }
  if (e.type === "link") fs.symlinkSync(e.link!, dest);
  else {
    fs.copyFileSync(safePath(from, rel), dest);
    fs.chmodSync(dest, e.mode);
  }
}
export function createSnapshot(
  project: string,
  dir: string,
): { workspace: string; baselinePath: string } {
  project = fs.realpathSync(project);
  privateDir(dir);
  dir = fs.realpathSync(dir);
  const workspace = path.join(dir, "workspace");
  const root = gitRoot(project);
  const useGit = root === project;
  const files = manifest(project, useGit);
  let worktree = false;
  try {
    if (useGit) {
      git(project, ["worktree", "add", "--detach", workspace, "HEAD"]);
      worktree = true;
    } else privateDir(workspace);
    // Remove tracked files deleted in the source without touching its index.
    for (const rel of names(workspace, useGit))
      if (!files[rel]) {
        const f = safePath(workspace, rel);
        if (fs.existsSync(f) && !fs.lstatSync(f).isDirectory())
          fs.unlinkSync(f);
      }
    // Files first, symlinks second so their targets exist.
    for (const [rel, e] of Object.entries(files).sort(
      (a, b) => Number(a[1].type === "link") - Number(b[1].type === "link"),
    ))
      copyEntry(project, workspace, rel, e);
    const after = manifest(project, useGit);
    if (JSON.stringify(files) !== JSON.stringify(after))
      throw new Error(
        "Project changed during snapshot; retry with a new request ID",
      );
    const baselinePath = path.join(dir, "baseline.json");
    jsonWrite(baselinePath, {
      project,
      workspace,
      git: useGit,
      files,
    } satisfies Snapshot);
    return { workspace, baselinePath };
  } catch (e) {
    if (worktree)
      try {
        git(project, ["worktree", "remove", "--force", workspace]);
      } catch {}
    else fs.rmSync(workspace, { recursive: true, force: true });
    throw e;
  }
}
export function changes(baselinePath: string) {
  const baseline: Snapshot = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const current = manifest(baseline.workspace, baseline.git);
  const paths = [
    ...new Set([...Object.keys(baseline.files), ...Object.keys(current)]),
  ]
    .sort()
    .filter((p) => !equal(baseline.files[p], current[p]));
  return {
    baseline,
    current,
    paths,
    changes: paths.map((p) => ({
      path: p,
      action: !current[p] ? "delete" : !baseline.files[p] ? "add" : "modify",
    })),
  };
}
export function integrate(baselinePath: string) {
  const { baseline, current, paths, changes: summary } = changes(baselinePath);
  const backup = path.join(path.dirname(baselinePath), "integration-backup");
  const journalFile = path.join(backup, "journal.json");
  if (fs.existsSync(journalFile)) {
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    if (journal.status !== "rolled_back") {
      if (!journal.expected)
        throw new Error(
          "Legacy integration journal requires manual inspection",
        );
      // Reconcile a finished file application whose SQLite receipt was lost. Do
      // not replay edits, and do not accept a subsequently modified source.
      if (
        journal.paths.every((p: string) =>
          equal(entry(baseline.project, p), journal.expected[p]),
        )
      ) {
        jsonWrite(journalFile, { ...journal, status: "applied" });
        return journal.summary;
      }
      throw new Error(
        "Uncertain integration or source drift. Inspect the journal and use rollback_integration before retrying.",
      );
    }
  } else if (fs.existsSync(backup))
    throw new Error(
      "Incomplete integration backup; inspect it before retrying",
    );
  const conflicts = paths.filter(
    (p) => !equal(entry(baseline.project, p), baseline.files[p]),
  );
  if (conflicts.length)
    throw new Error(
      `Source changed since snapshot; integration refused: ${conflicts.join(", ")}`,
    );
  // Durable backups permit guarded recovery after a process crash. Never stage the user's index.
  privateDir(backup);
  const journal = {
    status: "prepared",
    paths,
    baselinePath,
    expected: current,
    summary,
  };
  jsonWrite(journalFile, journal);
  for (const p of paths)
    if (baseline.files[p])
      copyEntry(baseline.project, backup, p, baseline.files[p]);
  jsonWrite(journalFile, { ...journal, status: "applying" });
  const applied: string[] = [];
  try {
    for (const p of paths) {
      if (!equal(entry(baseline.project, p), baseline.files[p]))
        throw new Error(`Source changed during integration: ${p}`);
      // Recheck output too: a completed worker's files may have been edited manually.
      if (!equal(entry(baseline.workspace, p), current[p]))
        throw new Error(`Worker output changed during integration: ${p}`);
      applied.push(p);
      if (current[p])
        copyEntry(baseline.workspace, baseline.project, p, current[p]);
      else fs.unlinkSync(safePath(baseline.project, p));
    }
    jsonWrite(journalFile, { ...journal, status: "applied" });
  } catch (e) {
    for (const p of applied.reverse()) {
      if (baseline.files[p])
        copyEntry(backup, baseline.project, p, baseline.files[p]);
      else fs.rmSync(safePath(baseline.project, p), { force: true });
    }
    jsonWrite(journalFile, { ...journal, status: "rolled_back" });
    throw e;
  }
  return summary;
}
export function rollbackIntegration(baselinePath: string) {
  const baseline: Snapshot = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const backup = path.join(path.dirname(baselinePath), "integration-backup"),
    file = path.join(backup, "journal.json");
  const journal = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!journal.expected)
    throw new Error("Legacy integration journal requires manual inspection");
  for (const p of journal.paths) {
    const actual = entry(baseline.project, p);
    if (
      !equal(actual, baseline.files[p]) &&
      !equal(actual, journal.expected[p])
    )
      throw new Error(
        `Source changed after uncertain integration; rollback refused: ${p}`,
      );
  }
  for (const p of journal.paths) {
    if (equal(entry(baseline.project, p), baseline.files[p])) continue;
    if (!equal(entry(baseline.project, p), journal.expected[p]))
      throw new Error(`Source changed during rollback: ${p}`);
    if (baseline.files[p]) {
      // Validate regular backup bytes before restoring. Links are stored as
      // their literal target since that target may not be among changed files.
      const saved = baseline.files[p];
      const source = safePath(backup, p);
      if (
        saved.type === "file"
          ? hash(fs.readFileSync(source)) !== saved.hash
          : fs.readlinkSync(source) !== saved.link
      )
        throw new Error(`Integration backup changed: ${p}`);
      copyEntry(backup, baseline.project, p, saved);
    } else fs.rmSync(safePath(baseline.project, p), { force: true });
  }
  jsonWrite(file, { ...journal, status: "rolled_back" });
  return { rolledBack: journal.paths };
}
export function sensitiveFilename(name: string) {
  return (
    (name.startsWith(".env") &&
      ![".env.example", ".env.sample", ".env.template"].includes(name)) ||
    /^(credentials\.json|id_rsa|id_ed25519)$/i.test(name) ||
    /\.(pem|key|p12|pfx)$/i.test(name)
  );
}
export function projectInstructions(project: string, roots = config().roots) {
  project = fs.realpathSync(project);
  const allowed = roots
    .flatMap((root) => {
      try {
        return [fs.realpathSync(root)];
      } catch {
        return [];
      }
    })
    .filter((root) => within(root, project))
    .sort((a, b) => b.length - a.length);
  // Never inherit private home/system instructions above the configured grant.
  const boundary = allowed[0] || project;
  const dirs: string[] = [];
  let dir = project;
  while (within(boundary, dir)) {
    dirs.unshift(dir);
    if (dir === boundary) break;
    dir = path.dirname(dir);
  }
  const chunks: string[] = [];
  let count = 0;
  for (const d of dirs)
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const f = path.join(d, name);
      if (!fs.existsSync(f)) continue;
      if (!within(boundary, fs.realpathSync(f)))
        throw new Error("Instruction symlink escapes the configured root");
      if (!fs.statSync(f).isFile() || fs.statSync(f).size + count > 96000)
        throw new Error(
          "Project instructions exceed the 96,000 byte limit or are not regular files",
        );
      const text = fs.readFileSync(f, "utf8");
      count += text.length;
      if (count > 96000)
        throw new Error(
          "Ancestor instructions exceed 96,000 characters; select a scoped instruction handoff",
        );
      chunks.push(`SOURCE ${path.relative(boundary, f)}\n${text}`);
    }
  return chunks.join("\n\n");
}
