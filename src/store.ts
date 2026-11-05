import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { courseSchema, type Course, type Grade } from './schema.js';
import type { UsageLog, UsageEvent, QuotaSnapshot } from './usage.js';
export function courseHash(c: Course) {
  return createHash('sha256').update(JSON.stringify(c)).digest('hex');
}
export function loadCourses(directory: string): Course[] {
  mkdirSync(directory, { recursive: true });
  const courses = readdirSync(directory)
    .filter((x) => x.endsWith('.json'))
    .sort()
    .map((x) => courseSchema.parse(JSON.parse(readFileSync(join(directory, x), 'utf8'))));
  if (new Set(courses.map((c) => c.id)).size !== courses.length)
    throw new Error('教材IDが重複しています');
  return courses;
}
export type Attempt = {
  id: string;
  createdAt: string;
  courseId: string;
  courseTitle: string;
  courseVersion: string;
  courseHash: string;
  questionId: string;
  questionTitle: string;
  answer: string;
  grade: Grade;
  modelAnswer: string;
  rubric: string;
  reviewChapterIds: string[];
};
export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS drafts (key TEXT PRIMARY KEY, answer TEXT NOT NULL);',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS api_usage (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,payload TEXT NOT NULL);',
    );
  }
  saveAttempt(a: Omit<Attempt, 'id' | 'createdAt'>): Attempt {
    const attempt = { ...a, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO attempts VALUES (?,?,?)')
      .run(attempt.id, attempt.createdAt, JSON.stringify(attempt));
    return attempt;
  }
  history(): Attempt[] {
    return (
      this.db
        .prepare('SELECT payload FROM attempts ORDER BY created_at DESC, rowid DESC LIMIT 2000')
        .all() as { payload: string }[]
    ).map((x) => JSON.parse(x.payload) as Attempt);
  }
  draft(key: string) {
    return (
      (
        this.db.prepare('SELECT answer FROM drafts WHERE key=?').get(key) as
          { answer: string } | undefined
      )?.answer ?? ''
    );
  }
  saveDraft(key: string, answer: string) {
    this.db
      .prepare(
        'INSERT INTO drafts VALUES (?,?) ON CONFLICT(key) DO UPDATE SET answer=excluded.answer',
      )
      .run(key, answer);
  }
  close() {
    this.db.close();
  }
  startUsage(model: string) {
    const record: UsageLog = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      model,
      status: 'running',
      usage: null,
      limits: {},
    };
    this.db
      .prepare('INSERT INTO api_usage VALUES (?,?,?)')
      .run(record.id, record.createdAt, JSON.stringify(record));
    return record.id;
  }
  updateUsage(id: string, event: UsageEvent, status?: UsageLog['status']) {
    const row = this.db.prepare('SELECT payload FROM api_usage WHERE id=?').get(id) as
      { payload: string } | undefined;
    if (!row) return;
    const value = JSON.parse(row.payload) as UsageLog;
    const updated = {
      ...value,
      ...event,
      limits: { ...value.limits, ...event.limits },
      status: status ?? value.status,
    };
    this.db.prepare('UPDATE api_usage SET payload=? WHERE id=?').run(JSON.stringify(updated), id);
  }
  usages(): UsageLog[] {
    return (
      this.db
        .prepare('SELECT payload FROM api_usage ORDER BY created_at DESC,rowid DESC')
        .all() as { payload: string }[]
    ).map((x) => JSON.parse(x.payload) as UsageLog);
  }
  quota(): QuotaSnapshot | null {
    const row = this.db.prepare("SELECT payload FROM metadata WHERE key='quota'").get() as
      { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as QuotaSnapshot) : null;
  }
  saveQuota(value: QuotaSnapshot) {
    this.db
      .prepare(
        "INSERT INTO metadata VALUES ('quota',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
      )
      .run(JSON.stringify(value));
  }
}
