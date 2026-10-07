import {
  listSessions,
  getSessionInfo,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { CodexAdapter } from "./providers/codex.js";
import type { Config } from "./config.js";
import type { Provider } from "./types.js";
export async function sessionList(
  cfg: Config,
  provider: Provider,
  cursor?: string,
  query?: string,
  project?: string,
) {
  if (provider === "claude") {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid Claude session cursor");
    const sessions = await listSessions({ dir: project, limit: 30, offset });
    return {
      provider,
      sessions: sessions
        .filter(
          (s) =>
            !query || s.summary.toLowerCase().includes(query.toLowerCase()),
        )
        .map((s) => ({
          id: s.sessionId,
          title: s.customTitle || s.summary,
          project: s.cwd,
          updatedAt: s.lastModified,
        })),
      nextCursor: sessions.length === 30 ? String(offset + 30) : null,
      scope:
        "Local Claude Code session history. Ordinary Claude Desktop chat history is not exposed by this API.",
    };
  }
  const rpc = new CodexAdapter(cfg).open(cfg.stateDir);
  try {
    await rpc.initialize();
    const result = await rpc.request("thread/list", {
      limit: 30,
      cursor,
      searchTerm: query,
      cwd: project,
      sourceKinds: [],
      useStateDbOnly: true,
    });
    return {
      provider,
      sessions: result.data.map((s: any) => ({
        id: s.id,
        title: s.name || s.preview,
        project: s.cwd,
        updatedAt: s.updatedAt,
        status: s.status,
      })),
      nextCursor: result.nextCursor,
      scope:
        "Local sessions exposed by this Codex app-server. This does not enumerate every cloud-backed chat.",
    };
  } finally {
    await rpc.close();
  }
}
export async function sessionRead(
  cfg: Config,
  provider: Provider,
  id: string,
  offset = 0,
  cursor?: string,
) {
  if (provider === "claude") {
    const info = await getSessionInfo(id);
    if (!info) throw new Error("Claude Code session not found");
    const messages = await getSessionMessages(id, { limit: 12, offset });
    return {
      provider,
      id,
      title: info.customTitle || info.summary,
      project: info.cwd,
      messages: messages.map((m: any) => ({
        id: m.uuid,
        role: m.type,
        text: plainText(m.message?.content),
      })),
      nextOffset: messages.length === 12 ? offset + 12 : null,
    };
  }
  const rpc = new CodexAdapter(cfg).open(cfg.stateDir);
  try {
    if (offset)
      throw new Error(
        "Codex history uses the returned cursor, not a numeric offset",
      );
    await rpc.initialize();
    const { thread } = await rpc.request("thread/read", {
      threadId: id,
      includeTurns: false,
    });
    const page = await rpc.request("thread/items/list", {
      threadId: id,
      cursor,
      limit: 12,
      sortDirection: "desc",
    });
    return {
      provider,
      id,
      title: thread.name || thread.preview,
      project: thread.cwd,
      messages: page.data
        .map((record: any) => record.item)
        .filter((i: any) => ["userMessage", "agentMessage"].includes(i.type))
        .map((i: any) => ({
          id: i.id,
          role: i.type,
          text: (i.text || plainText(i.content)).slice(0, 4000),
        })),
      nextCursor: page.nextCursor ?? null,
      order: "newest first; tool and reasoning items omitted",
    };
  } finally {
    await rpc.close();
  }
}
function plainText(content: any): string {
  if (typeof content === "string") return content.slice(0, 4000);
  return Array.isArray(content)
    ? content
        .filter((c) => ["text", "input_text"].includes(c.type))
        .map((c) => c.text || "")
        .join("\n")
        .slice(0, 4000)
    : "";
}
