import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, privateDir, type Config } from "./config.js";
import type { Actor } from "./types.js";
import type { Operation } from "./api.js";
export function rpc(
  cfg: Config,
  op: Operation | "ping",
  input: unknown,
  actor: Actor,
): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = "",
      settled = false;
    const socket = net.createConnection(cfg.socket);
    const timer = setTimeout(
      () =>
        done(
          new Error(
            "Bridge transport timed out; retry mutations with the same requestId",
          ),
        ),
      60000,
    );
    function done(error?: Error, result?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    }
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(JSON.stringify({ op, input, actor }) + "\n"),
    );
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024)
        return done(new Error("Bridge response exceeds limit"));
      const i = buffer.indexOf("\n");
      if (i < 0) return;
      try {
        const msg = JSON.parse(buffer.slice(0, i));
        msg.error ? done(new Error(msg.error)) : done(undefined, msg.result);
      } catch (e) {
        done(e as Error);
      }
    });
    socket.on("error", (e) => done(e));
    socket.on("end", () => {
      if (!settled)
        done(
          new Error(
            "Bridge connection closed before receipt; retry with the same requestId",
          ),
        );
    });
  });
}
export async function ensureDaemon(cfg = config()) {
  privateDir(cfg.stateDir);
  try {
    assertDistribution(await rpc(cfg, "ping", {}, { provider: "codex" }));
    return;
  } catch (e: any) {
    if (!["ENOENT", "ECONNREFUSED"].includes(e.code)) throw e;
  }
  const log = fs.openSync(path.join(cfg.stateDir, "daemon.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "daemon.js")],
    {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, AGENT_TEAM_STATE_DIR: cfg.stateDir },
    },
  );
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      assertDistribution(await rpc(cfg, "ping", {}, { provider: "codex" }));
      return;
    } catch (e: any) {
      if (!["ENOENT", "ECONNREFUSED"].includes(e.code)) throw e;
    }
  }
  throw new Error(
    `Coordinator did not start. Inspect ${path.join(cfg.stateDir, "daemon.log")}`,
  );
}
export function assertDistribution(receipt: { distribution?: string }) {
  if (receipt.distribution !== "claude-codex-connector")
    throw new Error(
      "This state directory belongs to another bridge distribution; configure a separate AGENT_TEAM_STATE_DIR",
    );
}
export async function call(
  op: Operation,
  input: unknown,
  actor: Actor,
  cfg = config(),
) {
  if (
    process.env.AGENT_TEAM_WORKER === "1" &&
    !process.env.AGENT_TEAM_MANAGED_TASK &&
    op !== "question"
  )
    throw new Error("Workers cannot recursively invoke the bridge");
  await ensureDaemon(cfg);
  return rpc(cfg, op, input, actor);
}
