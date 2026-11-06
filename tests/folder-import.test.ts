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
import { MATERIAL_LIMITS } from '../src/material-limits.js';
import { textPDF } from './helpers/pdf.js';
import { setTimeout as pause } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';

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
      { path: 'a.txt', buffer: Buffer.from('a'.repeat(MATERIAL_LIMITS.textCharacters + 1)) },
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
    const paths = Array.from({ length: 200 }, (_, i) => `資料/第${i + 1}回.txt`);
    const imported = await send(paths);
    assert.equal(imported.status, 201);
    assert.equal(imported.body.files, 200);
    const courses = await (await fetch(`${base}/courses`)).json();
    assert.equal(courses.length, 1);
    assert.equal(courses[0].chapters.length, 200);
    const plan = await (await fetch(`${base}/generation/plan/${imported.body.id}`)).json();
    assert.equal(plan.totalUnits, 200);
    assert.equal(store.usages().length, 0);
    assert.equal((await send([...paths, '資料/第201回.txt'])).status, 400);
    assert.equal(readdirSync(join(dir, 'courses')).length, 1);
    assert.deepEqual(readdirSync(join(dir, 'uploads')), []);
    const form = new FormData();
    form.append('title', '旧上限を超えるPDF');
    form.append('paths', JSON.stringify(['資料/大きいPDF.pdf']));
    form.append('files', new Blob([textPDF(1, 16 * 1024 * 1024)]), 'large.pdf');
    const large = await fetch(`${base}/materials/folder`, {
      method: 'POST',
      body: form,
      headers: { 'x-study-token': token },
    });
    assert.equal(large.status, 201);
    assert.deepEqual(readdirSync(join(dir, 'uploads')), []);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test('合計バイト上限はContent-Lengthのない送信にも適用する', async () => {
  mkdirSync('work/tests', { recursive: true });
  const dir = mkdtempSync(resolve('work/tests/upload-limit-'));
  const app = express();
  app.post('/upload', folderUpload(dir, 100), (_req, res) => res.json({ ok: true }));
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
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('旧本文・ページ上限を超える資料を扱い、新しい容量上限は読み取り前に検証する', async () => {
  const long = await folderMaterialCourse('長文資料', [
    { path: '資料/長文.txt', buffer: Buffer.from('a'.repeat(600000)) },
  ]);
  assert.equal(long.chapters.map((c) => c.content).join('').length, 600000);
  const pages = await folderMaterialCourse('長いPDF', [
    { path: '資料/151ページ.pdf', buffer: textPDF(151) },
  ]);
  assert.ok(
    pages.chapters
      .map((c) => c.content)
      .join('')
      .includes('151ページ'),
  );
  const full = await folderMaterialCourse(
    '最大本文',
    Array.from({ length: 200 }, (_, i) => ({
      path: `資料/${i}.txt`,
      buffer: Buffer.from('a'.repeat(25000)),
    })),
  );
  assert.equal(full.chapters.length, 400);
  assert.equal(
    full.chapters.reduce((sum, c) => sum + c.content.length, 0),
    MATERIAL_LIMITS.textCharacters,
  );
  let reads = 0;
  const read = async () => {
    reads++;
    return Buffer.from('test material');
  };
  await assert.rejects(() =>
    folderMaterialCourse('単体超過', [
      { path: 'a.txt', size: MATERIAL_LIMITS.fileBytes + 1, read },
    ]),
  );
  await assert.rejects(() =>
    folderMaterialCourse(
      '合計超過',
      Array.from({ length: 11 }, (_, i) => ({
        path: `${i}.txt`,
        size: MATERIAL_LIMITS.fileBytes,
        read,
      })),
    ),
  );
  assert.equal(reads, 0);
});

test('取り込み途中に接続が切れても一時ファイルを残さない', async () => {
  mkdirSync('work/tests', { recursive: true });
  const dir = mkdtempSync(resolve('work/tests/upload-abort-'));
  const app = express();
  app.post('/upload', folderUpload(dir), (_req, res) => res.json({ ok: true }));
  app.use(
    (_error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status(400).end(),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = httpRequest(`http://127.0.0.1:${address.port}/upload`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=test-abort' },
  });
  request.on('error', () => {});
  try {
    request.write(
      '--test-abort\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\n\r\ncompleted file\r\n--test-abort\r\nContent-Disposition: form-data; name="files"; filename="b.txt"\r\n\r\npartial file',
    );
    for (let i = 0; i < 100 && readdirSync(dir).length < 2; i++) await pause(10);
    assert.equal(readdirSync(dir).length, 2);
    request.destroy();
    for (let i = 0; i < 100 && readdirSync(dir).length; i++) await pause(10);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    request.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
