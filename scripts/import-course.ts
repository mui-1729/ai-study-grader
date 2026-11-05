import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { persistCourse } from '../src/materials.js';
import type { Course } from '../src/schema.js';
const directory = process.argv[2];
if (!directory) throw new Error('教材原稿フォルダーのパスを指定してください。');
const read = (file: string) => readFileSync(join(directory, file), 'utf8').replace(/\r\n/g, '\n');
const clean = (s: string) =>
  s
    .replace(/<!-- pagebreak -->/g, '')
    .replace(/^解答：[\s　]*$/gm, '')
    .replace(/^[　 ]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
function blocks(s: string, pattern: RegExp) {
  const matches = [...s.matchAll(pattern)];
  return matches.map((m, i) => ({
    match: m,
    body: clean(s.slice(m.index! + m[0].length, matches[i + 1]?.index ?? s.length)),
  }));
}
const textbook = read('01_基礎から学ぶ教材.md'),
  quizzes = read('02_章ごとの確認テスト.md'),
  mock = read('03_60分模擬テスト.md'),
  answers = read('04_解答解説と採点基準.md');
const chapters = blocks(textbook, /^## 第(\d+)章[　 ]+(.+)$/gm).map(({ match: m, body }) => ({
  id: `ch-${m[1]}`,
  title: `第${m[1]}章 ${m[2]}`,
  content: body,
}));
const answerMap = new Map(
  blocks(answers, /^### (\d+-\d+)$/gm).map(({ match: m, body }) => [
    m[1]!,
    body.split(/^## /m)[0]!.trim(),
  ]),
);
const questions: Course['questions'] = blocks(quizzes, /^### (\d+-\d+)〔(\d+)点〕$/gm).map(
  ({ match: m, body }) => {
    const solution = answerMap.get(m[1]!);
    if (!solution) throw new Error(`解答不足: ${m[1]}`);
    const points = Number(m[2]);
    const ch = `ch-${m[1]!.split('-')[0]}`;
    return {
      id: `practice-${m[1]}`,
      chapterId: ch,
      title: `確認テスト ${m[1]}`,
      kind: 'written',
      prompt: body.split(/^## /m)[0]!.trim(),
      maxPoints: points,
      modelAnswer: solution,
      rubric: solution,
      criteria: [
        {
          id: 'overall',
          description: '原稿内の〔配点〕を合算し、途中式・理由・正しい別解も評価する。',
          maxPoints: points,
        },
      ],
      reviewChapterIds: [ch],
      acceptedAnswers: [],
      section: 'practice',
    };
  },
);
const mockAnswers = blocks(answers, /^## 大問(\d+)〔(\d+)点〕$/gm);
const review = [
  ['ch-1', 'ch-2'],
  ['ch-3', 'ch-4'],
  ['ch-5'],
  ['ch-6', 'ch-7'],
  ['ch-8'],
  ['ch-9', 'ch-10'],
  ['ch-11'],
];
for (const { match: m, body } of blocks(mock, /^## 大問(\d+)[　 ]+(.+)〔(\d+)点／\d+分〕$/gm)) {
  const a = mockAnswers.find((x) => x.match[1] === m[1]);
  if (!a) throw new Error('模試解答不足');
  const refs = review[Number(m[1]) - 1]!;
  const solution = a.body.split(/^## 得点/m)[0]!.trim();
  const criteria = blocks(solution, /^### (\d+-[A-Z])〔(\d+)点〕$/gm).map(
    ({ match: cm, body: cb }) => ({
      id: `part-${cm[1]!.toLowerCase()}`,
      description: cb,
      maxPoints: Number(cm[2]),
    }),
  );
  questions.push({
    id: `mock-${m[1]}`,
    chapterId: refs[0]!,
    title: `模擬テスト 大問${m[1]} ${m[2]}`,
    kind: 'written',
    prompt: body,
    maxPoints: Number(m[3]),
    modelAnswer: solution,
    rubric: solution,
    criteria,
    reviewChapterIds: refs,
    acceptedAnswers: [],
    section: 'mock',
  });
}
if (
  chapters.length !== 11 ||
  questions.filter((q) => q.section === 'practice').length !== 44 ||
  questions.filter((q) => q.section === 'mock').length !== 7 ||
  questions.filter((q) => q.section === 'mock').reduce((s, q) => s + q.maxPoints, 0) !== 100
)
  throw new Error('原稿の問題数・配点を確認してください。');
mkdirSync('data/courses', { recursive: true });
const c = persistCourse(resolve('data/courses'), {
  schemaVersion: 1,
  id: 'software-d',
  version: '2026-11-05',
  title: 'コンピュータ・ソフトウェア論D',
  description: '集合と論理から組合せゲーム理論へ。第1〜5回の学習教材・確認テスト・模擬テスト。',
  gradingPolicy:
    '同じ意味の表現や別の正しい勝ち手も正解。指定の途中式や理由に配点する。計算ミスを後続の小問で一貫して用いた場合、同じ原因を重ねて減点せず後続の方法に配点する。ただし最終的なP/Nや合法性の誤りに対する点は与えない。原稿中の〔〕内の配点に従う。',
  chapters,
  questions,
});
console.log(`追加しました: ${c.chapters.length}章、確認44問、模試7題（100点）`);
