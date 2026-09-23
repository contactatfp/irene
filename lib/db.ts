import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// where the sqlite file lives. overridable for tests or railway volumes later
function resolveDbPath(): string {
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  return path.join(process.cwd(), "data", "generations.db");
}

export type GenerationStatus = "queued" | "running" | "complete" | "failed";

export interface GenerationRow {
  job_id: string;
  prompt: string;
  status: GenerationStatus;
  width: number;
  height: number;
  steps: number;
  ref_count: number;
  image_url: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  generation_time_ms: number | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __ireneDb: Database.Database | undefined;
}

function openDb(): Database.Database {
  if (globalThis.__ireneDb) return globalThis.__ireneDb;

  const dbPath = resolveDbPath();
  // make sure data/ exists before sqlite tries to create the file
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS generations (
      job_id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      width INTEGER NOT NULL DEFAULT 1024,
      height INTEGER NOT NULL DEFAULT 1024,
      steps INTEGER NOT NULL DEFAULT 25,
      ref_count INTEGER NOT NULL DEFAULT 0,
      image_url TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      generation_time_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_generations_created
      ON generations (created_at DESC);
  `);

  // older local DBs predate ref_count, add it in place
  const columns = db
    .prepare(`PRAGMA table_info(generations)`)
    .all() as { name: string }[];
  if (!columns.some((c) => c.name === "ref_count")) {
    db.exec(
      `ALTER TABLE generations ADD COLUMN ref_count INTEGER NOT NULL DEFAULT 0`
    );
  }

  globalThis.__ireneDb = db;
  return db;
}

export function createGeneration(row: {
  jobId: string;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  refCount?: number;
}): GenerationRow {
  const db = openDb();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO generations (job_id, prompt, status, width, height, steps, ref_count, created_at)
     VALUES (@jobId, @prompt, 'queued', @width, @height, @steps, @refCount, @createdAt)`
  ).run({ ...row, refCount: row.refCount ?? 0, createdAt });
  return getGeneration(row.jobId)!;
}

export function getGeneration(jobId: string): GenerationRow | undefined {
  const db = openDb();
  return db
    .prepare(`SELECT * FROM generations WHERE job_id = ?`)
    .get(jobId) as GenerationRow | undefined;
}

export function updateGeneration(
  jobId: string,
  patch: Partial<
    Pick<
      GenerationRow,
      "status" | "image_url" | "error" | "completed_at" | "generation_time_ms"
    >
  >
): GenerationRow | undefined {
  const db = openDb();
  const current = getGeneration(jobId);
  if (!current) return undefined;

  // auto-fill completed_at + elapsed time when a job lands in a terminal state
  let completedAt = patch.completed_at ?? current.completed_at;
  let elapsed = patch.generation_time_ms ?? current.generation_time_ms;
  const nextStatus = patch.status ?? current.status;
  if (
    (nextStatus === "complete" || nextStatus === "failed") &&
    !completedAt
  ) {
    const done = new Date();
    completedAt = done.toISOString();
    elapsed = done.getTime() - new Date(current.created_at).getTime();
  }

  db.prepare(
    `UPDATE generations
     SET status = @status,
         image_url = @image_url,
         error = @error,
         completed_at = @completed_at,
         generation_time_ms = @generation_time_ms
     WHERE job_id = @job_id`
  ).run({
    job_id: jobId,
    status: nextStatus,
    image_url: patch.image_url ?? current.image_url,
    error: patch.error ?? current.error,
    completed_at: completedAt,
    generation_time_ms: elapsed,
  });
  return getGeneration(jobId);
}

// newest first, for the little history strip on the page
export function listRecentGenerations(limit = 12): GenerationRow[] {
  const db = openDb();
  return db
    .prepare(`SELECT * FROM generations ORDER BY created_at DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 50)) as GenerationRow[];
}
