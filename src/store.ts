import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { privateDir } from "./config.js";
import { now, type BridgeEvent, type Job, type Task } from "./types.js";
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    privateDir(dir);
    const file = path.join(dir, "state.sqlite");
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
      throw new Error("State database cannot be a symlink");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,job_id TEXT,type TEXT NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
      CREATE INDEX IF NOT EXISTS jobs_task ON jobs(task_id);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  task(id: string): Task {
    const x = this.db
      .prepare("SELECT data FROM tasks WHERE id=?")
      .get(id) as any;
    if (!x) throw new Error("Task not found");
    return JSON.parse(x.data);
  }
  job(id: string): Job {
    const x = this.db
      .prepare("SELECT data FROM jobs WHERE id=?")
      .get(id) as any;
    if (!x) throw new Error("Job not found");
    return JSON.parse(x.data);
  }
  tasks(): Task[] {
    return this.db
      .prepare("SELECT data FROM tasks ORDER BY rowid DESC LIMIT 100")
      .all()
      .map((x: any) => JSON.parse(x.data));
  }
  jobs(taskId?: string): Job[] {
    return (
      taskId
        ? this.db.prepare("SELECT data FROM jobs WHERE task_id=?").all(taskId)
        : this.db.prepare("SELECT data FROM jobs").all()
    ).map((x: any) => JSON.parse(x.data));
  }
  saveTask(t: Task) {
    t.updatedAt = now();
    this.db
      .prepare(
        "INSERT INTO tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(t.id, JSON.stringify(t));
  }
  saveJob(j: Job) {
    j.updatedAt = now();
    this.db
      .prepare(
        "INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(j.id, j.taskId, JSON.stringify(j));
  }
  event(
    taskId: string,
    jobId: string | undefined,
    type: string,
    data: unknown,
  ) {
    this.db
      .prepare(
        "INSERT INTO events(task_id,job_id,type,data,at) VALUES(?,?,?,?,?)",
      )
      .run(taskId, jobId || null, type, JSON.stringify(data), now());
  }
  events(taskId: string, cursor = 0, jobId?: string): BridgeEvent[] {
    const query = `SELECT * FROM events WHERE task_id=? AND seq>? ${jobId ? "AND job_id=?" : ""} ORDER BY seq LIMIT 100`;
    const args = jobId ? [taskId, cursor, jobId] : [taskId, cursor];
    return this.db
      .prepare(query)
      .all(...args)
      .map((x: any) => ({
        seq: x.seq,
        taskId: x.task_id,
        jobId: x.job_id,
        type: x.type,
        data: JSON.parse(x.data),
        at: x.at,
      }));
  }
  previous(id: string, fingerprint: string): any | undefined {
    const row = this.db
      .prepare("SELECT * FROM requests WHERE id=?")
      .get(id) as any;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint)
      throw new Error("Request ID already used with different arguments");
    return JSON.parse(row.response);
  }
  remember(id: string, fingerprint: string, response: unknown) {
    this.db
      .prepare("INSERT INTO requests VALUES(?,?,?)")
      .run(id, fingerprint, JSON.stringify(response));
  }
  close() {
    this.db.close();
  }
}
