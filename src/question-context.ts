import type { Course, Question } from './schema.js';
export type QuestionContext = {
  text: string;
  questions: { id: string; title: string; prompt: string }[];
  warnings: string[];
};
export function resolveQuestionContext(
  course: Pick<Course, 'questions'>,
  question: Question,
): QuestionContext {
  const result: QuestionContext = { text: question.context ?? '', questions: [], warnings: [] };
  const seen = new Set([question.id]);
  const label = (q: Question) =>
    q.title.normalize('NFKC').match(/(?:^|\s)(\d{1,3}-\d{1,3})(?=\s|$)/)?.[1];
  function visit(q: Question, depth: number) {
    if (depth > 8) {
      result.warnings.push('参照問題のつながりが深すぎます。');
      return;
    }
    const ids = [...(q.contextQuestionIds ?? [])];
    for (const match of q.prompt
      .normalize('NFKC')
      .matchAll(/(?<![\dA-Za-z])([0-9]{1,3}-[0-9]{1,3})(?=の|を|で|に|と|から|より|参照)/g)) {
      const targets = course.questions.filter(
        (x) => x.section === q.section && label(x) === match[1],
      );
      if (targets.length === 1) ids.push(targets[0]!.id);
      else result.warnings.push(`参照先 ${match[1]} を一意に確認できません。`);
    }
    for (const id of new Set(ids)) {
      if (seen.has(id)) continue;
      const target = course.questions.find((x) => x.id === id);
      if (!target) {
        result.warnings.push(`参照問題 ${id} が見つかりません。`);
        continue;
      }
      if (result.questions.length >= 20) {
        result.warnings.push('参照問題が多すぎます。');
        return;
      }
      seen.add(id);
      result.questions.push({
        id: target.id,
        title: target.title,
        prompt: [target.context, target.prompt].filter(Boolean).join('\n\n'),
      });
      visit(target, depth + 1);
    }
  }
  visit(question, 0);
  if (result.text.length + result.questions.reduce((n, q) => n + q.prompt.length, 0) > 24000)
    result.warnings.push('前提が長すぎます。必要な条件を問題内にまとめてください。');
  return result;
}
