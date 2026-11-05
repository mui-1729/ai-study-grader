import { z } from 'zod';
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
const text = z.string().trim().min(1).max(100000);
export const criterionSchema = z
  .object({ id, description: text, maxPoints: z.number().int().positive().max(1000) })
  .strict();
export const questionSchema = z
  .object({
    id,
    chapterId: id,
    title: text,
    kind: z.enum(['written', 'exact']),
    prompt: text,
    maxPoints: z.number().int().positive().max(1000),
    modelAnswer: text,
    rubric: text,
    criteria: z.array(criterionSchema).min(1).max(50),
    acceptedAnswers: z.array(text).max(100).default([]),
    reviewChapterIds: z.array(id).min(1).max(20),
    section: z.enum(['practice', 'mock']).default('practice'),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.criteria.reduce((s, c) => s + c.maxPoints, 0) !== q.maxPoints)
      ctx.addIssue({ code: 'custom', message: '観点の配点合計が満点と一致しません' });
    if (new Set(q.criteria.map((c) => c.id)).size !== q.criteria.length)
      ctx.addIssue({ code: 'custom', message: '観点IDが重複しています' });
    if (q.kind === 'exact' && !q.acceptedAnswers.length)
      ctx.addIssue({ code: 'custom', message: '厳密一致問題には正解の一覧が必要です' });
  });
export const courseSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    version: text,
    title: text,
    description: text,
    gradingPolicy: text,
    chapters: z
      .array(z.object({ id, title: text, content: text }).strict())
      .min(1)
      .max(200),
    questions: z.array(questionSchema).max(2000),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const list of [c.chapters, c.questions])
      if (new Set(list.map((x) => x.id)).size !== list.length)
        ctx.addIssue({ code: 'custom', message: 'IDが重複しています' });
    const ids = new Set(c.chapters.map((x) => x.id));
    for (const q of c.questions)
      if (![q.chapterId, ...q.reviewChapterIds].every((x) => ids.has(x)))
        ctx.addIssue({ code: 'custom', message: `復習先の章が見つかりません: ${q.id}` });
  });
export type Course = z.infer<typeof courseSchema>;
export type Question = Course['questions'][number];
export type CriterionResult = { id: string; points: number; reason: string; evidence: string };
export type Grade = {
  mode: 'ai' | 'exact' | 'self';
  score: number;
  maxPoints: number;
  feedback: string;
  criteria: CriterionResult[];
  needsReview: boolean;
  model?: string;
};
