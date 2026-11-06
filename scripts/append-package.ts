import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { applyCourseAppend, planCourseAppend } from '../src/course-updates.js';
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      apply: { type: 'boolean', default: false },
      'base-sha256': { type: 'string' },
      'data-dir': { type: 'string', default: 'data' },
      port: { type: 'string', default: '4317' },
    },
  });
  if (positionals.length !== 1)
    throw new Error('使い方: npm run append:package -- "追加.json"（確認のみ）');
  const delta = JSON.parse(readFileSync(positionals[0]!, 'utf8').replace(/^\uFEFF/, ''));
  const directory = resolve(values['data-dir']!);
  const plan = planCourseAppend(directory, delta);
  console.log(
    JSON.stringify(
      {
        mode: values.apply ? 'apply' : 'preview',
        courseId: plan.base.id,
        changed: plan.changed,
        baseFileHash: plan.baseFileHash,
        patchHash: plan.patchHash,
        versionBefore: plan.base.version,
        versionAfter: plan.merged.version,
        addedChapterIds: plan.addedChapterIds,
        addedQuestionIds: plan.addedQuestionIds,
        alreadyPresentChapterIds: plan.alreadyPresentChapterIds,
        alreadyPresentQuestionIds: plan.alreadyPresentQuestionIds,
      },
      null,
      2,
    ),
  );
  if (values.apply) {
    const result = await applyCourseAppend(directory, delta, {
      expectedBaseHash: values['base-sha256'] ?? '',
      port: Number(values.port),
    });
    console.log(
      result.changed
        ? `追加しました。個人用バックアップ: ${result.backupDirectory}`
        : '同じ内容が登録済みです。何も変更していません。',
    );
  } else
    console.log(
      '確認のみです。教材・履歴は変更していません。適用時はアプリを停止し、--apply --base-sha256 <表示されたbaseFileHash> を指定してください。',
    );
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('追加JSONの形式を確認してください。');
    for (const issue of error.issues)
      console.error(`${issue.path.join('.') || '全体'}: ${issue.message}`);
  } else if (error instanceof SyntaxError) console.error('追加JSONの構文を確認してください。');
  else console.error(error instanceof Error ? error.message : '追加できませんでした。');
  process.exitCode = 1;
}
