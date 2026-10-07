import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { jsonWrite } from "./config.js";
function identity(pid: number) {
  try {
    return execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "";
  }
}
export function recordProcess(artifacts: string, pid: number) {
  const file = path.join(artifacts, "processes.json");
  const entries: { pid: number; identity: string }[] = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : [];
  entries.push({ pid, identity: identity(pid) });
  jsonWrite(file, entries);
}
export function recoverProcesses(artifacts: string) {
  const file = path.join(artifacts, "processes.json");
  if (!fs.existsSync(file)) return;
  const entries: { pid: number; identity: string }[] = JSON.parse(
    fs.readFileSync(file, "utf8"),
  );
  for (const entry of entries) {
    if (!entry.identity || identity(entry.pid) !== entry.identity) continue;
    try {
      process.kill(-entry.pid, "SIGTERM");
    } catch {}
    const timer = setTimeout(() => {
      if (identity(entry.pid) === entry.identity)
        try {
          process.kill(-entry.pid, "SIGKILL");
        } catch {}
    }, 1500);
    timer.unref();
  }
}
