import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { courseSchema } from '../src/schema.js';
import { resolveQuestionContext } from '../src/question-context.js';
import { buildGradingData } from '../src/grading.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { memoryCredentialVault, windowsCredentialVault } from '../src/credentials.js';
const sample = courseSchema.parse(JSON.parse(readFileSync('examples/sample-course.json', 'utf8')));
const directory = () => {
  mkdirSync('work/tests', { recursive: true });
  return mkdtempSync(resolve('work/tests/privacy-'));
};
test('前問の条件を表示・採点用に解決し、模範解答は前提へ含めない', () => {
  const parent = {
    ...sample.questions[0]!,
    id: 'practice-6-2',
    title: '確認テスト 6-2',
    prompt: 'Zは終了、X→Z、C→X、D→Z,Cとする架空の練習問題。SG数を求めよ。',
    modelAnswer: 'secret solution',
  };
  const q = {
    ...sample.questions[1]!,
    id: 'practice-6-3',
    title: '確認テスト 6-3',
    prompt: '6-2のCとDをP/Nに分類せよ。',
  };
  const course = courseSchema.parse({ ...sample, questions: [parent, q] });
  const before = JSON.stringify(course.questions);
  const ctx = resolveQuestionContext(course, course.questions[1]!);
  assert.equal(ctx.questions[0]!.id, parent.id);
  assert.ok(ctx.questions[0]!.prompt.includes('D→Z,C'));
  assert.ok(!JSON.stringify(ctx).includes('secret solution'));
  assert.deepEqual(ctx.warnings, []);
  const data = JSON.parse(buildGradingData(course, course.questions[1]!, 'C:P D:N'));
  assert.ok(data.context.questions[0].prompt.includes('D→Z,C'));
  assert.equal(JSON.stringify(course.questions), before);
});
test('明示的な前提参照と既存問題のハッシュ用オブジェクトを保持する', () => {
  assert.equal(
    JSON.stringify(courseSchema.parse(sample).questions),
    JSON.stringify(sample.questions),
  );
  const course = courseSchema.parse({
    ...sample,
    questions: [
      sample.questions[0],
      { ...sample.questions[1]!, context: '追加条件', contextQuestionIds: ['q-1'] },
    ],
  });
  const ctx = resolveQuestionContext(course, course.questions[1]!);
  assert.equal(ctx.text, '追加条件');
  assert.equal(ctx.questions[0]!.id, 'q-1');
  assert.throws(() =>
    courseSchema.parse({
      ...sample,
      questions: [{ ...sample.questions[0]!, contextQuestionIds: ['missing'] }],
    }),
  );
});
test('キーを設定JSONへ書き戻さず、旧形式を保護ストアへ移行する', () => {
  const dir = directory(),
    vault = memoryCredentialVault();
  writeFileSync(
    join(dir, 'ai-config.json'),
    JSON.stringify({ apiKey: 'dummy-test-key', model: 'gpt-6-luna' }),
  );
  const loaded = loadConfig(dir, vault);
  assert.equal(loaded.apiKey, 'dummy-test-key');
  assert.equal(vault.read(), 'dummy-test-key');
  assert.ok(!readFileSync(join(dir, 'ai-config.json'), 'utf8').includes('dummy-test-key'));
  assert.ok(!readFileSync(join(dir, 'ai-config.json'), 'utf8').includes('apiKey'));
  saveConfig(dir, { apiKey: 'second-dummy', model: 'gpt-6-astra' }, vault);
  assert.equal(loadConfig(dir, vault).apiKey, 'second-dummy');
  assert.ok(!readFileSync(join(dir, 'ai-config.json'), 'utf8').includes('second-dummy'));
  saveConfig(dir, { apiKey: '', model: 'gpt-6-luna' }, vault);
  assert.equal(vault.read(), '');
});
test(
  'Windows保護ストアはダミー値を暗号化してプロジェクト外へ保存する',
  { skip: process.platform !== 'win32' },
  () => {
    const dir = directory(),
      external = directory(),
      vault = windowsCredentialVault(dir, external);
    const dummy = 'only-a-dummy-for-dpapi-test';
    vault.write(dummy);
    assert.equal(vault.read(), dummy);
    const files = readdirSync(join(external, 'StudyStudio', 'credentials'));
    assert.equal(files.length, 1);
    assert.ok(
      !readFileSync(join(external, 'StudyStudio', 'credentials', files[0]!), 'utf8').includes(
        dummy,
      ),
    );
    vault.remove();
    assert.equal(vault.read(), '');
  },
);
