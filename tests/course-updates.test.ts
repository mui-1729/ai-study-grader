import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { courseSchema } from '../src/schema.js';
import {
  planCourseAppend,
  applyCourseAppend,
  courseAppendSchema,
  assertLegacyAppStopped,
} from '../src/course-updates.js';
import { acquireDataLock } from '../src/runtime-lock.js';
import { Store } from '../src/store.js';
const sample = courseSchema.parse(JSON.parse(readFileSync('examples/sample-course.json', 'utf8')));
const patch = () => ({
  schemaVersion: 1,
  courseId: sample.id,
  version: '2',
  chapters: [{ id: 'ch-2', title: '新しく追加する章', content: '新しい章の本文。' }],
  questions: [
    { ...sample.questions[1]!, id: 'q-3', chapterId: 'ch-2', reviewChapterIds: ['ch-1', 'ch-2'] },
  ],
});
function fixture() {
  mkdirSync('work/tests', { recursive: true });
  const dir = mkdtempSync(resolve('work/tests/append-'));
  mkdirSync(join(dir, 'courses'));
  writeFileSync(join(dir, 'courses', `${sample.id}.json`), JSON.stringify(sample, null, 2));
  return dir;
}
const offline = async () => {};
test('旧版の応答や不明な接続状態がある場合は停止済みと扱わない', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}');
    await assert.rejects(() => assertLegacyAppStopped(), /応答しています/);
    globalThis.fetch = async () => {
      throw new Error('unknown');
    };
    await assert.rejects(() => assertLegacyAppStopped(), /停止を確認できません/);
    globalThis.fetch = async () => {
      throw new TypeError('refused', { cause: { code: 'ECONNREFUSED' } });
    };
    await assertLegacyAppStopped();
  } finally {
    globalThis.fetch = original;
  }
});
test('追加計画は教材もDBも変更せず、既存オブジェクトを保つ', () => {
  const dir = fixture(),
    file = join(dir, 'courses', `${sample.id}.json`),
    before = readFileSync(file);
  const plan = planCourseAppend(dir, patch());
  assert.deepEqual(readFileSync(file), before);
  assert.ok(!existsSync(join(dir, 'backups')));
  assert.deepEqual(plan.addedChapterIds, ['ch-2']);
  assert.deepEqual(plan.addedQuestionIds, ['q-3']);
  assert.deepEqual(plan.merged.chapters.slice(0, sample.chapters.length), sample.chapters);
  assert.deepEqual(plan.merged.questions.slice(0, sample.questions.length), sample.questions);
  assert.equal(plan.merged.id, sample.id);
  assert.equal(plan.merged.title, sample.title);
  assert.equal(plan.merged.gradingPolicy, sample.gradingPolicy);
});
test('CLIの既定動作は差分確認だけで、適用に確認済みハッシュを要求する', () => {
  const dir = fixture(),
    delta = join(dir, 'addition.json'),
    file = join(dir, 'courses', `${sample.id}.json`),
    before = readFileSync(file);
  writeFileSync(delta, JSON.stringify(patch()));
  const args = ['--import', 'tsx', 'scripts/append-package.ts', delta, '--data-dir', dir];
  const preview = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(preview.status, 0);
  assert.ok(preview.stdout.includes('"mode": "preview"'));
  assert.deepEqual(readFileSync(file), before);
  assert.ok(!existsSync(join(dir, 'backups')));
  const missingHash = spawnSync(process.execPath, [...args, '--apply'], { encoding: 'utf8' });
  assert.equal(missingHash.status, 1);
  assert.ok(missingHash.stderr.includes('SHA256'));
  assert.deepEqual(readFileSync(file), before);
});
test('ID衝突・既存改変・重複・存在しない復習先・不正配点を拒否する', () => {
  const dir = fixture();
  assert.throws(
    () =>
      planCourseAppend(dir, {
        ...patch(),
        chapters: [{ ...sample.chapters[0]!, content: '既存の改変' }],
      }),
    /内容が異なります/,
  );
  assert.throws(
    () =>
      planCourseAppend(dir, {
        ...patch(),
        questions: [{ ...sample.questions[0]!, title: '変更' }],
      }),
    /内容が異なります/,
  );
  assert.throws(() =>
    planCourseAppend(dir, { ...patch(), chapters: [patch().chapters[0]!, patch().chapters[0]!] }),
  );
  assert.throws(() =>
    planCourseAppend(dir, {
      ...patch(),
      questions: [{ ...patch().questions[0]!, reviewChapterIds: ['missing'] }],
    }),
  );
  assert.throws(() =>
    planCourseAppend(dir, { ...patch(), questions: [{ ...patch().questions[0]!, maxPoints: 99 }] }),
  );
  assert.throws(() => courseAppendSchema.parse({ ...patch(), gradingPolicy: '置換しない' }));
  assert.throws(() => courseAppendSchema.parse({ ...patch(), chapters: [], questions: [] }));
});
test('履歴と下書きの整合性あるバックアップを作り、再適用は何も変更しない', async () => {
  const dir = fixture(),
    store = new Store(join(dir, 'study.sqlite'));
  const q = sample.questions[0]!,
    key = `${sample.id}:${createHash('sha256').update(JSON.stringify(q)).digest('hex')}:${q.id}`;
  store.saveDraft(key, '保存した下書き');
  store.saveAttempt({
    courseId: sample.id,
    courseTitle: sample.title,
    courseVersion: sample.version,
    courseHash: 'original',
    questionId: q.id,
    questionTitle: q.title,
    answer: '5',
    modelAnswer: q.modelAnswer,
    rubric: q.rubric,
    reviewChapterIds: q.reviewChapterIds,
    grade: {
      mode: 'self',
      score: 1,
      maxPoints: 1,
      criteria: [],
      feedback: '記録',
      needsReview: false,
    },
  });
  store.close();
  const file = join(dir, 'courses', `${sample.id}.json`),
    before = readFileSync(file),
    plan = planCourseAppend(dir, patch());
  const result = await applyCourseAppend(dir, patch(), {
    expectedBaseHash: plan.baseFileHash,
    checkStopped: offline,
  });
  assert.ok(result.backupDirectory);
  assert.deepEqual(readFileSync(join(result.backupDirectory, 'course-before.json')), before);
  const copy = new Store(join(result.backupDirectory, 'study.sqlite'));
  assert.equal(copy.draft(key), '保存した下書き');
  assert.equal(copy.history().length, 1);
  assert.equal(copy.history()[0]!.courseVersion, '1');
  copy.close();
  const live = new Store(join(dir, 'study.sqlite'));
  assert.equal(live.draft(key), '保存した下書き');
  assert.equal(live.history().length, 1);
  live.close();
  const after = readFileSync(file),
    backups = readdirSync(join(dir, 'backups'));
  const again = await applyCourseAppend(dir, patch(), {
    expectedBaseHash: plan.baseFileHash,
    checkStopped: async () => {
      throw new Error('no-op must not need a stopped app');
    },
  });
  assert.equal(again.changed, false);
  assert.equal(again.backupDirectory, null);
  assert.deepEqual(readFileSync(file), after);
  assert.deepEqual(readdirSync(join(dir, 'backups')), backups);
  assert.ok(!existsSync(join(dir, '.study-studio.lock')));
});
test('確認後の教材変更、起動中の使用、停止未確認なら適用しない', async () => {
  const dir = fixture(),
    file = join(dir, 'courses', `${sample.id}.json`),
    plan = planCourseAppend(dir, patch());
  writeFileSync(file, JSON.stringify({ ...sample, description: '確認後の変更' }));
  await assert.rejects(
    () =>
      applyCourseAppend(dir, patch(), {
        expectedBaseHash: plan.baseFileHash,
        checkStopped: offline,
      }),
    /差分確認後/,
  );
  const newPlan = planCourseAppend(dir, patch()),
    before = readFileSync(file),
    lock = acquireDataLock(dir, 'server');
  try {
    await assert.rejects(
      () =>
        applyCourseAppend(dir, patch(), {
          expectedBaseHash: newPlan.baseFileHash,
          checkStopped: offline,
        }),
      /使用中/,
    );
  } finally {
    lock.release();
  }
  await assert.rejects(
    () =>
      applyCourseAppend(dir, patch(), {
        expectedBaseHash: newPlan.baseFileHash,
        checkStopped: async () => {
          throw new Error('停止を確認できません');
        },
      }),
    /停止を確認/,
  );
  assert.deepEqual(readFileSync(file), before);
  assert.ok(!existsSync(join(dir, 'backups')));
});
test('SQLiteのWAL内にある未チェックポイントの履歴もバックアップする', async () => {
  const dir = fixture(),
    db = new DatabaseSync(join(dir, 'study.sqlite'));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE log (value TEXT); INSERT INTO log VALUES ('committed in WAL');",
  );
  const plan = planCourseAppend(dir, patch());
  const result = await applyCourseAppend(dir, patch(), {
    expectedBaseHash: plan.baseFileHash,
    checkStopped: offline,
  });
  const copy = new DatabaseSync(join(result.backupDirectory!, 'study.sqlite'), { readOnly: true });
  assert.equal(copy.prepare('SELECT value FROM log').get()!.value, 'committed in WAL');
  copy.close();
  assert.equal(db.prepare('SELECT value FROM log').get()!.value, 'committed in WAL');
  db.close();
});
