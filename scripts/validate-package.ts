import { readFileSync } from 'node:fs';
import { courseSchema } from '../src/schema.js';
const files = process.argv.slice(2);
if (!files.length) {
  console.error('使い方: npm run validate:package -- "教材.json"');
  process.exitCode = 1;
}
for (const file of files) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const result = courseSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      console.error(`${file}: 形式を確認してください。`);
      for (const issue of result.error.issues)
        console.error(`  ${issue.path.join('.') || '全体'}: ${issue.message}`);
      process.exitCode = 1;
      continue;
    }
    const c = result.data;
    console.log(
      `${file}: 形式OK / ${c.chapters.length}章 / ${c.questions.length}問 / 配点合計${c.questions.reduce((s, q) => s + q.maxPoints, 0)}点`,
    );
    console.log('  内容・解答・出典の正確さは、別途確認してください。教材は追加していません。');
  } catch (error) {
    console.error(
      `${file}: ${error instanceof SyntaxError ? 'JSONの構文を確認してください。' : 'ファイルを読み込めませんでした。'}`,
    );
    process.exitCode = 1;
  }
}
