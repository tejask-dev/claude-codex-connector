import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { PassThrough, Writable } from "node:stream";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { repoRoot } from "../src/config.js";

test("Desktop launcher transports discovery, initialization and tools over virtual streams, then stops on EOF", async () => {
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const fake = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    env: {
      ...process.env,
      AGENT_TEAM_NODE: process.execPath,
      AGENT_TEAM_ENTRY: path.join(repoRoot, "dist/src/mcp.js"),
    },
    exit: (_code: number) => {},
  });
  let complete!: (code: number) => void;
  const closed = new Promise<number>((r) => {
    complete = r;
  });
  fake.exit = complete;
  const messages: any[] = [];
  let buffer = "";
  stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const code = fs.readFileSync(
    path.join(repoRoot, "scripts/desktop-launcher.cjs"),
    "utf8",
  );
  vm.runInNewContext(code, {
    require: createRequire(import.meta.url),
    process: fake,
    console,
    setTimeout,
    clearTimeout,
  });
  const send = (message: any) => stdin.write(JSON.stringify(message) + "\n");
  async function response(id: number) {
    for (let i = 0; i < 100; i++) {
      const m = messages.find((m) => m.id === id);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Missing Desktop frame ${id}`);
  }
  try {
    send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    assert.equal((await response(1)).error.code, -32601);
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "desktop-virtual-stream-test", version: "1" },
      },
    });
    assert.equal((await response(2)).result.serverInfo.name, "agent-team");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    assert.ok(
      (await response(3)).result.tools.some(
        (t: any) => t.name === "team_delegate",
      ),
    );
    stdin.end();
    assert.equal(
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          const t = setTimeout(
            () => reject(new Error("Launcher did not stop after EOF")),
            2500,
          );
          t.unref();
        }),
      ]),
      0,
    );
  } finally {
    fake.emit("SIGTERM");
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  }
});

function fixtureLauncher(
  source: string,
  options: {
    slowStderr?: boolean;
    missingNode?: boolean;
    holdStdout?: boolean;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-launcher-"));
  const entry = path.join(dir, "fixture.cjs");
  fs.writeFileSync(entry, source);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "",
    diagnostics = "";
  if (!options.holdStdout)
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      const deliver = () => {
        diagnostics += chunk.toString();
        callback();
      };
      if (options.slowStderr) setTimeout(deliver, 40);
      else deliver();
    },
  });
  let child!: ChildProcess;
  let exit!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    exit = resolve;
  });
  const fake = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    env: {
      ...process.env,
      AGENT_TEAM_NODE: options.missingNode
        ? path.join(dir, "missing-node")
        : process.execPath,
      AGENT_TEAM_ENTRY: entry,
    },
    exit,
  });
  vm.runInNewContext(
    fs.readFileSync(
      path.join(repoRoot, "scripts/desktop-launcher.cjs"),
      "utf8",
    ),
    {
      process: fake,
      setTimeout,
      clearTimeout,
      require: (id: string) => {
        assert.equal(id, "node:child_process");
        return {
          spawn: (...args: Parameters<typeof spawn>) => {
            child = spawn(...args);
            return child;
          },
        };
      },
    },
  );
  return {
    fake,
    child,
    done,
    output: () => output,
    diagnostics: () => diagnostics,
    async result() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          done,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Launcher shutdown timed out")),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    cleanup() {
      child.kill("SIGKILL");
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Desktop launcher flushes delayed stderr and preserves nonzero exit status", async () => {
  const f = fixtureLauncher(
    "process.stdout.write('final-frame\\n'); process.stderr.write('final-diagnostic\\n'); process.exitCode = 7;",
    { slowStderr: true },
  );
  try {
    assert.equal(await f.result(), 7);
    assert.equal(f.output(), "final-frame\n");
    assert.equal(f.diagnostics(), "final-diagnostic\n");
  } finally {
    f.cleanup();
  }
});

test("Desktop launcher reports spawn failures and exits while host stdin stays open", async () => {
  const f = fixtureLauncher("", { missingNode: true });
  try {
    assert.equal(await f.result(), 1);
    assert.match(f.diagnostics(), /ENOENT/);
    assert.equal(f.output(), "");
  } finally {
    f.cleanup();
  }
});

for (const stream of ["stdin", "stdout", "stderr"] as const) {
  test(`Desktop launcher stops its child on a virtual ${stream} failure`, async () => {
    const f = fixtureLauncher("setInterval(() => {}, 1000);");
    try {
      f.fake[stream].destroy(new Error(`broken ${stream}`));
      assert.equal(await f.result(), 1);
      assert.ok(f.child.signalCode || f.child.exitCode !== null);
      assert.equal(f.output(), "");
    } finally {
      f.cleanup();
    }
  });
}

test("Desktop launcher forwards host termination and waits for child shutdown", async () => {
  const f = fixtureLauncher("setInterval(() => {}, 1000);");
  try {
    f.fake.emit("SIGTERM");
    assert.equal(await f.result(), 1);
    assert.equal(f.child.signalCode, "SIGTERM");
  } finally {
    f.cleanup();
  }
});

test("Desktop launcher exits after a backpressured destination fails and the child ignores SIGTERM", async () => {
  const f = fixtureLauncher(
    `
    process.on('SIGTERM', () => {});
    const chunk = Buffer.alloc(65536, 'x');
    function write() { while (process.stdout.write(chunk)) {} process.stdout.once('drain', write); }
    write();
    setInterval(() => {}, 1000);
  `,
    { holdStdout: true },
  );
  try {
    for (let i = 0; !f.fake.stdout.writableNeedDrain && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.fake.stdout.writableNeedDrain, true);
    f.fake.stdout.destroy(new Error("destination failed under backpressure"));
    assert.equal(await f.result(), 1);
    assert.equal(f.child.signalCode, "SIGKILL");
  } finally {
    f.cleanup();
  }
});
