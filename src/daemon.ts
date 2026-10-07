import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { config, privateDir, jsonWrite } from "./config.js";
import { Coordinator } from "./coordinator.js";
import { CodexAdapter } from "./providers/codex.js";
import { ClaudeAdapter } from "./providers/claude.js";
import { z } from "zod";
import { acquireDaemonLock } from "./daemon-lock.js";
import type { Operation } from "./api.js";
process.umask(0o077);
const cfg = config();
privateDir(cfg.stateDir);
const lease = acquireDaemonLock(cfg.stateDir);
if (!lease) process.exit(0);
const lock = path.join(cfg.stateDir, "daemon.lock");
const nonce = randomUUID();
fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
jsonWrite(path.join(lock, "owner.json"), { pid: process.pid, nonce });
if (fs.existsSync(cfg.socket)) {
  if (!fs.lstatSync(cfg.socket).isSocket())
    throw new Error("Refusing to replace non-socket control path");
  fs.unlinkSync(cfg.socket);
}
const coordinator = new Coordinator(cfg, {
  codex: new CodexAdapter(cfg),
  claude: new ClaudeAdapter(cfg),
});
const sockets = new Set<net.Socket>();
const envelope = z
  .object({
    op: z.string(),
    input: z.unknown(),
    actor: z
      .object({
        provider: z.enum(["codex", "claude"]),
        managerToken: z.string().optional(),
        workerToken: z.string().optional(),
      })
      .strict(),
  })
  .strict();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => socket.destroy());
  socket.setEncoding("utf8");
  socket.setTimeout(65000, () => socket.destroy());
  let buffer = "",
    handled = false;
  socket.on("data", async (chunk) => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 128 * 1024) return socket.destroy();
    const i = buffer.indexOf("\n");
    if (i < 0) return;
    handled = true;
    try {
      const { op, input, actor } = envelope.parse(
        JSON.parse(buffer.slice(0, i)),
      );
      const result =
        op === "ping"
          ? {
              version: "0.2.0",
              distribution: "claude-codex-connector",
              pid: process.pid,
            }
          : await coordinator.execute(op as Operation, input, actor);
      socket.end(JSON.stringify({ result }) + "\n");
    } catch (e) {
      socket.end(
        JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) +
          "\n",
      );
    }
  });
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await coordinator.close();
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
  try {
    const owner = JSON.parse(
      fs.readFileSync(path.join(lock, "owner.json"), "utf8"),
    );
    if (owner.nonce === nonce) fs.rmSync(lock, { recursive: true });
  } catch {}
  lease!.close();
  process.exit(0);
}
server.on("error", (e) => {
  console.error(e);
  void shutdown();
});
server.listen(cfg.socket, () => {
  fs.chmodSync(cfg.socket, 0o600);
  console.error(`Agent Team Bridge listening ${cfg.socket}`);
});
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
