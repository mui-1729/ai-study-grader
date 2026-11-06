import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { courseSchema } from '../src/schema.js';
import { createApp } from '../src/server.js';
import { memoryCredentialVault } from '../src/credentials.js';
import {
  sourceUnits,
  authoredUnitSchema,
  newGeneration,
  generationDraft,
  type GenerationJob,
} from '../src/authoring.js';
import type { TutorSession } from '../src/tutor.js';
const sample = courseSchema.parse(JSON.parse(readFileSync('examples/sample-course.json', 'utf8')));
const output = {
  title: '偶数の和',
  content: '偶数は2の倍数です。例：2+4=6。',
  questions: [
    {
      title: '偶数の和を説明する',
      prompt: 'a,bを整数とする。2a+2bが偶数である理由を説明せよ。',
      modelAnswer: '2(a+b)は2の倍数である。',
      rubric: '正しい別解も可。',
      maxPoints: 5,
      criteria: [{ description: '2の倍数と説明', maxPoints: 5 }],
    },
  ],
  notes: ['図の内容は本文から確認してください。'],
};
test('生成範囲は元資料を省略・重複せず、配点と登録用教材を検証する', () => {
  const content = 'あ'.repeat(4500) + '\n\n' + '😀'.repeat(5000);
  const course = { ...sample, chapters: [{ ...sample.chapters[0]!, content }] };
  const units = sourceUnits(course);
  assert.equal(units.map((u) => u.text).join(''), content);
  assert.ok(units.every((u) => u.text.length <= 6000));
  assert.ok(units.every((u) => !/^[\uDC00-\uDFFF]/.test(u.text)));
  assert.throws(() =>
    authoredUnitSchema.parse({ ...output, questions: [{ ...output.questions[0], maxPoints: 4 }] }),
  );
  const job = newGeneration(course, 1, 'dummy-model');
  job.completed.push(output);
  job.state = 'completed';
  const draft = generationDraft(job);
  assert.ok(draft.description.includes(`1/${units.length}`));
  assert.equal(draft.questions[0]!.criteria[0]!.id, 'criterion-1');
  assert.ok(draft.chapters[0]!.content.includes('要確認'));
  assert.equal(course.chapters[0]!.content, content);
  const later = newGeneration(course, 1, 'dummy-model', 1);
  assert.deepEqual(later.selected, [units[1]]);
  assert.equal(later.startUnit, 1);
  const boundary = {
    ...course,
    chapters: [{ ...course.chapters[0]!, content: 'a'.repeat(6000) + '\n\nend' }],
  };
  assert.ok(sourceUnits(boundary).every((u) => u.text.length <= 6000));
});

