import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { imagePDF, textPDF } from './helpers/pdf.js';
import { extractMaterial } from '../src/materials.js';
import {
  MaterialReadError,
  createLocalOCR,
  normalizeOCRText,
  type OCRFactory,
} from '../src/ocr.js';
import { createApp } from '../src/server.js';
import { memoryCredentialVault } from '../src/credentials.js';
import type { MaterialImport } from '../src/material-imports.js';
const fixture = readFileSync('tests/fixtures/ocr-japanese.png');
test(
  '実OCRプロセスも停止でき、日本語の空白整形は英語と数式を保つ',
  { timeout: 60000 },
  async () => {
    assert.equal(
      normalizeOCRText('日 本 語\nOCR TEST 123\nx + y = 2'),
      '日本語\nOCR TEST 123\nx + y = 2',
    );
    const controller = new AbortController();
    const recognizer = await createLocalOCR(() => {}, controller.signal);
    const pending = recognizer.recognize(fixture);
    controller.abort();
    await assert.rejects(pending);
    await recognizer.close();
  },
);

test('画像だけのPDFをローカルの日本語・英語OCRで実際に読み取る', { timeout: 60000 }, async () => {
  const buffer = await imagePDF([fixture]);
  await assert.rejects(
    () => extractMaterial({ originalname: 'scan.pdf', buffer }),
    MaterialReadError,
  );
  let pages = 0;
  const text = await extractMaterial(
    { originalname: 'scan.pdf', buffer },
    { ocrMode: 'auto', onOCR: () => pages++ },
  );
  assert.equal(pages, 1);
  assert.match(text.replace(/\s/g, ''), /OCR_?TEST123/);
  assert.match(text, /日本語/);
  assert.match(text, /OCRで抽出/);
});

test('文字PDFは通常抽出し、全ページ指定とページ進捗・後始末を検証する', async () => {
  let workers = 0,
    recognized = 0,
    closed = 0;
  const factory: OCRFactory = async (report) => {
    workers++;
    return {
      recognize: async () => {
        recognized++;
        report(0.5);
        return { text: '画像から読み取ったテスト専用の本文です。', confidence: 40 };
      },
      close: async () => {
        closed++;
      },
    };
  };
  const text = await extractMaterial(
    { originalname: 'native.pdf', buffer: textPDF() },
    { ocrMode: 'auto', ocrFactory: factory },
  );
  assert.match(text, /synthetic material/);
  assert.equal(workers, 0);
  await extractMaterial(
    { originalname: 'native.pdf', buffer: textPDF() },
    { ocrMode: 'always', ocrFactory: factory },
  );
  assert.equal(workers, 1);
  const progress: number[] = [];
  const scan = await extractMaterial(
    { originalname: 'two.pdf', buffer: await imagePDF([fixture, fixture]) },
    {
      ocrMode: 'auto',
      ocrFactory: factory,
      onProgress: (value) => {
        if (value.phase === 'ocr' && value.progress === 0.5) progress.push(value.page);
      },
    },
  );
  assert.deepEqual(progress, [1, 2]);
  assert.equal(recognized, 3);
  assert.equal(closed, 2);
  assert.match(scan, /要確認/);
});

test('OCRの背景処理はキーなしで進み、進捗・停止・本文登録を返しAPI使用量を増やさない', async () => {
  mkdirSync('work/tests', { recursive: true });
  const directory = mkdtempSync(resolve('work/tests/ocr-import-'));
  writeFileSync(
    join(directory, 'ai-config.json'),
    JSON.stringify({ model: 'dummy', keyDisabled: true }),
  );
  let wait = true,
    started = false,
    closed = 0;
  const factory: OCRFactory = async (_report, signal) => ({
    recognize: async () => {
      started = true;
      if (wait)
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
        );
      return { text: 'OCR TEST 日本語の画像から読み取った本文です。', confidence: 35 };
    },
    close: async () => {
      closed++;
    },
  });
  const { app, store } = createApp(directory, {
    credentialVault: memoryCredentialVault(),
    ocrFactory: factory,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api`;
  const buffer = await imagePDF([fixture]);
  try {
    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.aiConfigured, false);
    const upload = async () => {
      const form = new FormData();
      form.append('title', 'スキャン資料');
      form.append('paths', JSON.stringify(['資料/scan.pdf']));
      form.append('ocrMode', 'auto');
      form.append('files', new Blob([buffer]), 'scan.pdf');
      const response = await fetch(`${base}/material-import`, {
        method: 'POST',
        headers: { 'x-study-token': status.token },
        body: form,
      });
      return { status: response.status, job: (await response.json()) as MaterialImport };
    };
    const poll = async (id: string) =>
      (await (await fetch(`${base}/material-import/${id}`)).json()) as MaterialImport;
    const finish = async (id: string) => {
      for (let i = 0; i < 300; i++) {
        const job = await poll(id);
        if (!['running', 'cancelling'].includes(job.state)) return job;
        await pause(10);
      }
      throw new Error('test import timed out');
    };
    const pending = await upload();
    assert.equal(pending.status, 202);
    for (let i = 0; i < 300 && !started; i++) await pause(10);
    assert.ok(started);
    const progress = await poll(pending.job.id);
    assert.equal(progress.page, 1);
    assert.equal(progress.pages, 1);
    assert.equal(progress.phase, 'ocr');
    assert.equal((await upload()).status, 429);
    await fetch(`${base}/material-import/${pending.job.id}/cancel`, {
      method: 'POST',
      headers: { 'x-study-token': status.token },
    });
    assert.equal((await finish(pending.job.id)).state, 'cancelled');
    assert.equal((await (await fetch(`${base}/courses`)).json()).length, 0);
    for (let i = 0; i < 100 && readdirSync(join(directory, 'uploads')).length; i++) await pause(10);
    wait = false;
    const next = await upload();
    assert.equal(next.status, 202);
    const completed = await finish(next.job.id);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.ocrPages, 1);
    assert.equal(completed.warnings.length, 1);
    const courses = await (await fetch(`${base}/courses`)).json();
    assert.equal(courses.length, 1);
    assert.match(courses[0].chapters[0].content, /日本語/);
    assert.equal(closed, 2);
    assert.equal(store.usages().length, 0);
    for (let i = 0; i < 100 && readdirSync(join(directory, 'uploads')).length; i++) await pause(10);
    assert.deepEqual(readdirSync(join(directory, 'uploads')), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
