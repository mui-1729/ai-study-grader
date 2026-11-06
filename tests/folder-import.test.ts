import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { folderMaterialCourse, materialPath } from '../src/materials.js';
import { folderUpload } from '../src/folder-upload.js';
import { createApp } from '../src/server.js';
import { memoryCredentialVault } from '../src/credentials.js';
import { sourceUnits } from '../src/authoring.js';

test('フォルダー資料は数字順・相対パスを保持し、ファイル境界をまたがず生成範囲へ渡す', async () => {
  const course = await folderMaterialCourse('試験用資料', [
    { path: '資料/第10回.txt', buffer: Buffer.from('第10回の説明です。'.repeat(10)) },
    { path: '資料/第2回.txt', buffer: Buffer.from('第2回の説明です。'.repeat(10)) },
    { path: '資料/補足/ノート.md', buffer: Buffer.from('補足ノートの説明です。'.repeat(10)) },
  ]);
  assert.deepEqual(
    course.chapters.map((c) => c.title),
    ['資料/第2回.txt', '資料/第10回.txt', '資料/補足/ノート.md'],
  );
  assert.equal(course.questions.length, 0);
  assert.equal(sourceUnits(course).length, 3);
  const long = await folderMaterialCourse('長文', [
    { path: '資料/長文.md', buffer: Buffer.from('あ'.repeat(25000)) },
  ]);
  assert.equal(long.chapters.length, 2);
  assert.equal(long.chapters.map((c) => c.content).join(''), 'あ'.repeat(25000));
  for (const path of [
    '../a.txt',
    '/a.txt',
    'C:/a.txt',
    '教材/.env.txt',
    '教材/node_modules/a.md',
    '教材/完成.json',
    'a\u0000.txt',
  ])
    assert.throws(() => materialPath(path));
  await assert.rejects(() =>
    folderMaterialCourse('重複', [
      { path: 'a.txt', buffer: Buffer.from('abcdefghij') },
      { path: 'A.txt', buffer: Buffer.from('abcdefghij') },
    ]),
  );
  await assert.rejects(() =>
    folderMaterialCourse('大きすぎる', [
      { path: 'a.txt', buffer: Buffer.from('a'.repeat(500001)) },
    ]),
  );
});

test('複数ファイルを一括登録し、読取失敗・不正パス・件数不正なら何も登録しない', async () => {
  mkdirSync('work/tests', { recursive: true });
  const dir = mkdtempSync(resolve('work/tests/folder-'));
  writeFileSync(join(dir, 'ai-config.json'), JSON.stringify({ model: 'dummy', keyDisabled: true }));
  const { app, store } = createApp(dir, { credentialVault: memoryCredentialVault() });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api`;
  try {
    const { token } = await (await fetch(`${base}/status`)).json();
    const send = async (
      paths: string[],
      texts = paths.map(() => '本文は10文字以上のテスト専用資料です。'),
    ) => {
      const form = new FormData();
      form.append('title', 'フォルダ取り込み');
      form.append('paths', JSON.stringify(paths));
      for (const [i, text] of texts.entries())
        form.append('files', new Blob([text]), `file-${i}.txt`);
      const response = await fetch(`${base}/materials/folder`, {
        method: 'POST',
        body: form,
        headers: { 'x-study-token': token },
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal(
      (await send(['資料/a.txt', '資料/b.txt'], ['本文は十分な長さのテスト資料です。', '短い']))
        .status,
      400,
    );
    assert.equal(readdirSync(join(dir, 'courses')).length, 0);
    assert.equal((await send(['../secret.txt'])).status, 400);
    assert.equal(
      (await send(['資料/a.txt', '資料/b.txt'], ['本文は十分な長さのテスト資料です。'])).status,
      400,
    );
    const paths = Array.from({ length: 50 }, (_, i) => `資料/第${i + 1}回.txt`);
    const imported = await send(paths);
    assert.equal(imported.status, 201);
    assert.equal(imported.body.files, 50);
    const courses = await (await fetch(`${base}/courses`)).json();
    assert.equal(courses.length, 1);
    assert.equal(courses[0].chapters.length, 50);
    const plan = await (await fetch(`${base}/generation/plan/${imported.body.id}`)).json();
    assert.equal(plan.totalUnits, 50);
    assert.equal(store.usages().length, 0);
    assert.equal((await send([...paths, '資料/第51回.txt'])).status, 400);
    assert.equal(readdirSync(join(dir, 'courses')).length, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test('合計バイト上限はContent-Lengthのない送信にも適用する', async () => {
  const app = express();
  app.post('/upload', folderUpload(100), (_req, res) => res.json({ ok: true }));
  app.use(
    (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status(413).json({ error: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const boundary = 'folder-test-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\n\r\n${'a'.repeat(60)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="b.txt"\r\n\r\n${'b'.repeat(60)}\r\n--${boundary}--\r\n`;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/upload`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'folder_total_size');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
