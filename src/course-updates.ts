import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync, backup } from 'node:sqlite';
import { z } from 'zod';
import { courseSchema, questionSchema, type Course } from './schema.js';
import { acquireDataLock } from './runtime-lock.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
export const courseAppendSchema = z
  .object({
    schemaVersion: z.literal(1),
    courseId: id,
    version: z.string().trim().min(1).max(100000).optional(),
    chapters: z.array(courseSchema.shape.chapters.element).max(200),
    questions: z.array(questionSchema).max(2000),
  })
  .strict()
  .superRefine((patch, ctx) => {
    if (!patch.chapters.length && !patch.questions.length)
      ctx.addIssue({ code: 'custom', message: '追加する章または問題が必要です。' });
    for (const items of [patch.chapters, patch.questions])
      if (new Set(items.map((x) => x.id)).size !== items.length)
        ctx.addIssue({ code: 'custom', message: '追加データ内のIDが重複しています。' });
  });
export type CourseAppend = z.infer<typeof courseAppendSchema>;
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function planCourseAppend(directory: string, raw: unknown) {
  const patch = courseAppendSchema.parse(raw);
  const courseFile = join(resolve(directory), 'courses', `${patch.courseId}.json`);
  const original = readFileSync(courseFile);
  const base = courseSchema.parse(JSON.parse(original.toString('utf8').replace(/^\uFEFF/, '')));
  if (base.id !== patch.courseId) throw new Error('ファイル内の教材IDと追加対象が一致しません。');
  function added<T extends { id: string }>(existing: T[], incoming: T[], kind: string) {
    return incoming.filter((item) => {
      const previous = existing.find((x) => x.id === item.id);
      if (!previous) return true;
      if (!isDeepStrictEqual(previous, item))
        throw new Error(
          `${kind} ${item.id} は登録済みで内容が異なります。既存内容は変更しません。`,
        );
      return false;
    });
  }
  const chapters = added(base.chapters, patch.chapters, '章'),
    questions = added(base.questions, patch.questions, '問題');
  const patchHash = sha256(JSON.stringify(patch));
  const changed = chapters.length + questions.length > 0;
  const version = changed
    ? (patch.version ?? `${base.version}+append-${patchHash.slice(0, 12)}`)
    : base.version;
  if (changed && version === base.version)
    throw new Error('追加時には既存と異なるversionを指定してください。');
  const merged = courseSchema.parse({
    ...base,
    version,
    chapters: [...base.chapters, ...chapters],
    questions: [...base.questions, ...questions],
  });
  // These are the same canonical objects used for draft-key hashing in the app.
  for (const q of base.questions)
    if (JSON.stringify(q) !== JSON.stringify(merged.questions.find((x) => x.id === q.id)))
      throw new Error('既存問題を保持できないため中止しました。');
  for (const ch of base.chapters)
    if (
      !isDeepStrictEqual(
        ch,
        merged.chapters.find((x) => x.id === ch.id),
      )
    )
      throw new Error('既存章を保持できないため中止しました。');
  return {
    courseFile,
    baseFileHash: sha256(original),
    patchHash,
    base,
    merged,
    changed,
    addedChapterIds: chapters.map((x) => x.id),
    addedQuestionIds: questions.map((x) => x.id),
    alreadyPresentChapterIds: patch.chapters.filter((x) => !chapters.includes(x)).map((x) => x.id),
    alreadyPresentQuestionIds: patch.questions
      .filter((x) => !questions.includes(x))
      .map((x) => x.id),
  };
}

