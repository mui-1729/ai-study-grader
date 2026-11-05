import express from 'express';
import { spawn } from 'node:child_process';
import { APICallError } from 'ai';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import multer from 'multer';
import { loadCourses, Store, courseHash } from './store.js';
import { gradeAI, gradeExact } from './grading.js';
import { questionSchema, courseSchema, type Grade } from './schema.js';
import { loadConfig, saveConfig, INIAD_BASE_URL } from './config.js';
import { extractMaterial, materialCourse, persistCourse } from './materials.js';
import { usageSummary } from './usage.js';
export function createApp(dataDir = resolve('data')) {
  mkdirSync(dataDir, { recursive: true });
  const coursesDir = join(dataDir, 'courses');
  const courses = loadCourses(coursesDir),
    store = new Store(join(dataDir, 'study.sqlite'));
  let config = loadConfig(dataDir);
  let busy = false;
  const csrf = randomBytes(32).toString('hex');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname))
      return void res.status(403).json({ error: 'このアプリは自分のパソコン専用です。' });
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (req.path.startsWith('/api') && req.method !== 'GET') {
      const origin = req.get('origin');
      if (
        (origin && origin !== `${req.protocol}://${req.get('host')}`) ||
        req.get('x-study-token') !== csrf
      )
        return void res.status(403).json({ error: 'ページを再読み込みしてからお試しください。' });
    }
    next();
  });
  app.use(express.json({ limit: '3mb' }));
  app.get('/api/status', (_req, res) =>
    res.json({
      aiConfigured: Boolean(config.apiKey),
      provider: 'INIAD AI-MOP',
      model: config.model,
      token: csrf,
    }),
  );
  app.put('/api/settings', (req, res) => {
    const body = z
      .object({
        apiKey: z.string().trim().min(1).max(500).optional(),
        model: z.string().regex(/^[a-zA-Z0-9._:/-]{1,100}$/),
      })
      .strict()
      .parse(req.body);
    config = saveConfig(dataDir, { apiKey: body.apiKey ?? config.apiKey, model: body.model });
    res.json({ saved: true });
  });
  app.get('/api/usage', (_req, res) => res.json(usageSummary(store.usages(), store.quota())));
  app.put('/api/quota', (req, res) => {
    const body = z
      .object({
        remaining: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        note: z.string().max(200).default('quotaで確認した値'),
      })
      .strict()
      .parse(req.body);
    store.saveQuota({ ...body, observedAt: new Date().toISOString(), source: 'quota-report' });
    res.json({ saved: true });
  });
  app.post('/api/models', async (_req, res) => {
    if (!config.apiKey)
      return void res.status(503).json({ error: '先にAI-MOPの鍵を設定してください。' });
    try {
      const response = await fetch(`${INIAD_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error();
      const data = z
        .object({ data: z.array(z.object({ id: z.string() })) })
        .parse(await response.json());
      res.json(data.data.map((x) => x.id));
    } catch {
      res.status(502).json({
        error: 'モデル一覧を取得できませんでした。AI-MOPに表示されるモデル名を入力してください。',
      });
    }
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  });
  app.post('/api/materials', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return void res.status(400).json({ error: 'ファイルを選んでください。' });
      let raw: unknown;
      if (/\.json$/i.test(req.file.originalname))
        raw = JSON.parse(req.file.buffer.toString('utf8'));
      else {
        const title = z
          .string()
          .trim()
          .min(1)
          .max(160)
          .parse(req.body.title || req.file.originalname.replace(/\.[^.]+$/, ''));
        raw = materialCourse(title, await extractMaterial(req.file));
      }
      const parsed = courseSchema.parse(raw);
      if (courses.some((c) => c.id === parsed.id))
        return void res
          .status(409)
          .json({ error: '同じIDの教材が登録済みです。別のIDで追加してください。' });
      const course = persistCourse(coursesDir, parsed);
      courses.push(course);
      res.status(201).json({ id: course.id });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/questions', (req, res) => {
    const body = z
      .object({ courseId: z.string(), question: questionSchema })
      .strict()
      .parse(req.body);
    const course = courses.find((c) => c.id === body.courseId);
    if (!course) return void res.status(404).json({ error: '教材が見つかりません。' });
    const updated = courseSchema.parse({
      ...course,
      version: new Date().toISOString(),
      questions: [...course.questions, body.question],
    });
    writeFileSync(join(coursesDir, `${course.id}.json`), JSON.stringify(updated, null, 2), 'utf8');
    Object.assign(course, updated);
    res.status(201).json({ saved: true });
  });
  app.get('/api/courses', (_req, res) =>
    res.json(
      courses.map((c) => ({
        ...c,
        questions: c.questions.map(
          ({ modelAnswer: _, rubric: __, acceptedAnswers: ___, ...q }) => q,
        ),
      })),
    ),
  );
  app.get('/api/history', (_req, res) => res.json(store.history()));
  const lookup = (courseId: string, questionId: string) => {
    const course = courses.find((c) => c.id === courseId),
      question = course?.questions.find((q) => q.id === questionId);
    if (!course || !question) throw new Error('問題が見つかりません。');
    return {
      course,
      question,
      key: `${course.id}:${createHash('sha256').update(JSON.stringify(question)).digest('hex')}:${question.id}`,
    };
  };
  app.get('/api/draft/:courseId/:questionId', (req, res) => {
    const { key } = lookup(req.params.courseId, req.params.questionId);
    res.json({ answer: store.draft(key) });
  });
  app.put('/api/draft', (req, res) => {
    const body = z
      .object({ courseId: z.string(), questionId: z.string(), answer: z.string().max(12000) })
      .strict()
      .parse(req.body);
    const { key } = lookup(body.courseId, body.questionId);
    store.saveDraft(key, body.answer);
    res.json({ saved: true });
  });
  app.get('/api/solution/:courseId/:questionId', (req, res) => {
    const { question: q } = lookup(req.params.courseId, req.params.questionId);
    res.json({ modelAnswer: q.modelAnswer, rubric: q.rubric });
  });
  app.post('/api/grade', async (req, res, next) => {
    if (busy)
      return void res
        .status(429)
        .json({ error: '別の採点が進行中です。少し待ってお試しください。' });
    try {
      const body = z
        .object({
          courseId: z.string(),
          questionId: z.string(),
          answer: z.string().trim().min(1).max(12000),
          mode: z.enum(['ai', 'self', 'exact']),
          selfScore: z.number().int().nonnegative().optional(),
          model: z
            .string()
            .regex(/^[a-zA-Z0-9._:/-]{1,100}$/)
            .optional(),
        })
        .strict()
        .parse(req.body);
      const { course, question: q, key } = lookup(body.courseId, body.questionId);
      store.saveDraft(key, body.answer);
      let grade: Grade;
      if (body.mode === 'self') {
        if (body.selfScore === undefined || body.selfScore > q.maxPoints)
          return void res.status(400).json({ error: '0点から満点までの整数で入力してください。' });
        grade = {
          mode: 'self',
          score: body.selfScore,
          maxPoints: q.maxPoints,
          criteria: [],
          feedback: '模範解答と採点基準を見て、ご自身で記録した点数です。',
          needsReview: false,
        };
      } else if (body.mode === 'exact') {
        if (q.kind !== 'exact')
          return void res.status(400).json({ error: 'この問題は記述式です。' });
        grade = gradeExact(q, body.answer);
      } else {
        if (!config.apiKey)
          return void res.status(503).json({
            error: 'AI-MOPは未設定です。自己採点を利用するか、AI接続を設定してください。',
          });
        busy = true;
        const usageId = store.startUsage(body.model ?? config.model);
        try {
          grade = await gradeAI(
            course,
            q,
            body.answer,
            {
              ...config,
              model: body.model ?? config.model,
            },
            (event) => store.updateUsage(usageId, event),
          );
          store.updateUsage(usageId, {}, 'completed');
        } catch (error) {
          store.updateUsage(usageId, {}, 'failed');
          if (APICallError.isInstance(error) && error.statusCode === 429)
            return void res.status(429).json({
              error:
                'AI-MOPの利用制限に達しました。AI-MOP側の利用枠を確認し、時間を置いてお試しください。自動再送や点数の記録はしていません。',
            });
          if (APICallError.isInstance(error) && [401, 403].includes(error.statusCode ?? 0))
            return void res.status(502).json({
              error:
                'AI-MOPに接続できませんでした。APIキーと、このモデルの利用権限を確認してください。点数は記録していません。',
            });
          return void res.status(502).json({
            error:
              'AI採点を完了できませんでした。接続設定・利用枠を確認して再試行してください。自動再送はせず、点数も記録していません。',
          });
        } finally {
          busy = false;
        }
      }
      res.json(
        store.saveAttempt({
          courseId: course.id,
          courseTitle: course.title,
          courseVersion: course.version,
          courseHash: courseHash(course),
          questionId: q.id,
          questionTitle: q.title,
          answer: body.answer,
          grade,
          modelAnswer: q.modelAnswer,
          rubric: q.rubric,
          reviewChapterIds: q.reviewChapterIds,
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  app.get('/vendor/marked.js', (_req, res) =>
    res.sendFile(resolve('node_modules/marked/lib/marked.esm.js')),
  );
  app.get('/vendor/purify.js', (_req, res) =>
    res.sendFile(resolve('node_modules/dompurify/dist/purify.es.mjs')),
  );
  app.get('/app.js', (_req, res) => res.sendFile(resolve('dist/client/app.js')));
  app.use(express.static(resolve('public')));
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const known = [
        'このPDFから本文を取り出せませんでした。画像だけのPDFは、文字起こししたテキストを追加してください。',
        'PDFは150ページ以内に分けてください。',
        '本文が長すぎます。ファイルを分けてください。',
        'PDF・Markdown・テキストを選んでください。',
        '本文は10〜500,000文字で追加してください。',
        '問題が見つかりません。',
      ];
      res.status(400).json({
        error:
          error instanceof z.ZodError
            ? '入力内容や教材パッケージの形式を確認してください。'
            : error instanceof multer.MulterError
              ? 'ファイルは15MB以下で選んでください。'
              : error instanceof Error && known.includes(error.message)
                ? error.message
                : '処理できませんでした。入力内容・ファイル形式を確認してください。',
      });
    },
  );
  return { app, store };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORTが不正です');
  const { app, store } = createApp();
  const server = app.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`Study Studio: ${url}`);
    console.log('Stop: Ctrl+C');
    if (process.argv.includes('--open')) {
      const command =
        process.platform === 'win32'
          ? 'explorer.exe'
          : process.platform === 'darwin'
            ? 'open'
            : 'xdg-open';
      const browserProcess = spawn(command, [url], { stdio: 'ignore', windowsHide: true });
      browserProcess.on('error', () => console.log(`Open this URL in your browser: ${url}`));
      browserProcess.unref();
    }
  });
  process.on('SIGINT', () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
}