test('相談の開始・分岐・送信と、資料生成→部分保存→確認登録を模擬APIで通す', async () => {
  mkdirSync('work/tests', { recursive: true });
  const dir = mkdtempSync(resolve('work/tests/learning-'));
  mkdirSync(join(dir, 'courses'));
  const course = courseSchema.parse({
    ...sample,
    chapters: [{ ...sample.chapters[0]!, content: '偶数の元資料。'.repeat(1800) }],
  });
  const original = JSON.stringify(course);
  writeFileSync(join(dir, 'courses', `${course.id}.json`), original);
  // Explicitly disable inherited credentials in this isolated test data.
  writeFileSync(
    join(dir, 'ai-config.json'),
    JSON.stringify({ model: 'gpt-6-luna', keyDisabled: true }),
  );
  const vault = memoryCredentialVault();
  const { app, store } = createApp(dir, { credentialVault: vault });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api`;
  const nativeFetch = globalThis.fetch;
  let externalCalls = 0,
    mode: 'tutor' | 'generate' | 'fail' | 'partial' | 'cancel' = 'tutor';
  let release: (() => void) | undefined;
  let generatedCalls = 0;
  let httpFailure = false;
  const captured: { system: string; data: any }[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(base)) return nativeFetch(input, init);
    assert.equal(String(input), 'https://api.openai.iniad.org/api/v1/chat/completions');
    externalCalls++;
    if (httpFailure) return new Response('mock unavailable', { status: 503 });
    const body = JSON.parse(String(init?.body));
    captured.push({ system: body.messages[0].content, data: JSON.parse(body.messages[1].content) });
    let text = '小さい例から考えましょう。2と4は偶数です。';
    if (mode !== 'tutor') {
      generatedCalls++;
      if (mode === 'cancel')
        await new Promise<void>((r) => {
          release = r;
        });
      text =
        mode === 'fail' || (mode === 'partial' && generatedCalls > 1)
          ? '{}'
          : JSON.stringify(output);
    }
    return new Response(
      JSON.stringify({
        id: 'mock',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const status = await (await fetch(`${base}/status`)).json();
    const request = async (path: string, body?: unknown, method = 'POST') => {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : method,
        headers: { 'x-study-token': status.token, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const open = { courseId: course.id, questionId: course.questions[1]!.id, answer: '' };
    let session: TutorSession = (await request('/tutor', open)).body;
    assert.equal(externalCalls, 0);
    assert.equal(session.messages.length, 0);
    assert.equal(
      (await request(`/tutor/${session.id}/message`, { text: 'わからない' })).status,
      503,
    );
    await request('/settings', { apiKey: 'dummy-learning-key', model: 'gpt-6-luna' }, 'PUT');
    assert.ok(!readFileSync(join(dir, 'ai-config.json'), 'utf8').includes('dummy-learning-key'));
    session = (
      await request(`/tutor/${session.id}/message`, { text: 'わからないので例から教えて' })
    ).body;
    assert.equal(session.messages.length, 2);
    assert.equal(store.history().length, 0);
    assert.equal(store.usages()[0]!.purpose, 'tutoring');
    assert.equal(captured[0]!.data.learningContext.question, course.questions[1]!.prompt);
    const fork = (await request('/tutor', { ...open, parentSessionId: session.id }))
      .body as TutorSession;
    assert.notEqual(fork.id, session.id);
    assert.deepEqual(fork.messages, session.messages);
    await request(`/tutor/${fork.id}/message`, { text: '別の例も' });
    assert.equal(
      (await request(`/tutor/${course.id}/${open.questionId}`)).body.find(
        (s: TutorSession) => s.id === session.id,
      ).messages.length,
      2,
    );
    const callsBeforeFailure = externalCalls;
    httpFailure = true;
    const failedSession = (await request(`/tutor/${fork.id}/message`, { text: '接続失敗の確認' }))
      .body as TutorSession;
    httpFailure = false;
    assert.equal(externalCalls, callsBeforeFailure + 1);
    assert.equal(failedSession.messages.at(-1)!.failed, true);
    assert.equal(store.history().length, 0);
    const plan = (await request(`/generation/plan/${course.id}`)).body;
    assert.ok(plan.totalUnits >= 2);
    assert.equal(plan.totalCharacters, course.chapters[0]!.content.length);
    const waitJob = async (id: string) => {
      for (let i = 0; i < 100; i++) {
        const job = (await request(`/generation/${id}`)).body;
        if (job.state !== 'running') return job;
        await pause(10);
      }
      throw new Error('mock job did not complete');
    };
    mode = 'partial';
    generatedCalls = 0;
    const started = await request('/generation', { courseId: course.id, maxCalls: 2 });
    assert.equal(started.status, 202);
    const job = await waitJob(started.body.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.completed.length, 1);
    assert.ok(job.draft);
    assert.equal(generatedCalls, 2);
    assert.equal(store.usages().filter((u) => u.purpose === 'authoring').length, 2);
    assert.equal(readFileSync(join(dir, 'courses', `${course.id}.json`), 'utf8'), original);
    const registered = await request(`/generation/${job.id}/register`, {});
    const again = await request(`/generation/${job.id}/register`, {});
    assert.equal(registered.body.id, again.body.id);
    assert.equal((await request('/courses')).body.length, 2);
    mode = 'cancel';
    generatedCalls = 0;
    const cancelling = await request('/generation', { courseId: course.id, maxCalls: 2 });
    for (let i = 0; i < 100 && !release; i++) await pause(10);
    assert.ok(release);
    assert.equal((await request('/generation', { courseId: course.id, maxCalls: 1 })).status, 429);
    await request(`/generation/${cancelling.body.id}/cancel`, {});
    release();
    const cancelled = await waitJob(cancelling.body.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(generatedCalls, 1);
    assert.equal(cancelled.completed.length, 1);
    await request('/settings/key', {}, 'DELETE');
    assert.equal(vault.read(), '');
    assert.equal((await request('/status')).body.aiConfigured, false);
    assert.ok(!JSON.stringify((await request('/status')).body).includes('dummy-learning-key'));
    assert.equal((await request('/generation', { courseId: course.id, maxCalls: 1 })).status, 503);
  } finally {
    release?.();
    globalThis.fetch = nativeFetch;
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test('再起動で中断ジョブを自動再送しない', () => {
  mkdirSync('work/tests', { recursive: true });
  const dir = mkdtempSync(resolve('work/tests/interrupted-'));
  writeFileSync(join(dir, 'ai-config.json'), JSON.stringify({ model: 'dummy', keyDisabled: true }));
  let running = createApp(dir, { credentialVault: memoryCredentialVault() });
  const job = newGeneration(sample, 1, 'dummy');
  running.store.saveGeneration(job);
  running.store.close();
  running = createApp(dir, { credentialVault: memoryCredentialVault() });
  assert.equal(running.store.generation<GenerationJob>(job.id)!.state, 'interrupted');
  running.store.close();
});