function databaseState(db: DatabaseSync) {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((x) => x.name);
  return Object.fromEntries(
    tables.map((table) => {
      const quoted = '"' + table.replaceAll('"', '""') + '"';
      const rows = db
        .prepare(`SELECT * FROM ${quoted}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort();
      return [table, { rows: rows.length, hash: sha256(JSON.stringify(rows)) }];
    }),
  );
}
export async function assertLegacyAppStopped(port = 4317) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('確認するポートが不正です。');
  for (const candidate of new Set([4317, port])) {
    try {
      await fetch(`http://127.0.0.1:${candidate}/api/status`, {
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
    } catch (error) {
      if ((error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') continue;
      throw new Error('アプリの停止を確認できません。停止してから再実行してください。');
    }
    throw new Error(`ポート${candidate}でアプリが応答しています。停止してから追加してください。`);
  }
}

export async function applyCourseAppend(
  directory: string,
  raw: unknown,
  options: { expectedBaseHash: string; port?: number; checkStopped?: () => Promise<void> },
) {
  const first = planCourseAppend(directory, raw);
  if (!first.changed) return { ...first, backupDirectory: null };
  if (!/^[a-f0-9]{64}$/.test(options.expectedBaseHash))
    throw new Error('差分確認時の元ファイルSHA256が必要です。');
  const dataDir = resolve(directory),
    lock = acquireDataLock(dataDir, 'update');
  let temporaryFile: string | undefined;
  try {
    await (options.checkStopped ?? (() => assertLegacyAppStopped(options.port)))();
    const plan = planCourseAppend(dataDir, raw);
    if (!plan.changed) return { ...plan, backupDirectory: null };
    if (plan.baseFileHash !== options.expectedBaseHash)
      throw new Error('差分確認後に教材が変更されています。もう一度差分を確認してください。');
    const backupDirectory = join(
      dataDir,
      'backups',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    );
    mkdirSync(backupDirectory, { recursive: true });
    const original = readFileSync(plan.courseFile);
    writeFileSync(join(backupDirectory, 'course-before.json'), original, {
      flag: 'wx',
      mode: 0o600,
    });
    let sourceDb: DatabaseSync | undefined,
      initialDatabase: ReturnType<typeof databaseState> | undefined;
    try {
      const dbFile = join(dataDir, 'study.sqlite');
      if (existsSync(dbFile)) {
        sourceDb = new DatabaseSync(dbFile, { readOnly: true });
        initialDatabase = databaseState(sourceDb);
        const backupFile = join(backupDirectory, 'study.sqlite');
        await backup(sourceDb, backupFile);
        const copied = new DatabaseSync(backupFile, { readOnly: true });
        try {
          if (!isDeepStrictEqual(databaseState(copied), initialDatabase))
            throw new Error('履歴・下書きのバックアップが一致しません。');
          const check = copied.prepare('PRAGMA integrity_check').get();
          if (!check || Object.values(check)[0] !== 'ok')
            throw new Error('履歴のバックアップを検証できません。');
        } finally {
          copied.close();
        }
      }
      const manifest = {
        createdAt: new Date().toISOString(),
        courseId: plan.base.id,
        baseFileHash: plan.baseFileHash,
        patchHash: plan.patchHash,
        versionBefore: plan.base.version,
        versionAfter: plan.merged.version,
        addedChapterIds: plan.addedChapterIds,
        addedQuestionIds: plan.addedQuestionIds,
        database: initialDatabase ?? null,
      };
      writeFileSync(join(backupDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), {
        flag: 'wx',
        mode: 0o600,
      });
      const text = JSON.stringify(plan.merged, null, 2) + '\n';
      temporaryFile = join(dataDir, 'courses', `.append-${randomUUID()}.tmp`);
      const fd = openSync(temporaryFile, 'wx', 0o600);
      try {
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (sha256(readFileSync(plan.courseFile)) !== plan.baseFileHash)
        throw new Error('適用直前に教材が変更されたため中止しました。');
      if (sourceDb && !isDeepStrictEqual(databaseState(sourceDb), initialDatabase))
        throw new Error('適用中に下書きや履歴が更新されたため中止しました。');
      renameSync(temporaryFile, plan.courseFile);
      temporaryFile = undefined;
      if (sha256(readFileSync(plan.courseFile)) !== sha256(text))
        throw new Error('保存後の教材を確認できません。バックアップを保持しています。');
      return { ...plan, backupDirectory };
    } finally {
      sourceDb?.close();
    }
  } finally {
    if (temporaryFile) rmSync(temporaryFile, { force: true });
    lock.release();
  }
}
