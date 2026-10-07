import path from "node:path";
import { DatabaseSync } from "node:sqlite";
// A separate SQLite database holds an OS-backed exclusive lock for the daemon's
// lifetime. It is released by the kernel on death, never by a guessed stale TTL.
export function acquireDaemonLock(stateDir: string): DatabaseSync | undefined {
  const db = new DatabaseSync(path.join(stateDir, "coordinator-lock.sqlite"));
  try {
    db.exec(
      "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER)",
    );
    return db;
  } catch (e) {
    db.close();
    if (e instanceof Error && /database is locked/.test(e.message))
      return undefined;
    throw e;
  }
}
