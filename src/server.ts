import { readFile } from 'node:fs/promises';
import { MATERIAL_LIMITS } from './material-limits.js';
import express from 'express';
import { spawn } from 'node:child_process';
import { APICallError } from 'ai';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import multer from 'multer';
import { loadCourses, Store, courseHash } from './store.js';
import { gradeAI, gradeExact, GradingResponseError } from './grading.js';
import { questionSchema, courseSchema, type Grade } from './schema.js';
import { loadConfig, saveConfig, INIAD_BASE_URL } from './config.js';
import {
  extractMaterial,
  materialCourse,
  persistCourse,
  folderMaterialCourse,
  FolderMaterialError,
  materialPath,
} from './materials.js';
import { folderUpload, removeUpload } from './folder-upload.js';
import { materialImports, ImportBusyError } from './material-imports.js';
import { MaterialReadError, type OCRFactory } from './ocr.js';
import { usageSummary } from './usage.js';
import { acquireDataLock } from './runtime-lock.js';
import { defaultCredentialVault, type CredentialVault } from './credentials.js';
import { resolveQuestionContext } from './question-context.js';
import { tutorReply, newTutorMessage, type TutorSession } from './tutor.js';
import {
  authorUnit,
  sourceUnits,
  newGeneration,
  generationDraft,
  type GenerationJob,
} from './authoring.js';
export function createApp(
  dataDir = resolve('data'),
  options: { credentialVault?: CredentialVault; ocrFactory?: OCRFactory } = {},
) {
  mkdirSync(dataDir, { recursive: true });
  const coursesDir = join(dataDir, 'courses');
  const courses = loadCourses(coursesDir),
    store = new Store(join(dataDir, 'study.sqlite'));
  const vault = options.credentialVault ?? defaultCredentialVault(dataDir);
  let config = loadConfig(dataDir, vault);
  let busy = false;
  const imports = materialImports(coursesDir, courses, options.ocrFactory);
  // A restart must never silently re-send a paid request.
  for (const job of store.generations<GenerationJob>()) {
    if (job.state === 'running') {
      job.state = 'interrupted';
      store.saveGeneration(job);
    }
  }
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
  const materialPrompt = () => {
    const document = readFileSync(resolve('docs/create-material-prompt.md'), 'utf8');
    const marker = '## プロンプト本文';
    const start = document.indexOf(marker);
    if (start < 0) throw new Error('教材作成プロンプトを読み込めませんでした。');
    return document.slice(start + marker.length).trimStart();
  };
  app.get('/api/material-prompt', (_req, res) => res.json({ prompt: materialPrompt() }));
  app.get('/api/material-prompt/download', (_req, res) => {
    res.type('text/plain').attachment('study-studio-material-prompt.txt').send(materialPrompt());
  });
  app.get('/api/status', (_req, res) =>
    res.json({
      aiConfigured: Boolean(config.apiKey),
      appVersion: '2026.11.06.5',
      credentialStorage: config.credentialStorage,
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
    config = saveConfig(
      dataDir,
      { apiKey: body.apiKey ?? config.apiKey, model: body.model },
      vault,
    );
    res.json({ saved: true });
  });
  app.delete('/api/settings/key', (_req, res) => {
    config = saveConfig(dataDir, { apiKey: '', model: config.model }, vault);
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
    limits: { fileSize: MATERIAL_LIMITS.fileBytes, files: 1 },
  });
  app.get('/api/material-import/:id', (req, res) => {
    const job = imports.get(req.params.id);
    if (!job)
      return void res
        .status(404)
        .json({
          error:
            '取り込みの状態が見つかりません。アプリを起動し直した場合はマイ教材を確認してください。自動で再送はしません。',
        });
    res.json(job);
  });
  app.post('/api/material-import/:id/cancel', (req, res) => {
    imports.cancel(req.params.id);
    res.json({ saved: true });
  });
  app.post('/api/material-import', folderUpload(join(dataDir, 'uploads')), async (req, res) => {
    let transferred = false;
    try {
      const body = z
        .object({
          title: z.string().trim().min(1).max(160),
          paths: z
            .string()
            .transform((value) =>
              z
                .array(z.string().min(1).max(512))
                .min(1)
                .max(MATERIAL_LIMITS.folderFiles)
                .parse(JSON.parse(value)),
            ),
          ocrMode: z.enum(['auto', 'always', 'off']).default('auto'),
        })
        .strict()
        .parse(req.body);
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files?.length || files.length !== body.paths.length)
        throw new FolderMaterialError('選択した資料の一覧を確認してください。');
      const job = imports.start(
        body.title,
        files.map((upload, i) => ({ path: materialPath(body.paths[i]!), upload })),
        body.ocrMode,
      );
      transferred = true;
      res.status(202).json(job);
    } catch (error) {
      if (error instanceof ImportBusyError)
        return void res
          .status(429)
          .json({ error: '別の資料を取り込み中です。完了後に追加してください。' });
      throw error;
    } finally {
      if (!transferred)
        await Promise.allSettled(
          ((req.files as Express.Multer.File[] | undefined) ?? []).map(removeUpload),
        );
    }
  });
  app.post('/api/materials', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return void res.status(400).json({ error: 'ファイルを選んでください。' });
      let raw: unknown;
      if (/\.json$/i.test(req.file.originalname))
        raw = JSON.parse(req.file.buffer.toString('utf8').replace(/^\uFEFF/, ''));
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
  app.post(
    '/api/materials/folder',
    folderUpload(join(dataDir, 'uploads')),
    async (req, res, next) => {
      let imported: { id: string; files: number; chapters: number };
      try {
        const body = z
          .object({
            title: z.string().trim().min(1).max(160),
            paths: z
              .string()
              .transform((value) =>
                z
                  .array(z.string().min(1).max(512))
                  .min(1)
                  .max(MATERIAL_LIMITS.folderFiles)
                  .parse(JSON.parse(value)),
              ),
          })
          .strict()
          .parse(req.body);
        const files = req.files as Express.Multer.File[] | undefined;
        if (!files?.length || files.length !== body.paths.length)
          throw new FolderMaterialError('選択した資料の一覧を確認してください。');
        const course = await folderMaterialCourse(
          body.title,
          files.map((file, i) => ({
            path: body.paths[i]!,
            size: file.size,
            read: () => readFile(file.path),
          })),
        );
        persistCourse(coursesDir, course);
        courses.push(course);
        imported = { id: course.id, files: files.length, chapters: course.chapters.length };
      } finally {
        await Promise.allSettled(
          ((req.files as Express.Multer.File[] | undefined) ?? []).map(removeUpload),
        );
      }
      res.status(201).json(imported);
    },
  );
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
        questions: c.questions.map((original) => {
          const { modelAnswer: _, rubric: __, acceptedAnswers: ___, ...q } = original;
          return { ...q, resolvedContext: resolveQuestionContext(c, original) };
        }),
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
  app.get('/api/generation/plan/:courseId', (req, res) => {
    const course = courses.find((c) => c.id === req.params.courseId);
    if (!course) return void res.status(404).json({ error: '教材が見つかりません。' });
    const units = sourceUnits(course);
    res.json({
      totalUnits: units.length,
      totalCharacters: units.reduce((s, u) => s + u.text.length, 0),
      units: units.map(({ text, ...u }) => ({ ...u, characters: text.length })),
      jobs: store
        .generations<GenerationJob>()
        .filter((j) => j.sourceCourseId === course.id)
        .map(({ selected, ...j }) => ({ ...j, plannedCalls: selected.length })),
    });
  });
  app.get('/api/generation/:id', (req, res) => {
    const job = store.generation<GenerationJob>(req.params.id);
    if (!job) return void res.status(404).json({ error: '生成履歴が見つかりません。' });
    const { selected, ...summary } = job;
    res.json({
      ...summary,
      plannedCalls: selected.length,
      draft: job.completed.length ? generationDraft(job) : null,
    });
  });
  app.post('/api/generation', (req, res) => {
    const body = z
      .object({
        courseId: z.string(),
        maxCalls: z.number().int().min(1).max(20),
        startUnit: z.number().int().nonnegative().default(0),
        model: z
          .string()
          .regex(/^[a-zA-Z0-9._:/-]{1,100}$/)
          .optional(),
      })
      .strict()
      .parse(req.body);
    if (busy) return void res.status(429).json({ error: '別のAI処理が進行中です。' });
    if (!config.apiKey)
      return void res.status(503).json({ error: '先にAIの設定からキーを入力してください。' });
    const course = courses.find((c) => c.id === body.courseId);
    if (!course) return void res.status(404).json({ error: '教材が見つかりません。' });
    if (body.startUnit >= sourceUnits(course).length)
      return void res.status(400).json({ error: '生成する開始区間を確認してください。' });
    const job = newGeneration(course, body.maxCalls, body.model ?? config.model, body.startUnit);
    store.saveGeneration(job);
    busy = true;
    res.status(202).json({ id: job.id });
    void (async () => {
      try {
        for (const unit of job.selected) {
          if (job.cancelRequested) {
            job.state = 'cancelled';
            break;
          }
          if (!config.apiKey) throw new Error('missing_key');
          const usageId = store.startUsage(job.model, {
            courseId: course.id,
            purpose: 'authoring',
          });
          try {
            job.completed.push(
              await authorUnit(unit, { ...config, model: job.model }, (e) =>
                store.updateUsage(usageId, e),
              ),
            );
            store.updateUsage(usageId, {}, 'completed');
            store.saveGeneration(job);
          } catch (error) {
            store.updateUsage(
              usageId,
              {
                failureCode: error instanceof GradingResponseError ? error.code : 'authoring_error',
              },
              'failed',
            );
            throw error;
          }
        }
        if (job.state === 'running') job.state = job.cancelRequested ? 'cancelled' : 'completed';
      } catch {
        job.state = 'failed';
        job.error =
          '教材生成を完了できませんでした。利用枠・接続・AIの出力形式を確認してください。成功した区間は残しています。自動再送はしていません。';
      } finally {
        busy = false;
        store.saveGeneration(job);
      }
    })();
    activeGeneration = job;
  });
  let activeGeneration: GenerationJob | undefined;
  app.post('/api/generation/:id/cancel', (req, res) => {
    if (activeGeneration?.id === req.params.id && activeGeneration.state === 'running') {
      activeGeneration.cancelRequested = true;
      store.saveGeneration(activeGeneration);
    }
    res.json({ saved: true });
  });
  app.post('/api/generation/:id/register', (req, res) => {
    const job = store.generation<GenerationJob>(req.params.id);
    if (!job) return void res.status(404).json({ error: '生成履歴が見つかりません。' });
    if (job.registeredCourseId) return void res.json({ id: job.registeredCourseId });
    if (job.state === 'running' || !job.completed.length)
      return void res.status(409).json({ error: '生成済みの教材を確認してから登録してください。' });
    const draft = generationDraft(job);
    // Idempotent even when the process stopped between writing the course and saving the job.
    if (!courses.some((c) => c.id === draft.id)) courses.push(persistCourse(coursesDir, draft));
    job.registeredCourseId = draft.id;
    store.saveGeneration(job);
    res.status(201).json({ id: draft.id });
  });
  app.get('/api/tutor/:courseId/:questionId', (req, res) =>
    res.json(store.tutors(req.params.courseId, req.params.questionId)),
  );
  app.post('/api/tutor', (req, res) => {
    const body = z
      .object({
        courseId: z.string(),
        questionId: z.string(),
        answer: z.string().max(12000).default(''),
        attemptId: z.string().optional(),
        parentSessionId: z.string().optional(),
      })
      .strict()
      .parse(req.body);
    const { course, question } = lookup(body.courseId, body.questionId);
    const parent = body.parentSessionId ? store.tutor(body.parentSessionId) : undefined;
    if (
      body.parentSessionId &&
      (!parent || parent.courseId !== course.id || parent.questionId !== question.id)
    )
      return void res.status(400).json({ error: '分岐元の会話を確認できません。' });
    const attemptId = parent?.attemptId ?? body.attemptId;
    const attempt = attemptId ? store.attempt(attemptId) : undefined;
    if (
      attemptId &&
      (!attempt || attempt.courseId !== course.id || attempt.questionId !== question.id)
    )
      return void res.status(400).json({ error: '相談元の採点結果を確認できません。' });
    const now = new Date().toISOString();
    const session: TutorSession = {
      id: randomUUID(),
      courseId: course.id,
      questionId: question.id,
      questionTitle: question.title,
      createdAt: now,
      updatedAt: now,
      answerSnapshot: parent?.answerSnapshot ?? attempt?.answer ?? body.answer,
      messages: parent ? structuredClone(parent.messages) : [],
      ...(parent ? { parentSessionId: parent.id } : {}),
      ...(attempt ? { attemptId: attempt.id, gradeSnapshot: attempt.grade } : {}),
    };
    store.saveTutor(session);
    res.status(201).json(session);
  });
  app.post('/api/tutor/:id/message', async (req, res) => {
    const body = z
      .object({
        text: z.string().trim().min(1).max(4000),
        model: z
          .string()
          .regex(/^[a-zA-Z0-9._:/-]{1,100}$/)
          .optional(),
      })
      .strict()
      .parse(req.body);
    const session = store.tutor(req.params.id);
    if (!session) return void res.status(404).json({ error: '相談の会話が見つかりません。' });
    if (busy)
      return void res
        .status(429)
        .json({ error: '別のAI処理が進行中です。完了後に送信してください。' });
    if (!config.apiKey)
      return void res.status(503).json({ error: 'AIの設定からキーを入力してください。' });
    const { course, question: q } = lookup(session.courseId, session.questionId);
    session.messages.push(newTutorMessage('user', body.text));
    session.updatedAt = new Date().toISOString();
    store.saveTutor(session);
    busy = true;
    const usageId = store.startUsage(body.model ?? config.model, {
      courseId: course.id,
      questionId: q.id,
      purpose: 'tutoring',
    });
    try {
      const reply = await tutorReply(
        course,
        q,
        session,
        { ...config, model: body.model ?? config.model },
        (e) => store.updateUsage(usageId, e),
      );
      session.messages.push(newTutorMessage('assistant', reply));
      store.updateUsage(usageId, {}, 'completed');
    } catch (error) {
      store.updateUsage(
        usageId,
        { failureCode: error instanceof GradingResponseError ? error.code : 'tutor_error' },
        'failed',
      );
      session.messages.push(
        newTutorMessage(
          'assistant',
          'AIとの相談を完了できませんでした。利用枠や接続設定を確認してください。自動再送はしていません。',
          true,
        ),
      );
    } finally {
      busy = false;
      session.updatedAt = new Date().toISOString();
      store.saveTutor(session);
    }
    res.json(session);
  });
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
      if (body.mode === 'ai' && resolveQuestionContext(course, q).warnings.length)
        return void res.status(422).json({
          error:
            'この問題の前提となる参照先を確認できません。教材の前提を補ってから採点してください。回答の誤りとしては扱いません。',
          code: 'missing_context',
        });
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
        const usageId = store.startUsage(body.model ?? config.model, {
          courseId: course.id,
          questionId: q.id,
        });
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
          const failureCode =
            error instanceof GradingResponseError
              ? error.code
              : APICallError.isInstance(error)
                ? `http_${error.statusCode ?? 'unknown'}`
                : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
                  ? 'timeout'
                  : 'connection_error';
          store.updateUsage(usageId, { failureCode }, 'failed');
          if (error instanceof GradingResponseError)
            return void res.status(502).json({
              error: `${error.message} 点数は記録していません。回答は保存されています。自動再送はしていません。`,
              code: error.code,
            });
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
  app.get('/material-limits.js', (_req, res) => res.sendFile(resolve('dist/material-limits.js')));
  app.get('/app.js', (_req, res) => res.sendFile(resolve('dist/client/app.js')));
  app.use(express.static(resolve('public')));
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const known = [
        'このPDFから本文を取り出せませんでした。画像だけのPDFは、文字起こししたテキストを追加してください。',
        'PDFは1,000ページ以内に分けてください。',
        '本文が長すぎます。ファイルを分けてください。',
        'PDF・Markdown・テキストを選んでください。',
        '本文は10〜5,000,000文字で追加してください。',
        '問題が見つかりません。',
      ];
      res.status(400).json({
        error:
          error instanceof FolderMaterialError || error instanceof MaterialReadError
            ? error.message
            : error instanceof Error && error.message === 'folder_total_size'
              ? '資料の合計は500MB以下にしてください。まだ教材は追加していません。'
              : error instanceof z.ZodError
                ? '入力内容や教材パッケージの形式を確認してください。'
                : error instanceof multer.MulterError
                  ? '資料は1ファイル50MB以下で選んでください。フォルダーは最大200ファイル・合計500MBです。'
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
  const dataLock = acquireDataLock(resolve('data'), 'server');
  let running: ReturnType<typeof createApp>;
  try {
    running = createApp();
  } catch (error) {
    dataLock.release();
    throw error;
  }
  const { app, store } = running;
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
  server.on('error', () => {
    store.close();
    dataLock.release();
    console.error(
      'アプリを起動できませんでした。既に起動していないか、ポート設定を確認してください。',
    );
    process.exitCode = 1;
  });
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      store.close();
      dataLock.release();
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => dataLock.release());
}
