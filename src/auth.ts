import fs from "node:fs";
import path from "node:path";
import {
  childEnvironment,
  jsonWrite,
  privateDir,
  type Config,
} from "./config.js";

export function saveClaudeKey(cfg: Config, key: string) {
  key = key.trim();
  if (!key || key.length > 4096 || /\s/.test(key))
    throw new Error("Invalid API key input");
  privateDir(cfg.stateDir);
  jsonWrite(path.join(cfg.stateDir, "credentials.json"), {
    anthropicApiKey: key,
  });
}

export function claudeEnvironment(cfg: Config): NodeJS.ProcessEnv {
  const file = path.join(cfg.stateDir, "credentials.json");
  let key: unknown;
  try {
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 8192
      ) {
        throw new Error(
          "Claude credentials must be an owner-only regular file (chmod 600)",
        );
      }
      try {
        key = JSON.parse(fs.readFileSync(fd, "utf8")).anthropicApiKey;
      } catch {
        throw new Error(
          "Claude credential file is malformed; run agent-team auth claude again",
        );
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  if (typeof key !== "string" || !key || key.length > 4096 || /\s/.test(key)) {
    throw new Error(
      "Claude workers require explicit API authentication. Run agent-team auth claude; API usage is billed separately. No subscription-login fallback is performed.",
    );
  }
  return { ...childEnvironment(), ANTHROPIC_API_KEY: key };
}

export function assertClaudeApiAuth(account: { apiKeySource?: string }) {
  if (account.apiKeySource !== "ANTHROPIC_API_KEY")
    throw new Error(
      "Claude did not select the explicitly configured API key; refusing subscription or helper fallback",
    );
}

export async function enterClaudeKey(cfg: Config, fromStdin: boolean) {
  let key: string;
  if (fromStdin) {
    // Explicit mode for password-manager pipes; never accept keys as argv.
    key = fs.readFileSync(0, "utf8");
  } else {
    if (!process.stdin.isTTY)
      throw new Error(
        "Use an interactive terminal or pass --stdin for a secret-manager pipe",
      );
    process.stderr.write("Anthropic API key (hidden; billed API usage): ");
    key = await new Promise<string>((resolve, reject) => {
      let value = "";
      const wasRaw = process.stdin.isRaw;
      const done = (error?: Error) => {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
        process.stderr.write("\n");
        error ? reject(error) : resolve(value);
      };
      const onData = (buffer: Buffer) => {
        for (const char of buffer.toString("utf8")) {
          if (char === "\r" || char === "\n") return done();
          if (char === "\x03" || char === "\x04")
            return done(new Error("Cancelled"));
          if (char === "\x7f" || char === "\b") value = value.slice(0, -1);
          else value += char;
          if (value.length > 4096)
            return done(new Error("API key input too long"));
        }
      };
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    });
  }
  saveClaudeKey(cfg, key);
  console.log(
    "Claude API credential saved locally with mode 600. No inference request was made.",
  );
}
