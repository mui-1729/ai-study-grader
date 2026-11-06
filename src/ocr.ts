import { createRequire } from 'node:module';
import { copyFile, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

export type OCRMode = 'auto' | 'always' | 'off';
export type ReadProgress = {
  phase: 'text' | 'rendering' | 'ocr';
  page: number;
  pages: number;
  progress: number;
};
export type OCRRecognizer = {
  recognize(image: Buffer): Promise<{ text: string; confidence: number }>;
  close(): Promise<void>;
};
export type OCRFactory = (
  progress: (value: number) => void,
  signal?: AbortSignal,
) => Promise<OCRRecognizer>;
export type ReadOptions = {
  ocrMode?: OCRMode;
  signal?: AbortSignal;
  onProgress?: (value: ReadProgress) => void;
  onOCR?: (page: number, confidence: number, empty: boolean) => void;
  onFile?: (path: string, index: number, count: number) => void;
  ocrFactory?: OCRFactory;
};
export class MaterialReadError extends Error {}
export function normalizeOCRText(text: string) {
  // Remove OCR word spaces between Japanese characters, preserving English and math.
  return text
    .replace(
      /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、。「」『』（）])[ \t]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、。「」『』（）])/gu,
      '',
    )
    .trim();
}
export const createLocalOCR: OCRFactory = async (progress, signal) => {
  signal?.throwIfAborted();
  const require = createRequire(import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), 'study-studio-ocr-'));
  const models = ['jpn', 'eng'].map((code) => join(directory, `${code}.traineddata.gz`));
  const cleanup = async () => {
    await Promise.allSettled(models.map((path) => unlink(path)));
    await rmdir(directory).catch(() => {});
  };
  try {
    for (const [index, code] of ['jpn', 'eng'].entries()) {
      await copyFile(
        join(
          dirname(require.resolve(`@tesseract.js-data/${code}`)),
          '4.0.0_best_int',
          `${code}.traineddata.gz`,
        ),
        models[index]!,
      );
    }
    signal?.throwIfAborted();
  } catch {
    await cleanup();
    throw new MaterialReadError(
      'OCRの言語データを読み込めませんでした。npm ciを実行してから起動し直してください。',
    );
  }
  // No API keys, env files, or user configuration are inherited by the OCR process.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
    if (process.env[name]) env[name] = process.env[name];
  const child = fork(resolve('src/ocr-worker.cjs'), [directory], {
    execArgv: [],
    env,
    windowsHide: true,
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = new Promise<void>((done) => {
    child.once('exit', () => done());
    child.once('error', () => done());
  });
  let closed = false;
  let closing: Promise<void> | undefined;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((yes, no) => {
    readyResolve = yes;
    readyReject = no;
  });
  let pending:
    | {
        resolve: (value: { text: string; confidence: number }) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const failure = () =>
    new MaterialReadError(
      'OCR処理を完了できませんでした。PDFの解像度や向きを確認して再試行してください。',
    );
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      signal?.removeEventListener('abort', abort);
      readyReject(failure());
      pending?.reject(failure());
      pending = undefined;
      child.kill();
      await exited;
      await cleanup();
    })());
  const abort = () => {
    void close();
  };
  signal?.addEventListener('abort', abort, { once: true });
  child.on('message', (message: any) => {
    if (message.type === 'ready') readyResolve();
    if (message.type === 'progress' && Number.isFinite(message.value))
      progress(Math.max(0, Math.min(1, message.value)));
    if (message.type === 'result' && typeof message.text === 'string') {
      pending?.resolve({ text: message.text, confidence: Number(message.confidence) || 0 });
      pending = undefined;
    }
    if (message.type === 'error') void close();
  });
  child.on('exit', () => {
    readyReject(failure());
    pending?.reject(failure());
    pending = undefined;
  });
  child.on('error', () => {
    void close();
  });
  const startup = setTimeout(() => {
    void close();
  }, 60000);
  try {
    if (signal?.aborted) await close();
    await ready;
    signal?.throwIfAborted();
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(startup);
  }
  return {
    async recognize(image) {
      signal?.throwIfAborted();
      const timer = setTimeout(() => {
        void close();
      }, 120000);
      try {
        return await new Promise<{ text: string; confidence: number }>((yes, no) => {
          pending = { resolve: yes, reject: no };
          if (!child.connected || closed) {
            pending = undefined;
            no(failure());
            return;
          }
          child.send({ type: 'recognize', image }, (error) => {
            if (error) void close();
          });
        });
      } finally {
        clearTimeout(timer);
      }
    },
    close,
  };
};
